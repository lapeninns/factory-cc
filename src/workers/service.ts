import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { assertNativeWorkflowSupport, type NativeWorkflowSupport } from "../runtime/native-workflow-support.js";
import { OwnedProcesses } from "../runtime/owned-processes.js";
import { UsageLedger } from "../runtime/usage.js";
import { validateWorkflowInput } from "../runtime/native-workflows.js";
import { buildChildEnv, MODEL_SLOT_NAMES } from "../upstream/auth-env.js";
import type { UpstreamSelection } from "../upstream/providers.js";
import { redactJson, redactValue } from "../security/redact.js";
import type { Logger } from "../logging.js";
import type { Usage } from "../types.js";
import { privateDirectory, readWorkers, workerId, writeWorker, type WorkerRecord, type WorkerWorkflow } from "./worker-state.js";
import { prepareSubscription, verifyNativeSubscription, type SubscriptionIdentity } from "./subscription-auth.js";
import type { SubscriptionProfile } from "../runtime/desktop-jobs.js";

const exec = promisify(execFile);
const TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);
const DEFAULT_POLICY = "You are a supervised worker delegated by a Factory Workstream. Read this repository's AGENTS.md and CLAUDE.md instructions. Work only in your assigned worktree. Preserve source checkout changes. Follow the user's QA/e2e and Local CI rules. Produce evidence and a reviewable result. Never infer permission to publish, deploy, merge, change production, buy credits or borrow another account. Permissions require the controller's explicit decision. Report checks actually executed and unresolved limitations. The small workflow guideline is advice, not a hard agent or spend cap.";
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
export interface APIWorkerServiceOptions {
  stateRoot: string;
  workspaceRoot: string;
  allowedRepositories: string[];
  provider: { kind: "anthropic" | "openrouter" } | { kind: "subscription"; profile: SubscriptionProfile; mappingPath?: string; executable?: string };
  maxConcurrent?: number;
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
}
const silentLogger = { info() {}, warn() {}, error() {} } as unknown as Logger;

/** Factory remains the controller; each worker has its own native session and worktree. */
export class APIWorkerService {
  private readonly root: string;
  private readonly workspaces: string;
  private readonly repositories: Set<string>;
  private readonly workers = new Map<string, LiveWorker>();
  private readonly active = new Set<string>();
  private readonly creating = new Set<Promise<unknown>>();
  private readonly processes = new OwnedProcesses(silentLogger);
  private readonly capacity: number;
  private closed = false;

  constructor(private readonly options: APIWorkerServiceOptions) {
    this.capacity = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 2) throw new Error("Worker concurrency must be one or two.");
    if (options.provider.kind !== "subscription" && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd! <= 0)) throw new Error("An explicit positive estimated budget is required.");
    if (options.provider.kind === "subscription" && options.maxBudgetUsd !== undefined) throw new Error("Subscription workers do not use an API spend budget.");
    if (!Number.isSafeInteger(options.maxMs) || options.maxMs < 1000 || options.maxMs > 2 * 60 * 60_000) throw new Error("Worker deadline must be from one second to two hours.");
    if (!Number.isSafeInteger(options.maxTurns ?? 32) || (options.maxTurns ?? 32) < 1 || (options.maxTurns ?? 32) > 500) throw new Error("Worker turn limit must be an integer from 1 to 500.");
    if (!["anthropic", "openrouter", "subscription"].includes(options.provider.kind)) throw new Error("An explicit authentication route is required.");
    if (!options.allowedRepositories.length) throw new Error("An explicit repository allowlist is required.");
    this.root = privateDirectory(options.stateRoot);
    this.workspaces = privateDirectory(options.workspaceRoot);
    this.repositories = new Set(options.allowedRepositories.map(canonicalRepository));
    for (const record of readWorkers(this.root)) {
      if (!TERMINAL.has(record.state)) {
        record.state = "unknown";
        record.reason = "service_restarted_without_process_ownership";
        record.cleanupVerified = null;
        record.pendingApprovalCount = 0;
        record.updatedAt = now();
        writeWorker(this.root, record);
      }
      const live = this.live(record);
      this.workers.set(record.id, live);
      if (record.state === "unknown") this.active.add(record.id);
    }
  }

  start(input: { repository: string; task: string; workflow: WorkerWorkflow }): Promise<WorkerView> {
    if (this.closed) return Promise.reject(new Error("Worker service is closed."));
    const creating = this.startImpl(input);
    this.creating.add(creating);
    void creating.finally(() => this.creating.delete(creating)).catch(() => undefined);
    return creating;
  }

  private async startImpl(input: { repository: string; task: string; workflow: WorkerWorkflow }): Promise<WorkerView> {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 100_000) throw new Error("A bounded nonempty worker task is required.");
    if (!["implement", "investigate", "release-prepare"].includes(input.workflow)) throw new Error("Unknown worker workflow.");
    const repository = canonicalRepository(input.repository);
    if (!this.repositories.has(repository)) throw new Error("Repository is not in the worker allowlist.");
    await this.prepareRuntime();
    const sourceRoot = await git(repository, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(sourceRoot) !== repository) throw new Error("Use the allowlisted repository root.");
    const sourceCommit = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("An exact committed source revision is required.");
    const sourceDirty = Boolean(await git(repository, ["status", "--porcelain", "--untracked-files=normal"]));
    if (this.closed) throw new Error("Worker service is closed.");
    const id = "worker-" + randomUUID(), worktree = join(this.workspaces, id), branch = "factory-workers/" + id;
    await git(repository, ["worktree", "add", "-b", branch, worktree, sourceCommit]);
    const timestamp = now();
    const record: WorkerRecord = { version: 1, id, state: "queued", repository, worktree: realpathSync(worktree), branch,
      sourceCommit, sourceDirty, workflow: input.workflow, requested: { model: "claude-opus-5-5", effort: "medium", ultracode: true },
      createdAt: timestamp, updatedAt: timestamp, observedModels: [], pendingApprovalCount: 0, cleanupVerified: null, checkEvidence: [],
      authentication: this.options.provider.kind, ...(this.options.provider.kind === "subscription" ? { subscriptionProfile: this.options.provider.profile } : {}) };
    const live = this.live(record, input.task);
    this.workers.set(id, live);
    this.save(live);
    if (this.closed) {
      record.state = "cancelled"; record.reason = "service_closed_before_admission";
      record.cleanupVerified = true; record.endedAt = now(); this.save(live);
    } else this.schedule();
    return this.view(live);
  }

  status(id: string): WorkerView { return this.view(this.find(id)); }
  list(): WorkerView[] { return [...this.workers.values()].map((worker) => this.view(worker)); }

  async cancel(id: string): Promise<WorkerView> {
    const live = this.find(id);
    if (TERMINAL.has(live.record.state)) return this.view(live);
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

  approve(input: { id: string; approvalId: string; decision: "allow" | "deny" }): WorkerView {
    if (input.decision !== "allow" && input.decision !== "deny") throw new Error("Approval decision must be allow or deny.");
    const live = this.find(input.id), pending = live.approvals.get(input.approvalId);
    if (!pending || live.controller.signal.aborted || TERMINAL.has(live.record.state)) throw new Error("Approval is missing, expired or already resolved.");
    pending.settle(input.decision);
    return this.view(live);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.creating]);
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
      this.active.add(live.record.id);
      live.done = this.execute(live).finally(() => {
        if (live.record.cleanupVerified === true) this.active.delete(live.record.id);
        this.schedule();
      });
      void live.done.catch(() => undefined);
    }
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
    const timer = setTimeout(() => { deadline = true; live.controller.abort(); this.denyApprovals(live); }, this.options.maxMs);
    timer.unref();
    try {
      record.state = "starting"; record.startedAt = now(); this.save(live);
      live.lease = await this.options.acquireLease?.(record, live.controller.signal);
      if (live.controller.signal.aborted) throw new Error("Worker stopped before execution.");
      const { support, env, identity } = await this.prepareRuntime();
      if (this.options.provider.kind !== "subscription") env.CLAUDE_CONFIG_DIR = privateDirectory(join(this.root, "native-config", record.id));
      const permission: CanUseTool = (tool, input, options) => this.requestPermission(live, tool, input, options.signal, options.toolUseID);
      const options: Options = {
        cwd: record.worktree, env, abortController: live.controller, model: "claude-opus-5-5", effort: "medium",
        pathToClaudeCodeExecutable: support.executable, permissionMode: "default", permissionPrompts: "host", canUseTool: permission,
        settingSources: [], strictMcpConfig: true, mcpServers: {},
        settings: { ultracode: true, enableWorkflows: true, workflowSizeGuideline: "small" },
        disallowedTools: BLOCKED_TOOLS,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.policy(record) },
        ...(this.options.provider.kind !== "subscription" ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}), maxTurns: this.options.maxTurns ?? 32,
        sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [record.worktree] } },
        hooks: { PreToolUse: [{ hooks: [async (event, toolUseId, context) => {
          if (event.hook_event_name !== "PreToolUse") return {};
          const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
          const active = () => this.workers.get(record.id) === live && live.generation === generation && !live.controller.signal.aborted && !context.signal.aborted && !TERMINAL.has(record.state);
          if (!active()) return deny("This worker execution has ended.");
          if (BLOCKED_TOOLS.includes(event.tool_name)) return deny("This worker cannot create another workspace, remote execution or a scheduled task.");
          if (event.tool_name === "Workflow") {
            const input = object(event.tool_input);
            const invalid = input ? validateWorkflowInput(input) : "Workflow input must be an object.";
            if (invalid) return deny(invalid);
            const id = toolUseId ?? event.tool_use_id;
            if (!id) return deny("Workflow execution requires an exact tool-use identity.");
            // Workflow can be classified as safe by the native permission engine.
            // Ask explicitly here before it can run, regardless of canUseTool.
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
            if (typeof path !== "string" || !insideWorktree(record.worktree, path)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Writes must stay in this worker's assigned worktree." } };
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
      record.state = live.cancelRequested ? "cancelled" : deadline ? "failed" : live.sawResult && live.resultSucceeded && !childFailed && !childrenPending ? "completed" : "failed";
      if (childFailed) record.reason = "child_task_failed";
      else if (childrenPending) record.reason = "child_completion_unproven";
      if (!live.sawResult && !live.cancelRequested && !deadline) record.reason = "native_result_missing";
    } catch {
      record.state = live.cancelRequested ? "cancelled" : "failed";
      record.reason = live.cancelRequested ? "cancelled" : deadline ? "deadline_exceeded" : "native_execution_failed";
      record.error = "Worker execution did not complete successfully. Review its recorded state and approvals.";
    } finally {
      live.generation++;
      clearTimeout(timer);
      live.task = undefined;
      const approvalBatch = live.approvalBatch;
      approvalBatch?.controller.abort();
      this.denyApprovals(live);
      if (approvalBatch) await Promise.allSettled([approvalBatch.parked, approvalBatch.resuming]);
      try {
        if (this.options.cleanup) await this.options.cleanup(record.id);
        else await this.processes.stop(record.id);
        record.cleanupVerified = true;
      } catch {
        record.cleanupVerified = false; record.state = "unknown"; record.reason = "owned_process_cleanup_unproven";
      }
      record.endedAt = now();
      const lease = live.lease;
      live.lease = undefined;
      const leaseResult: WorkerLeaseResult = { state: record.state === "completed" ? "completed" : record.state === "cancelled" ? "cancelled" : record.state === "unknown" ? "unknown" : "failed", cleanupVerified: record.cleanupVerified === true, usage: live.providerEvidence ? { ...live.usage.providerTotals(), estimated: false } : undefined, sdkSessionId: record.sdkSessionId };
      try {
        if (lease) await lease.release(leaseResult);
        else await this.options.finalizeLease?.(record, leaseResult);
      }
      catch { record.state = "unknown"; record.cleanupVerified = false; record.reason = "shared_lease_release_unproven"; }
      this.save(live);
    }
  }
  private policy(record: WorkerRecord): string {
    return (this.options.policyText ?? DEFAULT_POLICY) + "\n\nSelected workflow: " + record.workflow + ".\n" + (this.options.workflowText?.[record.workflow] ?? "")
      + "\nAssigned worktree: " + record.worktree + ". Source checkout is read-only context: " + record.repository + ".";
  }
  private requestPermission(live: LiveWorker, tool: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): ReturnType<CanUseTool> {
    if (live.controller.signal.aborted || signal.aborted || TERMINAL.has(live.record.state)) return Promise.resolve({ behavior: "deny", message: "The worker is no longer accepting actions." });
    if (this.options.provider.kind === "subscription" && this.options.acquireLease) return this.subscriptionPermission(live, tool, input, signal, toolUseId);
    const id = randomUUID(), snapshot = structuredClone(input);
    const view: WorkerApproval = { id, toolName: tool.slice(0, 160), input: redactJson(snapshot), requestedAt: now(), ...(toolUseId ? { toolUseId } : {}) };
    return new Promise((resolvePermission) => {
      let settled = false;
      const abort = () => settle("deny");
      const settle = (decision: "allow" | "deny"): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort); live.controller.signal.removeEventListener("abort", abort);
        live.approvals.delete(id); live.record.pendingApprovalCount = live.approvals.size;
        if (!TERMINAL.has(live.record.state)) live.record.state = live.approvals.size ? "waiting_approval" : "running";
        this.save(live);
        resolvePermission(decision === "allow" ? { behavior: "allow", updatedInput: snapshot } : { behavior: "deny", message: "Denied by the Factory controller or worker cancellation." });
      };
      live.approvals.set(id, { view, settle });
      live.record.pendingApprovalCount = live.approvals.size; live.record.state = "waiting_approval"; this.save(live);
      signal.addEventListener("abort", abort, { once: true }); live.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || live.controller.signal.aborted) abort();
    });
  }
  private subscriptionPermission(live: LiveWorker, tool: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): ReturnType<CanUseTool> {
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
    const current = batch, id = randomUUID(), snapshot = structuredClone(input);
    const view: WorkerApproval = { id, toolName: tool.slice(0, 160), input: redactJson(snapshot), requestedAt: now(), ...(toolUseId ? { toolUseId } : {}) };
    return new Promise(resolvePermission => {
      const abort = () => settle("deny");
      const pending = { decision: undefined as "allow" | "deny" | undefined, finish: (allowed: boolean) => {
        signal.removeEventListener("abort", abort);
        live.controller.signal.removeEventListener("abort", abort);
        resolvePermission(allowed && !signal.aborted ? { behavior: "allow", updatedInput: snapshot }
          : { behavior: "deny", message: "Denied by the Factory controller or worker cancellation." });
      } };
      const settle = (decision: "allow" | "deny") => {
        if (pending.decision !== undefined) return;
        pending.decision = decision;
        live.approvals.delete(id);
        live.record.pendingApprovalCount = live.approvals.size;
        if (!TERMINAL.has(live.record.state)) live.record.state = live.approvals.size ? "waiting_approval" : "starting";
        this.save(live);
        this.resumeApprovedBatch(live, current);
      };
      current.requests.set(id, pending);
      live.approvals.set(id, { view, settle });
      live.record.pendingApprovalCount = live.approvals.size;
      live.record.state = "waiting_approval"; this.save(live);
      signal.addEventListener("abort", abort, { once: true });
      live.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || live.controller.signal.aborted) abort();
    });
  }
  private resumeApprovedBatch(live: LiveWorker, batch: SubscriptionApprovalBatch): void {
    if (batch.resuming || [...batch.requests.values()].some(request => request.decision === undefined)) return;
    const active = () => this.workers.get(live.record.id) === live && live.approvalBatch === batch
      && live.generation === batch.generation && !live.controller.signal.aborted && !batch.controller.signal.aborted && !TERMINAL.has(live.record.state);
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
    if (live.controller.signal.aborted || TERMINAL.has(live.record.state)) return;
    const record = live.record;
    const childId = typeof value.parent_tool_use_id === "string" && value.parent_tool_use_id ? value.parent_tool_use_id : undefined;
    const isChild = childId !== undefined;
    if (!isChild && typeof value.session_id === "string" && value.session_id.length < 160) {
      if (!record.sdkSessionId) record.sdkSessionId = value.session_id;
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
    }
    this.save(live);
  }
}

function now(): string { return new Date().toISOString(); }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function canonicalRepository(path: string): string {
  if (!isAbsolute(path)) throw new Error("Repository paths must be absolute.");
  const canonical = realpathSync(path), info = lstatSync(canonical);
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
