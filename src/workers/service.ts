import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { assertNativeWorkflowSupport, type NativeWorkflowSupport } from "../runtime/native-workflow-support.js";
import { WORKSTREAM_DECISION_POLICY } from "../runtime/decision-policy.js";
import { OwnedProcesses } from "../runtime/owned-processes.js";
import { UsageLedger } from "../runtime/usage.js";
import { validateWorkflowInput } from "../runtime/native-workflows.js";
import { buildChildEnv, MODEL_SLOT_NAMES } from "../upstream/auth-env.js";
import type { UpstreamSelection } from "../upstream/providers.js";
import { redactJson, redactValue } from "../security/redact.js";
import type { Logger } from "../logging.js";
import { BridgeError, type Usage } from "../types.js";
import { WorkerStartRejected, type WorkerStartRejectionCode } from "./start-rejection.js";
import { privateDirectory, readWorkers, readWorkerTask, removeWorkerTask, validOperationId, workerId, writeWorker, writeWorkerTask, type WorkerOperation, type WorkerRecord, type WorkerStartInput, type WorkerWorkflow } from "./worker-state.js";
import { prepareSubscription, verifyNativeSubscription, type SubscriptionIdentity } from "./subscription-auth.js";
import type { SubscriptionProfile } from "../runtime/desktop-jobs.js";
import { upstreamError } from "../runtime/upstream-error.js";
import { approvalSummary, MAX_WORKER_APPROVAL_SUMMARY_CHARS } from "./approval.js";
import { inspectWorkerWorkspace, prepareWorkerWorkspace, type WorkerWorkspaceSource } from "./workspace.js";

const exec = promisify(execFile);
const TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);
const EXECUTING = new Set(["starting", "running", "waiting_approval"]);
const DEFAULT_POLICY = "You are a supervised worker delegated by a Factory Workstream. Read this repository's AGENTS.md and CLAUDE.md instructions. Work only in your assigned worktree. Preserve source checkout changes. Follow the user's QA/e2e and Local CI rules. Produce evidence and a reviewable result. Never infer permission to publish, deploy, merge, change production, buy credits or borrow another account. Use the authority explicitly delegated by the controller and request its decision when new permissions are needed. Report checks actually executed and unresolved limitations. The small workflow guideline is advice, not a hard agent or spend cap.";
const BLOCKED_TOOLS = ["EnterWorktree", "ExitWorktree", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "ScheduleTask"];

export interface WorkerApproval {
  id: string;
  toolUseId?: string;
  toolName: string;
  input: unknown;
  requestedAt: string;
}
export interface WorkerView extends WorkerRecord { approvals: WorkerApproval[] }
export interface WorkerLeaseResult {
  state: "completed" | "failed" | "cancelled" | "unknown" | "waiting_host";
  cleanupVerified: boolean;
  usage?: Usage;
  sdkSessionId?: string;
}
export interface WorkerLease {
  release(value: WorkerLeaseResult): Promise<void>;
}
export interface WorkerRunContext {
  worker: Readonly<WorkerRecord>;
  prompt: string;
  options: Options;
  message(value: Record<string, unknown>): void;
}
export interface WorkerExecutionHost {
  start(worker: Readonly<WorkerRecord>, task: string): Promise<WorkerView>;
  status(worker: Readonly<WorkerRecord>): WorkerView;
  cancel(worker: Readonly<WorkerRecord>): Promise<WorkerView>;
  approve(worker: Readonly<WorkerRecord>, input: { id: string; approvalId: string; decision: "allow" | "deny" }): Promise<WorkerView>;
  detach(): Promise<void>;
}
export type WorkerRepositoryPolicy = "allowlist" | "owned-git" | "owned-workspace";
export type WorkerApprovalPolicy = "ask" | "bypass";
export interface APIWorkerServiceOptions {
  stateRoot: string;
  workspaceRoot: string;
  allowedRepositories: string[];
  /** Private operator policy. Request inputs cannot expand repository access. */
  repositoryPolicy?: WorkerRepositoryPolicy;
  /** Explicit local operator policy; subscription workers only. */
  approvalPolicy?: WorkerApprovalPolicy;
  provider: { kind: "anthropic" | "openrouter" } | { kind: "subscription"; profile: SubscriptionProfile; mappingPath?: string; executable?: string };
  maxConcurrent?: number;
  /** Includes queued, running and uncertain workers, before allocating another snapshot. */
  maxPendingWorkers?: number;
  maxBudgetUsd?: number;
  maxMs: number;
  maxTurns?: number;
  sourceEnv?: NodeJS.ProcessEnv;
  policyText?: string;
  workflowText?: Partial<Record<WorkerWorkflow, string>>;
  /** Dependency injection for offline validation; production uses the official SDK. */
  run?: (context: WorkerRunContext) => Promise<void>;
  verifyRuntime?: () => NativeWorkflowSupport;
  cleanup?: (id: string) => Promise<void>;
  acquireLease?: (worker: Readonly<WorkerRecord>, signal: AbortSignal) => Promise<WorkerLease>;
  /** Finish a parked shared record after native cleanup, without reacquiring inference capacity. */
  finalizeLease?: (worker: Readonly<WorkerRecord>, result: WorkerLeaseResult) => Promise<void>;
  /** Independent job executors retain native continuations when the API service restarts. */
  executionHost?: WorkerExecutionHost;
  /** An executor adopts exactly one already prepared worker without replaying start. */
  managedWorkerId?: string;
}
interface PendingApproval { view: WorkerApproval; settle(decision: "allow" | "deny"): void }
interface SubscriptionApprovalBatch {
  generation: number;
  controller: AbortController;
  parked: Promise<void>;
  resuming?: Promise<void>;
  requests: Map<string, { decision?: "allow" | "deny"; finish(allowed: boolean): void }>;
  detach(): void;
}
interface LiveWorker {
  record: WorkerRecord;
  task?: string;
  controller: AbortController;
  approvals: Map<string, PendingApproval>;
  usage: UsageLedger;
  bashCalls: Map<string, string>;
  done?: Promise<void>;
  cancelRequested: boolean;
  sawResult: boolean;
  resultSucceeded: boolean;
  providerEvidence: boolean;
  generation: number;
  children: Map<string, { id: string; state: "running" | "completed" | "failed" | "cancelled" }>;
  lease?: WorkerLease;
  approvalBatch?: SubscriptionApprovalBatch;
  launchPending?: boolean;
  configDir?: string;
}
const silentLogger = { info() {}, warn() {}, error() {} } as unknown as Logger;

/** Factory remains the controller; each worker has its own native session and worktree. */
export class APIWorkerService {
  private readonly root: string;
  private readonly workspaces: string;
  private readonly repositories: Set<string>;
  private readonly repositoryPolicy: WorkerRepositoryPolicy;
  private readonly approvalPolicy: WorkerApprovalPolicy;
  private readonly workers = new Map<string, LiveWorker>();
  private readonly active = new Set<string>();
  private readonly creating = new Set<Promise<unknown>>();
  private readonly operations = new Map<string, { digest: string; promise: Promise<WorkerView> }>();
  private readonly processes = new OwnedProcesses(silentLogger);
  private readonly capacity: number;
  private readonly pendingLimit: number;
  private readonly admissions = new Set<object>();
  private readonly executorPoll?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: APIWorkerServiceOptions) {
    if (options.managedWorkerId) workerId(options.managedWorkerId);
    if (options.managedWorkerId && options.executionHost) throw new Error("An executor cannot delegate its own execution.");
    this.approvalPolicy = options.approvalPolicy ?? "ask";
    if (!["ask", "bypass"].includes(this.approvalPolicy)
        || (this.approvalPolicy === "bypass" && options.provider.kind !== "subscription")) {
      throw new Error("Automatic worker approvals require an explicit subscription policy.");
    }
    this.repositoryPolicy = options.repositoryPolicy === undefined ? "allowlist" : options.repositoryPolicy;
    if (!["allowlist", "owned-git", "owned-workspace"].includes(this.repositoryPolicy)
        || (this.repositoryPolicy !== "allowlist" && options.provider.kind !== "subscription")) {
      throw new Error("Owned workspace access requires an explicit subscription worker policy.");
    }
    this.capacity = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 2) throw new Error("Worker concurrency must be one or two.");
    this.pendingLimit = options.maxPendingWorkers ?? 16;
    if (!Number.isSafeInteger(this.pendingLimit) || this.pendingLimit < 1 || this.pendingLimit > 64) throw new Error("Pending worker admission must be from one to 64.");
    if (options.provider.kind !== "subscription" && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd! <= 0)) throw new Error("An explicit positive estimated budget is required.");
    if (options.provider.kind === "subscription" && options.maxBudgetUsd !== undefined) throw new Error("Subscription workers do not use an API spend budget.");
    if (!Number.isSafeInteger(options.maxMs) || options.maxMs < 1000 || options.maxMs > 2 * 60 * 60_000) throw new Error("Worker deadline must be from one second to two hours.");
    if (!Number.isSafeInteger(options.maxTurns ?? 32) || (options.maxTurns ?? 32) < 1 || (options.maxTurns ?? 32) > 500) throw new Error("Worker turn limit must be an integer from 1 to 500.");
    if (!["anthropic", "openrouter", "subscription"].includes(options.provider.kind)) throw new Error("An explicit authentication route is required.");
    if (!Array.isArray(options.allowedRepositories) || options.allowedRepositories.some(path => typeof path !== "string" || !isAbsolute(path))
        || (this.repositoryPolicy === "allowlist" && !options.allowedRepositories.length)) throw new Error("An explicit repository allowlist is required.");
    this.root = privateDirectory(options.stateRoot);
    this.workspaces = privateDirectory(options.workspaceRoot);
    // An owned-Git policy does not depend on previously registered paths still
    // existing. Each requested repository is verified before it is used.
    this.repositories = new Set(this.repositoryPolicy === "allowlist" ? options.allowedRepositories.map(path => canonicalRepository(path)) : []);
    for (const record of readWorkers(this.root).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
      if (options.managedWorkerId && record.id !== options.managedWorkerId) continue;
      if (!options.executionHost && !options.managedWorkerId && !TERMINAL.has(record.state)) {
        record.state = "unknown";
        record.reason = "service_restarted_without_process_ownership";
        record.cleanupVerified = null;
        record.pendingApprovalCount = 0;
        record.updatedAt = now();
        writeWorker(this.root, record);
      }
      let task = options.executionHost ? readWorkerTask(this.root, record.id) : undefined;
      if (options.executionHost && !options.managedWorkerId && record.state === "starting" && !record.executorLaunchRequested) {
        // The previous frontend stopped during workspace preparation, before
        // any executor launch. Record it like a failed preparation instead of
        // leaving a starting record that the scheduler will never launch.
        record.state = "unknown";
        record.reason = "workspace_preparation_unconfirmed";
        record.failure = { stage: "workspace", code: record.reason, message: "Workspace preparation did not confirm completion. Inspect the recorded workspace before replacing this operation." };
        record.cleanupVerified = null;
        record.pendingApprovalCount = 0;
        record.updatedAt = now();
        writeWorker(this.root, record);
        task = undefined;
      }
      const live = this.live(record, task);
      this.workers.set(record.id, live);
      if (record.state === "unknown" || options.executionHost && !TERMINAL.has(record.state) && (record.executorLaunchRequested || task === undefined)) this.active.add(record.id);
    }
    if (options.executionHost) {
      this.executorPoll = setInterval(() => this.refreshExecutors(), 500);
      this.executorPoll.unref();
      queueMicrotask(() => this.refreshExecutors());
    }
  }

  async executePrepared(id: string, task: string): Promise<void> {
    if (this.options.managedWorkerId !== id) throw new Error("This executor does not own the prepared worker.");
    const live = this.find(id);
    if (live.done || live.record.state !== "queued" || !task.trim() || task.length > 100_000) throw new Error("The prepared worker is not eligible for execution.");
    live.task = task;
    this.active.add(id);
    live.done = this.execute(live).finally(() => { if (live.record.cleanupVerified && live.record.leaseReleased) this.active.delete(id); });
    await live.done;
  }

  start(input: WorkerStartInput): Promise<WorkerView> {
    if (this.closed) return Promise.reject(new WorkerStartRejected("service_unavailable", "Worker service is closed."));
    let operation: WorkerOperation | undefined;
    try { operation = workerOperation(input); }
    catch (error) { return Promise.reject(error); }
    const key = operation ? operation.owner + ":" + operation.id : undefined;
    if (operation) {
      const existing = this.lookup(operation.id, operation.owner);
      if (!("found" in existing)) {
        if (existing.operation?.requestDigest !== operation.requestDigest) return Promise.reject(new WorkerStartRejected("invalid_request", "The worker operation already has different input."));
        return Promise.resolve(existing);
      }
      const creating = this.operations.get(key!);
      if (creating) return creating.digest === operation.requestDigest ? creating.promise
        : Promise.reject(new WorkerStartRejected("invalid_request", "The worker operation already has different input."));
    }
    const unfinished = [...this.workers.keys()].filter(id => !["completed", "failed", "cancelled"].includes(this.status(id).state)).length;
    if (unfinished + this.admissions.size >= this.pendingLimit) return Promise.reject(new WorkerStartRejected("capacity_unavailable"));
    const reservation = {};
    this.admissions.add(reservation);
    const creating = this.startImpl(input, operation, () => this.admissions.delete(reservation));
    if (key) this.operations.set(key, { digest: operation!.requestDigest, promise: creating });
    this.creating.add(creating);
    void creating.finally(() => { this.creating.delete(creating); this.admissions.delete(reservation); if (key) this.operations.delete(key); }).catch(() => undefined);
    return creating;
  }

  lookup(operationId: string, operationOwner: string): WorkerView | { found: false } {
    if (!validOperationId(operationId) || !/^[a-f0-9]{64}$/.test(operationOwner)) throw new Error("A valid worker operation and owner are required.");
    const worker = [...this.workers.values()].find(live => live.record.operation?.id === operationId && live.record.operation.owner === operationOwner);
    return worker ? this.status(worker.record.id) : { found: false };
  }

  private async startImpl(input: WorkerStartInput, operation: WorkerOperation | undefined, releaseAdmission: () => void): Promise<WorkerView> {
    let repository: string, sourceCommit: string, sourceDirty: boolean;
    let workspace: WorkerWorkspaceSource | undefined;
    let rejectionCode: WorkerStartRejectionCode = "invalid_request";
    try {
      if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 100_000) throw new Error("A bounded nonempty worker task is required.");
      if (!["implement", "investigate", "release-prepare"].includes(input.workflow)) throw new Error("Unknown worker workflow.");
      rejectionCode = "repository_rejected";
      if (this.repositoryPolicy === "allowlist") {
        repository = canonicalRepository(input.repository);
        if (!this.repositories.has(repository)) throw new Error("Repository is not in the worker allowlist.");
        rejectionCode = this.options.provider.kind === "subscription" ? "subscription_preflight_failed" : "runtime_unverified";
        await this.prepareRuntime();
        rejectionCode = "repository_rejected";
        const sourceRoot = await git(repository, ["rev-parse", "--show-toplevel"]);
        if (realpathSync(sourceRoot) !== repository) throw new Error("Use the repository root.");
        sourceCommit = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("An exact committed source revision is required.");
        sourceDirty = Boolean(await git(repository, ["status", "--porcelain", "--untracked-files=normal"]));
      } else {
        workspace = await inspectWorkerWorkspace(input.repository, this.repositoryPolicy === "owned-workspace");
        repository = workspace.repository;
        sourceCommit = workspace.sourceCommit ?? "pending-input-snapshot";
        sourceDirty = workspace.sourceDirty;
        rejectionCode = this.options.provider.kind === "subscription" ? "subscription_preflight_failed" : "runtime_unverified";
        await this.prepareRuntime();
        rejectionCode = "repository_rejected";
        canonicalRepository(repository, true);
      }
      if (this.closed) throw new WorkerStartRejected("service_unavailable", "Worker service is closed.");
    } catch (error) {
      if (error instanceof WorkerStartRejected) throw error;
      if (error instanceof BridgeError && error.code === "workflow_runtime_unverified") rejectionCode = "runtime_unverified";
      throw new WorkerStartRejected(rejectionCode, error instanceof Error ? error.message : undefined);
    }
    const id = "worker-" + randomUUID(), worktree = join(this.workspaces, id), branch = "factory-workers/" + id;
    const timestamp = now();
    const record: WorkerRecord = { version: 1, id, state: "starting", repository, worktree, branch, ...(operation ? { operation } : {}),
      sourceCommit, sourceDirty, workflow: input.workflow, requested: { model: "claude-opus-5-5", effort: "medium", ultracode: true },
      createdAt: timestamp, updatedAt: timestamp, observedModels: [], pendingApprovalCount: 0, cleanupVerified: null, checkEvidence: [],
      authentication: this.options.provider.kind, ...(this.options.provider.kind === "subscription" ? { subscriptionProfile: this.options.provider.profile } : {}) };
    const live = this.live(record, input.task);
    // Persist the accepted operation before Git can create any workspace state.
    if (this.options.executionHost) writeWorkerTask(this.root, id, input.task);
    this.save(live);
    this.workers.set(id, live);
    releaseAdmission();
    try {
      if (workspace) {
        const prepared = await prepareWorkerWorkspace(workspace, worktree, branch);
        record.inputCommit = prepared.inputCommit;
        record.workingDirectory = prepared.workingDirectory;
        record.sourceKind = workspace.kind;
        record.inputSnapshot = workspace.snapshot;
        record.sourceCommit = workspace.sourceCommit ?? prepared.inputCommit;
      } else await git(repository, ["worktree", "add", "-b", branch, worktree, sourceCommit]);
      record.worktree = realpathSync(worktree);
      record.state = "queued";
      this.save(live);
    } catch {
      record.state = "unknown"; record.reason = "workspace_preparation_unconfirmed";
      record.failure = { stage: "workspace", code: record.reason, message: "Workspace preparation did not confirm completion. Inspect the recorded workspace before replacing this operation." };
      live.task = undefined;
      this.active.add(id);
      this.save(live);
      return this.view(live);
    }
    if (this.closed) {
      record.state = "cancelled"; record.reason = "service_closed_before_admission";
      record.cleanupVerified = true; record.endedAt = now(); this.save(live);
      if (this.options.executionHost) removeWorkerTask(this.root, id);
    } else if (this.options.executionHost) {
      this.schedule();
      return this.status(id);
    } else this.schedule();
    return this.view(live);
  }

  status(id: string): WorkerView {
    const live = this.find(id);
    if (live.launchPending) return { ...this.view(live), state: "starting" };
    if (this.options.executionHost && (live.record.executorLaunchRequested || live.task === undefined) && !TERMINAL.has(live.record.state)) return this.options.executionHost.status(live.record);
    return this.view(live);
  }
  list(): WorkerView[] { return [...this.workers.values()].map(worker => this.status(worker.record.id)); }

  async cancel(id: string): Promise<WorkerView> {
    const live = this.find(id);
    if (this.options.executionHost) {
      if (live.record.state === "queued" && !live.record.executorLaunchRequested) {
        live.record.state = "cancelled"; live.record.reason = "cancelled_before_executor_launch";
        live.record.cleanupVerified = true; live.record.leaseReleased = true;
        live.record.endedAt = live.record.settledAt = now();
        live.task = undefined; removeWorkerTask(this.root, id); this.save(live);
        return this.view(live);
      }
      const result = await this.options.executionHost.cancel(live.record);
      this.refreshExecutors();
      return result;
    }
    if (TERMINAL.has(live.record.state)) return this.view(live);
    if (live.record.state === "result_ready" || live.record.state === "cleaning") { await live.done; return this.view(live); }
    live.cancelRequested = true;
    live.controller.abort();
    this.denyApprovals(live);
    if (!live.done) {
      live.record.state = "cancelled"; live.record.reason = "cancelled_before_admission";
      live.record.cleanupVerified = true; live.record.endedAt = now(); live.task = undefined; this.save(live);
    }
    await live.done;
    return this.view(live);
  }

  approve(input: { id: string; approvalId: string; decision: "allow" | "deny" }): WorkerView | Promise<WorkerView> {
    if (input.decision !== "allow" && input.decision !== "deny") throw new Error("Approval decision must be allow or deny.");
    const live = this.find(input.id);
    if (this.options.executionHost) return this.options.executionHost.approve(live.record, input);
    const pending = live.approvals.get(input.approvalId);
    if (!pending || live.controller.signal.aborted || TERMINAL.has(live.record.state)) throw new Error("Approval is missing, expired or already resolved.");
    pending.settle(input.decision);
    return this.view(live);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.executorPoll) clearInterval(this.executorPoll);
    await Promise.allSettled([...this.creating]);
    if (this.options.executionHost) { await this.options.executionHost.detach(); await this.processes.close(); return; }
    await Promise.allSettled([...this.workers.values()].filter((live) => !TERMINAL.has(live.record.state)).map((live) => this.cancel(live.record.id)));
    await this.processes.close();
  }
  private live(record: WorkerRecord, task?: string): LiveWorker {
    return { record, task, controller: new AbortController(), approvals: new Map(), usage: new UsageLedger(), bashCalls: new Map(), cancelRequested: false, sawResult: false, resultSucceeded: false, providerEvidence: false, generation: 0, children: new Map() };
  }
  private find(id: string): LiveWorker {
    workerId(id);
    const live = this.workers.get(id);
    if (!live) throw new Error("Unknown worker.");
    return live;
  }
  private save(live: LiveWorker): void { live.record.updatedAt = now(); writeWorker(this.root, live.record); }
  private view(live: LiveWorker): WorkerView {
    return structuredClone({ ...live.record, approvals: [...live.approvals.values()].map((item) => item.view) });
  }
  private schedule(): void {
    if (this.closed) return;
    for (const live of this.workers.values()) {
      if (this.active.size >= this.capacity) break;
      if (live.record.state !== "queued" || live.done) continue;
      if (this.options.executionHost) {
        if (live.record.executorLaunchRequested || live.task === undefined) continue;
        this.active.add(live.record.id);
        live.record.executorLaunchRequested = true;
        this.save(live);
        const task = live.task;
        live.launchPending = true;
        live.done = this.options.executionHost.start(live.record, task).then(() => {
          live.task = undefined;
          removeWorkerTask(this.root, live.record.id);
        }).catch(() => undefined).finally(() => { live.launchPending = false; });
        continue;
      }
      this.active.add(live.record.id);
      live.done = this.execute(live).finally(() => {
        if (live.record.cleanupVerified === true && live.record.leaseReleased !== false) this.active.delete(live.record.id);
        this.schedule();
      });
      void live.done.catch(() => undefined);
    }
  }

  private refreshExecutors(): void {
    if (this.closed || !this.options.executionHost) return;
    for (const id of this.active) {
      const live = this.workers.get(id);
      if (!live) continue;
      if (live.launchPending) continue;
      let current: WorkerView;
      try { current = this.options.executionHost.status(live.record); } catch { continue; }
      if (["completed", "failed", "cancelled"].includes(current.state) && current.cleanupVerified === true && current.leaseReleased !== false) {
        this.active.delete(id);
        removeWorkerTask(this.root, id);
      }
    }
    this.schedule();
  }

  private environment(): Record<string, string> {
    if (this.options.provider.kind === "subscription") throw new Error("Subscription authentication requires the native login preflight.");
    const source = this.options.sourceEnv ?? process.env;
    const routedModel = "anthropic/claude-opus-5.5";
    const selection: UpstreamSelection = { provider: { id: "openrouter", label: "Explicit Factory worker API", baseUrl: "https://openrouter.ai/api", model: routedModel, tokenEnv: "BRIDGE_OPENROUTER_API_KEY", authHeader: "authorization" },
      modelSlots: Object.fromEntries(MODEL_SLOT_NAMES.map((key) => [key, routedModel])) as UpstreamSelection["modelSlots"] };
    const env = this.options.provider.kind === "anthropic" ? buildChildEnv("anthropic-api", source, undefined, { passthrough: "" })
      : buildChildEnv("byok", source, selection, { passthrough: "" });
    for (const name of MODEL_SLOT_NAMES) env[name] = this.options.provider.kind === "openrouter" ? "anthropic/claude-opus-5.5" : "claude-opus-5-5";
    env.CLAUDE_CODE_EFFORT_LEVEL = "medium";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    return env;
  }

  private async prepareRuntime(): Promise<{ env: Record<string, string>; support: NativeWorkflowSupport; identity?: SubscriptionIdentity }> {
    if (this.options.provider.kind === "subscription") {
      const selected = this.options.provider;
      const prepared = await prepareSubscription(selected.profile, { mappingPath: selected.mappingPath, executable: selected.executable, sourceEnv: this.options.sourceEnv });
      return { env: prepared.env, support: (this.options.verifyRuntime ?? assertNativeWorkflowSupport)(), identity: prepared.expectedIdentity };
    }
    return { env: this.environment(), support: (this.options.verifyRuntime ?? assertNativeWorkflowSupport)() };
  }

  private async execute(live: LiveWorker): Promise<void> {
    const { record } = live;
    const generation = ++live.generation;
    let deadline = false;
    let stage: "admission" | "execution" = "admission";
    let admissionRejected = false;
    const timer = setTimeout(() => { deadline = true; live.controller.abort(); this.denyApprovals(live); }, this.options.maxMs);
    timer.unref();
    try {
      record.state = "starting"; record.startedAt = now(); this.save(live);
      live.lease = await this.options.acquireLease?.(record, live.controller.signal);
      if (live.controller.signal.aborted) throw new Error("Worker stopped before execution.");
      const { support, env, identity } = await this.prepareRuntime();
      stage = "execution";
      if (this.options.provider.kind !== "subscription") env.CLAUDE_CONFIG_DIR = privateDirectory(join(this.root, "native-config", record.id));
      live.configDir = env.CLAUDE_CONFIG_DIR;
      const permission: CanUseTool = (tool, input, options) => this.requestPermission(live, tool, input, options.signal, options.toolUseID);
      const options: Options = {
        cwd: record.workingDirectory ?? record.worktree, env, abortController: live.controller, model: "claude-opus-5-5", effort: "medium",
        pathToClaudeCodeExecutable: support.executable, permissionMode: "default", permissionPrompts: "host", canUseTool: permission,
        settingSources: [], strictMcpConfig: true, mcpServers: {},
        settings: { ultracode: true, enableWorkflows: true, workflowSizeGuideline: "small" },
        disallowedTools: BLOCKED_TOOLS,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.policy(record) },
        ...(this.options.provider.kind !== "subscription" ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}), maxTurns: this.options.maxTurns ?? 32,
        sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [record.workingDirectory ?? record.worktree] } },
        hooks: { PreToolUse: [{ hooks: [async (event, toolUseId, context) => {
          if (event.hook_event_name !== "PreToolUse") return {};
          const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
          const active = () => this.workers.get(record.id) === live && live.generation === generation && !live.controller.signal.aborted && !context.signal.aborted && EXECUTING.has(record.state);
          if (!active()) return deny("This worker execution has ended.");
          if (BLOCKED_TOOLS.includes(event.tool_name)) return deny("This worker cannot create another workspace, remote execution or a scheduled task.");
          if (event.tool_name === "Workflow") {
            const input = object(event.tool_input);
            const invalid = input ? validateWorkflowInput(input) : "Workflow input must be an object.";
            if (invalid) return deny(invalid);
            const id = toolUseId ?? event.tool_use_id;
            if (!id) return deny("Workflow execution requires an exact tool-use identity.");
            // Workflow can be classified as safe by the native permission engine.
            // Apply the operator's approval policy here even when the native
            // permission engine would not call canUseTool for this workflow.
            const decision = await this.requestPermission(live, "Workflow", input!, context.signal, id);
            if (!active()) return deny("The worker was cancelled or its execution changed while awaiting approval.");
            if (!decision || decision.behavior !== "allow") return deny(decision?.message ?? "Workflow was not approved.");
            // The approval authorises a launch, not completion. Register the
            // child before returning so a fast root result cannot omit it.
            live.children.set("tool:" + id, { id: "tool:" + id, state: "running" });
            record.children = [...live.children.values()];
            this.save(live);
            return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: decision.updatedInput ?? input } };
          }
          if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.tool_name)) {
            const raw = event.tool_input as Record<string, unknown>;
            const path = raw.file_path ?? raw.notebook_path;
            if (typeof path !== "string" || !insideWorktree(record.workingDirectory ?? record.worktree, path)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Writes must stay in this worker's assigned directory." } };
          }
          return {};
        }] }] },
        spawnClaudeCodeProcess: (spawnOptions) => this.processes.spawn(record.id, spawnOptions) as ReturnType<NonNullable<Options["spawnClaudeCodeProcess"]>>,
      };
      record.state = "running"; this.save(live);
      const context: WorkerRunContext = { worker: structuredClone(record), prompt: live.task!, options, message: (value) => this.message(live, value) };
      const run = async (): Promise<void> => {
        if (this.options.run) await this.options.run(context);
        else if (identity) {
          // The native process authenticates before any user prompt is released.
          let permit!: (allowed: boolean) => void;
          const admitted = new Promise<boolean>(resolve => { permit = resolve; });
          const prompt = (async function* () {
            if (await admitted) yield { type: "user" as const, message: { role: "user" as const, content: context.prompt }, parent_tool_use_id: null, session_id: "" };
          })();
          const session = query({ prompt, options });
          try {
            verifyNativeSubscription(await session.accountInfo(), identity);
            if (live.controller.signal.aborted || this.workers.get(record.id) !== live || live.generation !== generation || TERMINAL.has(record.state)) throw new Error("Worker execution ended before subscription admission.");
            permit(true);
            for await (const value of session) context.message(value as unknown as Record<string, unknown>);
          } finally { permit(false); session.close(); }
        }
        else {
          const session = query({ prompt: context.prompt, options });
          try { for await (const value of session) context.message(value as unknown as Record<string, unknown>); }
          finally { session.close(); }
        }
      };
      let abort!: () => void;
      const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error("Worker execution stopped.")); live.controller.signal.addEventListener("abort", abort, { once: true }); });
      try { await Promise.race([run(), aborted]); }
      finally { live.controller.signal.removeEventListener("abort", abort); }
      const children = [...live.children.values()];
      const childFailed = children.some((child) => child.state === "failed" || child.state === "cancelled");
      const childrenPending = children.some((child) => child.state === "running");
      record.resultState = live.cancelRequested ? "cancelled" : deadline ? "failed" : live.sawResult && live.resultSucceeded && !childFailed && !childrenPending ? "completed" : "failed";
      record.state = record.resultState === "completed" ? "result_ready" : "cleaning";
      if (childFailed) record.reason = "child_task_failed";
      else if (childrenPending) record.reason = "child_completion_unproven";
      if (!live.sawResult && !live.cancelRequested && !deadline) record.reason = "native_result_missing";
      this.save(live);
    } catch (error) {
      // These fixed helper refusals occur while validating the initial request,
      // before a lease is registered. Transport failures remain uncertain.
      admissionRejected = stage === "admission" && error instanceof BridgeError
        && ["desktop_job_workspace", "desktop_job_binding"].includes(error.code);
      record.resultState = live.cancelRequested ? "cancelled" : "failed";
      record.state = "cleaning";
      record.backoff ??= workerBackoff(error);
      // The SDK can throw after delivering an error result (for example
      // error_max_turns); that recorded subtype is the actual cause.
      const resultReason = live.sawResult && !live.resultSucceeded ? record.reason : undefined;
      record.reason = live.cancelRequested ? "cancelled" : deadline ? "deadline_exceeded" : admissionRejected ? (error as BridgeError).code : record.backoff ? "native_" + record.backoff.kind : resultReason ?? "native_execution_failed";
      record.error = "Worker execution did not complete successfully. Review its recorded state and approvals.";
      record.failure = record.reason === resultReason && resultReason
        ? { stage: "execution", code: resultReason, message: "The native worker ended with an error result. Read transcriptPath for its final turns." }
        : safeFailure(error, stage, record.reason);
      this.save(live);
    } finally {
      live.generation++;
      clearTimeout(timer);
      live.task = undefined;
      const approvalBatch = live.approvalBatch;
      approvalBatch?.controller.abort();
      this.denyApprovals(live);
      if (approvalBatch) await Promise.allSettled([approvalBatch.parked, approvalBatch.resuming]);
      record.state = "cleaning";
      record.leaseReleased = false;
      this.save(live);
      try {
        if (this.options.cleanup) await this.options.cleanup(record.id);
        else await this.processes.stop(record.id);
        record.cleanupVerified = true;
      } catch {
        record.cleanupVerified = false; record.state = "unknown"; record.reason = "owned_process_cleanup_unproven";
        record.failure = { stage: "cleanup", code: record.reason, message: "Owned process cleanup did not confirm completion." };
      }
      this.save(live);
      const lease = live.lease;
      live.lease = undefined;
      const leaseResult: WorkerLeaseResult = { state: record.state === "unknown" ? "unknown" : record.resultState ?? "failed", cleanupVerified: record.cleanupVerified === true, usage: live.providerEvidence ? { ...live.usage.providerTotals(), estimated: false } : undefined, sdkSessionId: record.sdkSessionId };
      try {
        if (lease) await lease.release(leaseResult);
        else if (!admissionRejected) await this.options.finalizeLease?.(record, leaseResult);
        record.leaseReleased = true;
        if (record.cleanupVerified === true) {
          record.state = record.resultState ?? "failed";
          record.settledAt = now();
        }
      }
      catch {
        record.state = "unknown"; record.reason = "shared_lease_release_unproven";
        record.failure = { stage: "lease_release", code: record.reason, message: "Shared lease release did not confirm completion." };
      }
      record.endedAt = now();
      this.save(live);
    }
  }
  private policy(record: WorkerRecord): string {
    return (this.options.policyText ?? DEFAULT_POLICY) + "\n\nSelected workflow: " + record.workflow + ".\n" + (this.options.workflowText?.[record.workflow] ?? "")
      + "\n\n" + WORKSTREAM_DECISION_POLICY
      + "\nWorker escalation: If essential missing information, new permissions, or an explicitly requested user decision blocks progress, complete only independent authorised work, then return a final blocked handoff containing the exact question, available options and relevant context to the controller. Stop dependent work. The controller must collect a real answer and provide it in a new assignment; this worker cannot receive follow-up answers while running. This worker's approval transport carries allow/deny decisions and cannot deliver selected AskUserQuestion answers. Do not invoke AskUserQuestion or another questionnaire tool to collect user choices from this worker, and never invent a user answer."
      + (this.approvalPolicy === "bypass" ? "\nThis subscription connection uses automatic worker tool approval. This removes extra tool approval prompts; it does not expand the task's authority or override repository, production, sandbox, or workspace rules." : "")
      + "\nAssigned worktree: " + record.worktree + ". Write within the assigned working directory: " + (record.workingDirectory ?? record.worktree)
      + ". Source checkout is read-only context: " + record.repository + "."
      + " Read applicable AGENTS.md and CLAUDE.md instructions from that source when absent from the snapshot. Keep private credentials and excluded application state out of task output."
      + (record.inputSnapshot?.ignoredUntrackedFiles ? "\nThe input snapshot excludes Gitignored untracked files." : "")
      + (record.inputSnapshot?.excluded.length ? "\nInput snapshot exclusions: " + JSON.stringify(record.inputSnapshot.excluded) + ". If an excluded file is needed, report the missing input." : "");
  }
  private requestPermission(live: LiveWorker, tool: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): ReturnType<CanUseTool> {
    if (live.controller.signal.aborted || signal.aborted || !EXECUTING.has(live.record.state)) return Promise.resolve({ behavior: "deny", message: "The worker is no longer accepting actions." });
    // The optional approval bypass does not bypass the worker's tool or
    // workspace boundaries, including direct native permission callbacks.
    let refused: string | undefined;
    if (BLOCKED_TOOLS.includes(tool)) refused = "This worker cannot create another workspace, remote execution or a scheduled task.";
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const path = input.file_path ?? input.notebook_path;
      if (typeof path !== "string" || !insideWorktree(live.record.workingDirectory ?? live.record.worktree, path)) refused = "Writes must stay in this worker's assigned directory.";
    }
    if (tool === "Workflow") refused = validateWorkflowInput(input);
    const id = randomUUID(), snapshot = structuredClone(input);
    const view: WorkerApproval = { id, toolName: tool.slice(0, 160), input: redactJson(snapshot), requestedAt: now(), ...(toolUseId ? { toolUseId } : {}) };
    if (refused || this.approvalPolicy === "bypass") {
      // An existing parked batch must reacquire its seat before any native
      // continuation, including an automatically approved concurrent action.
      if (this.options.provider.kind === "subscription" && this.options.acquireLease && live.approvalBatch) {
        return this.subscriptionPermission(live, snapshot, view, signal, refused ? { decision: "deny", message: refused } : { decision: "allow" });
      }
      return Promise.resolve(refused ? { behavior: "deny", message: refused } : { behavior: "allow", updatedInput: snapshot });
    }
    // Apply the exact display/decision bound before creating a pending action or
    // parking a subscription lease. An unreadable action must return a denial
    // to the SDK so it can continue with a smaller operation.
    if (approvalSummary(view).length > MAX_WORKER_APPROVAL_SUMMARY_CHARS) {
      const message = "This action exceeds the Factory approval display limit. Retry with a smaller action.";
      // Another concurrent action may already have parked this worker's lease.
      // Its automatic denial must respect that handoff before native work resumes.
      if (this.options.provider.kind === "subscription" && this.options.acquireLease && live.approvalBatch) {
        return this.subscriptionPermission(live, snapshot, view, signal, { decision: "deny", message });
      }
      return Promise.resolve({ behavior: "deny", message });
    }
    if (this.options.provider.kind === "subscription" && this.options.acquireLease) return this.subscriptionPermission(live, snapshot, view, signal);
    return new Promise((resolvePermission) => {
      let settled = false;
      const abort = () => settle("deny");
      const settle = (decision: "allow" | "deny"): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort); live.controller.signal.removeEventListener("abort", abort);
        live.approvals.delete(id); live.record.pendingApprovalCount = live.approvals.size;
        if (EXECUTING.has(live.record.state)) live.record.state = live.approvals.size ? "waiting_approval" : "running";
        this.save(live);
        resolvePermission(decision === "allow" ? { behavior: "allow", updatedInput: snapshot } : { behavior: "deny", message: "Denied by the Factory controller or worker cancellation." });
      };
      live.approvals.set(id, { view, settle });
      live.record.pendingApprovalCount = live.approvals.size; live.record.state = "waiting_approval"; this.save(live);
      signal.addEventListener("abort", abort, { once: true }); live.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || live.controller.signal.aborted) abort();
    });
  }
  private subscriptionPermission(live: LiveWorker, snapshot: Record<string, unknown>, view: WorkerApproval, signal: AbortSignal,
    automatic?: { decision: "allow" | "deny"; message?: string }): ReturnType<CanUseTool> {
    let batch = live.approvalBatch;
    if (!batch) {
      const controller = new AbortController(), abort = () => controller.abort();
      live.controller.signal.addEventListener("abort", abort, { once: true });
      const lease = live.lease;
      live.lease = undefined;
      batch = { generation: live.generation, controller, requests: new Map(),
        parked: Promise.resolve().then(() => lease?.release({ state: "waiting_host", cleanupVerified: false, sdkSessionId: live.record.sdkSessionId })),
        detach: () => live.controller.signal.removeEventListener("abort", abort) };
      live.approvalBatch = batch;
      // A failed handoff cannot authorize more work. Final cleanup resolves the shared record.
      void batch.parked.catch(() => live.controller.abort());
    }
    const current = batch, id = view.id;
    return new Promise(resolvePermission => {
      const abort = () => settle("deny");
      const pending = { decision: automatic?.decision as "allow" | "deny" | undefined, finish: (allowed: boolean) => {
        signal.removeEventListener("abort", abort);
        live.controller.signal.removeEventListener("abort", abort);
        resolvePermission(allowed && !signal.aborted ? { behavior: "allow", updatedInput: snapshot }
          : { behavior: "deny", message: automatic?.message ?? "Denied by the Factory controller or worker cancellation." });
      } };
      const settle = (decision: "allow" | "deny") => {
        if (pending.decision !== undefined) return;
        pending.decision = decision;
        live.approvals.delete(id);
        live.record.pendingApprovalCount = live.approvals.size;
        if (EXECUTING.has(live.record.state)) live.record.state = live.approvals.size ? "waiting_approval" : "starting";
        this.save(live);
        this.resumeApprovedBatch(live, current);
      };
      current.requests.set(id, pending);
      if (!automatic) {
        live.approvals.set(id, { view, settle });
        live.record.pendingApprovalCount = live.approvals.size;
        live.record.state = "waiting_approval"; this.save(live);
      }
      signal.addEventListener("abort", abort, { once: true });
      live.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || live.controller.signal.aborted) abort();
      if (automatic) this.resumeApprovedBatch(live, current);
    });
  }
  private resumeApprovedBatch(live: LiveWorker, batch: SubscriptionApprovalBatch): void {
    if (batch.resuming || [...batch.requests.values()].some(request => request.decision === undefined)) return;
    const active = () => this.workers.get(live.record.id) === live && live.approvalBatch === batch
      && live.generation === batch.generation && !live.controller.signal.aborted && !batch.controller.signal.aborted && EXECUTING.has(live.record.state);
    const finish = (allow: boolean) => {
      if (live.approvalBatch === batch) live.approvalBatch = undefined;
      batch.detach();
      for (const request of batch.requests.values()) request.finish(allow && request.decision === "allow");
    };
    batch.resuming = (async () => {
      await batch.parked;
      if (!active()) { finish(false); return; }
      // Denial also lets the native model continue; every non-cancelled result
      // therefore waits for the same fixed seat before reaching the SDK.
      const lease = await this.options.acquireLease!(structuredClone(live.record), batch.controller.signal);
      live.lease = lease;
      if (!active()) { finish(false); return; }
      if ([...batch.requests.values()].some(request => request.decision === undefined)) {
        live.lease = undefined;
        await lease.release({ state: "waiting_host", cleanupVerified: false, sdkSessionId: live.record.sdkSessionId });
        return;
      }
      live.record.state = "running"; this.save(live);
      finish(true);
    })().catch(() => { live.controller.abort(); finish(false); }).finally(() => {
      batch.resuming = undefined;
      if (live.approvalBatch === batch) this.resumeApprovedBatch(live, batch);
    });
  }
  private denyApprovals(live: LiveWorker): void { for (const item of [...live.approvals.values()]) item.settle("deny"); }
  private message(live: LiveWorker, value: Record<string, unknown>): void {
    if (live.controller.signal.aborted || !EXECUTING.has(live.record.state)) return;
    const record = live.record;
    const childId = typeof value.parent_tool_use_id === "string" && value.parent_tool_use_id ? value.parent_tool_use_id : undefined;
    const isChild = childId !== undefined;
    if (!isChild) {
      if (value.type === "assistant" && value.error === "rate_limit") {
        const message = object(value.message);
        const text = (Array.isArray(message?.content) ? message.content : [])
          .filter(part => object(part)?.type === "text").map(part => String(object(part)?.text ?? "")).join("\n");
        const reset = /\|(\d{10})\b/.exec(text);
        record.backoff = { kind: "usage_limit", retryAfterSeconds: reset ? Math.max(60, Math.min(86400, Number(reset[1]) - Math.floor(Date.now() / 1000))) : 3600 };
      } else if (value.type === "assistant" && value.error === "overloaded") {
        record.backoff = { kind: "overloaded", retryAfterSeconds: 60 };
      } else if (value.type === "rate_limit_event" && object(value.rate_limit_info)?.status === "rejected") {
        const reset = object(value.rate_limit_info)?.resetsAt;
        record.backoff = { kind: "usage_limit", retryAfterSeconds: typeof reset === "number" && Number.isFinite(reset)
          ? Math.max(60, Math.min(86400, Math.ceil(reset - Date.now() / 1000))) : 3600 };
      } else if (value.type === "system" && value.subtype === "api_retry" && [429, 529].includes(Number(value.error_status))) {
        record.backoff = workerBackoff({ status: value.error_status });
      }
    }
    if (!isChild && typeof value.session_id === "string" && value.session_id.length < 160) {
      if (!record.sdkSessionId) {
        record.sdkSessionId = value.session_id;
        const transcript = transcriptPath(live.configDir, record.workingDirectory ?? record.worktree, value.session_id);
        if (transcript) record.transcriptPath = transcript;
      }
      else if (record.sdkSessionId !== value.session_id) {
        live.resultSucceeded = false; record.reason = "root_session_identity_changed";
        throw new Error("Native root session identity changed.");
      }
    }
    const trackChild = (id: string, state: "running" | "completed" | "failed" | "cancelled"): void => {
      if (id.length > 256) return;
      const prior = live.children.get(id);
      if (prior?.state === "failed" || prior?.state === "cancelled" || (prior?.state === "completed" && state === "running")) return;
      live.children.set(id, { id, state });
    };
    if (childId) trackChild("tool:" + childId, value.type === "result" ? (value.subtype === "success" && value.is_error !== true ? "completed" : "failed") : "running");
    if (value.type === "system" && value.ambient !== true && value.skip_transcript !== true
        && ["task_started", "task_progress", "task_notification"].includes(String(value.subtype)) && typeof value.task_id === "string") {
      const key = typeof value.tool_use_id === "string" && value.tool_use_id ? "tool:" + value.tool_use_id : "task:" + value.task_id + ":" + (typeof value.run_id === "string" ? value.run_id : "");
      const state = value.subtype !== "task_notification" ? "running" : value.status === "completed" ? "completed" : value.status === "stopped" ? "cancelled" : "failed";
      trackChild(key, state);
    }
    record.children = [...live.children.values()];
    const event = live.usage.ingest(value);
    if (event?.source === "provider_message" && event.status === "reported") live.providerEvidence = true;
    if (live.providerEvidence) record.usage = { ...live.usage.providerTotals(), status: "provider-reported", scope: "deduplicated_provider_messages" };
    const billing = live.usage.billingSnapshot();
    if (billing) record.billingEstimate = billing;
    const message = object(value.message);
    if (value.type === "assistant" && message) {
      if (typeof message.model === "string" && /^[a-z0-9/_.-]{1,160}$/i.test(message.model) && !record.observedModels.includes(message.model)) record.observedModels.push(message.model);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const block = object(part);
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.id === "string") {
          const input = object(block.input);
          if (typeof input?.command === "string") live.bashCalls.set(block.id, createHash("sha256").update(input.command).digest("hex"));
        }
      }
    }
    if (value.type === "user" && message) for (const part of Array.isArray(message.content) ? message.content : []) {
      const block = object(part);
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && live.bashCalls.has(block.tool_use_id)) {
        if (!record.checkEvidence.some((item) => item.toolUseId === block.tool_use_id)) record.checkEvidence.push({ toolUseId: block.tool_use_id, commandSha256: live.bashCalls.get(block.tool_use_id)!, status: block.is_error === true ? "failed" : "succeeded" });
      }
    }
    if (value.type === "result" && !isChild) {
      live.sawResult = true; live.resultSucceeded = value.subtype === "success" && value.is_error !== true;
      if (typeof value.result === "string") record.result = redactValue(value.result).slice(0, 100_000);
      if (!live.resultSucceeded) record.reason = typeof value.subtype === "string" ? value.subtype.slice(0, 120) : "native_error_result";
      if (live.resultSucceeded) delete record.backoff;
      else if (record.backoff) record.reason = "native_" + record.backoff.kind;
    }
    this.save(live);
  }
}

/** Only native error/status evidence is classified; successful model text is ignored. */
export function workerBackoff(error: unknown): WorkerRecord["backoff"] {
  const mapped = upstreamError(error);
  if (!mapped) return undefined;
  const usage = mapped.extra.usage_limit === true;
  const seconds = typeof mapped.extra.retry_after === "number" && Number.isFinite(mapped.extra.retry_after) ? mapped.extra.retry_after : usage ? 3600 : 60;
  return { kind: usage ? "usage_limit" : mapped.code === "rate_limit_error" ? "rate_limit" : "overloaded", retryAfterSeconds: Math.max(1, Math.min(86400, Math.ceil(seconds))) };
}

function workerOperation(input: WorkerStartInput): WorkerOperation | undefined {
  if (!input || typeof input !== "object") throw new WorkerStartRejected("invalid_request", "A worker request is required.");
  if (input.operationId === undefined && input.operationOwner === undefined) return undefined;
  if (!validOperationId(input.operationId) || typeof input.operationOwner !== "string" || !/^[a-f0-9]{64}$/.test(input.operationOwner)) {
    throw new WorkerStartRejected("invalid_request", "A valid operation ID and owner are required together.");
  }
  const requestDigest = createHash("sha256").update(JSON.stringify({ repository: input.repository, task: input.task, workflow: input.workflow })).digest("hex");
  return { id: input.operationId, owner: input.operationOwner, requestDigest };
}

function safeFailure(error: unknown, stage: "admission" | "execution", fallback: string): NonNullable<WorkerRecord["failure"]> {
  const value = object(error);
  const nativeCode = error instanceof BridgeError ? error.code : value?.code;
  const code = typeof nativeCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(nativeCode) ? nativeCode : fallback;
  return { stage, code, message: stage === "admission" ? "Worker admission or runtime preflight failed." : "Native worker execution failed. The result and completed child records are retained." };
}

/** Mirrors Claude Code's project folder naming; long paths use a hashed name we do not guess. */
function transcriptPath(configDir: string | undefined, cwd: string, sessionId: string): string | undefined {
  if (!configDir || !isAbsolute(configDir) || !/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) return undefined;
  const project = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return project.length > 200 ? undefined : join(configDir, "projects", project, sessionId + ".jsonl");
}

function now(): string { return new Date().toISOString(); }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function canonicalRepository(path: string, requireCanonical = false): string {
  if (!isAbsolute(path)) throw new Error("Repository paths must be absolute.");
  const canonical = realpathSync(path), info = lstatSync(canonical);
  if (requireCanonical && canonical !== resolve(path)) throw new Error("Use the canonical repository path without symlinks.");
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("Repository must be owned by this user.");
  return canonical;
}
function insideWorktree(worktree: string, supplied: string): boolean {
  const path = resolve(worktree, supplied), trail: string[] = [];
  let existing = path;
  for (;;) {
    try { existing = realpathSync(existing); break; }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return false;
      const parent = dirname(existing);
      if (parent === existing) return false;
      trail.unshift(existing.slice(parent.length + 1)); existing = parent;
    }
  }
  const target = resolve(existing, ...trail), rel = relative(worktree, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function git(repository: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repository, ...args], {
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return result.stdout.trim();
  } catch { throw new Error("Git workspace operation failed; source changes were preserved."); }
}
