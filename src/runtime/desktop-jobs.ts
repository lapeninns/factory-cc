import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BridgeError, type Usage } from "../types.js";
import { collectToolResults } from "../protocol/content.js";
import type { BridgeRuntime, RetiredSession, RuntimeControl, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";

/** Values supplied by the authenticated host controller, never request metadata. */
export const SUBSCRIPTION_PROFILES = ["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"] as const;
export type SubscriptionProfile = typeof SUBSCRIPTION_PROFILES[number];
/** One execution per configured seat. Routing weights never multiply capacity. */
export const SUBSCRIPTION_WORKER_SLOTS = SUBSCRIPTION_PROFILES.length;
export type DesktopWorkspacePolicy = "controller-readonly" | "controller-host" | "factory-native";
export interface DesktopJobBinding { sessionId: string; cwd: string; launchId?: string; subscriptionProfile?: SubscriptionProfile; workspacePolicy?: DesktopWorkspacePolicy; nativeGeneration?: number; inferenceRole?: "orchestrator" | "worker" }
export type DesktopJobState = "waiting_host" | "idle" | "completed" | "failed" | "cancelled" | "unknown";
export interface DesktopJobRelease {
  state: DesktopJobState;
  usage?: Usage;
  sdkSessionId?: string;
  /** Applies to tracked runtime processes, not arbitrary daemonisation. */
  cleanupVerified?: boolean;
  /** A published host action keeps its workspace, without occupying inference. */
  hostActionReservation?: boolean;
}
export interface DesktopJobAcquire {
  factorySessionId: string;
  bridgeSessionId: string;
  cwd: string;
  role: RuntimeRequest["role"];
  /** Fixed by private operator configuration, never selected by a worker task. */
  subscriptionProfile?: SubscriptionProfile;
  /** Supplied only by the immutable read-only controller configuration. */
  workspacePolicy?: DesktopWorkspacePolicy;
  /** Persisted native checkpoint this phase resumes; a new generation must continue its lineage's latest one. */
  resumeSessionId?: string;
}
/** Sanitised lease facts for one generation of a bridge conversation. */
export interface NativeGenerationEvidence {
  generation: number;
  state: string;
  externalCleanupRequired: boolean;
  hostActionReservation: boolean;
  ownerAlive: boolean;
  supervisorAlive: boolean;
  cleanupVerified: boolean;
  /** Null when no checkpoint comparison was requested or the lease recorded none. */
  checkpointMatches: boolean | null;
  bindingMatches: boolean;
  endedAt: string | null;
  /** How the lease reached its current state: a session-level update, an admitted phase's release, or another path. */
  endedBy: "session_update" | "phase_release" | "other";
}
export type NativeGenerationInspection = Omit<DesktopJobAcquire, "role" | "resumeSessionId"> & {
  sdkSessionId?: string;
  /** Read-only sibling settlement may validate each lease's recorded, known policy. */
  useRecordedWorkspacePolicy?: boolean;
};
export const NATIVE_GENERATION_REFUSALS = ["lease_binding_mismatch", "terminal_session_cannot_reacquire", "stale_native_generation",
  "native_predecessor_unresolved", "native_checkpoint_mismatch"] as const;
export interface DesktopJobLease { jobId: string; release(result: DesktopJobRelease): Promise<void> }
/**
 * Release, update and deferral confirmations wait for the shared state lock.
 * A burst of queued helpers can hold that lock for several seconds, and a
 * missed confirmation stops the helper and leaves the account reserved.
 */
export const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;
export interface DesktopLeaseOptions {
  pythonExecutable: string;
  runtimePackagePath: string;
  stateRoot: string;
  /** Shared worker capacity; the native scheduler reserves one additional controller slot. */
  maxRunning?: number;
  admissionTimeoutMs?: number;
  releaseTimeoutMs?: number;
}
export interface DesktopJobsOptions extends DesktopLeaseOptions {
  /** Factory owns tool execution and workspace coordination in model-only mode. */
  factoryNative?: boolean;
  /** Exact configured namespace for independently supervised worker tools. */
  workerMcpPrefix?: string;
  getBinding(input: RuntimeRequest): DesktopJobBinding | undefined;
  acquireLease?(request: DesktopJobAcquire, signal: AbortSignal): Promise<DesktopJobLease>;
  updateRecord?(request: DesktopJobAcquire, result: DesktopJobRelease): Promise<void>;
  inspectGenerations?(request: NativeGenerationInspection): Promise<NativeGenerationEvidence[]>;
}

interface ActivePhase {
  controller: AbortController;
  request: DesktopJobAcquire;
  queuedAt: number;
  lease?: DesktopJobLease;
  outcome?: DesktopJobState;
  done?: Promise<RuntimeTurn>;
  cleanup?: Promise<boolean>;
  heldHost?: HeldHostPhase;
  acknowledgedHostIds?: Set<string>;
  unresolvedHostIds?: Set<string>;
  /** This phase introduced the process's identity for the session. */
  claimedIdentity?: boolean;
  /** A release or its ownership-checked fallback update was acknowledged. */
  settlementVerified?: boolean;
}

interface HeldHostPhase {
  request: DesktopJobAcquire;
  lease: DesktopJobLease;
  pending: Set<string>;
  usage?: Usage;
  sdkSessionId?: string;
  uncertain?: boolean;
  parked?: boolean;
}
const HOST_READ_CONTROL_TOOLS = new Set(["Read", "LS", "Grep", "Glob", "ToolSearch", "AskUser", "ExitSpecMode", "TodoWrite", "ListAgents"]);
const SUPERVISED_WORKER_TOOLS = new Set(["factory_worker_start", "factory_worker_status", "factory_worker_wait",
  "factory_worker_list", "factory_worker_cancel", "factory_worker_accounts", "factory_worker_lookup"]);

/** Unknown host tools may write or launch writers and must retain the workspace. */
export function hostActionNeedsWorkspaceReservation(name: string, workerMcpPrefix?: string): boolean {
  if (HOST_READ_CONTROL_TOOLS.has(name)) return false;
  if (workerMcpPrefix && name.startsWith(workerMcpPrefix)
      && SUPERVISED_WORKER_TOOLS.has(name.slice(workerMcpPrefix.length))) return false;
  return true;
}

function failure(code: string, message: string): BridgeError { return new BridgeError(503, code, message); }

/** Mirrors the lease helper's lane rule: only a fully bound subscription controller uses the reserved slot. */
function executionLane(request: DesktopJobAcquire): "controller" | "worker" {
  return request.subscriptionProfile && request.workspacePolicy && (request.role === "chat" || request.role === "orchestrator") ? "controller" : "worker";
}
const RECENT_ADMISSIONS = 50;

export function validateDesktopJobBinding(binding: DesktopJobBinding | undefined): DesktopJobBinding {
  if (!binding || typeof binding.sessionId !== "string" || !binding.sessionId || binding.sessionId.length > 256
      || typeof binding.cwd !== "string" || !isAbsolute(binding.cwd)) {
    throw new BridgeError(400, "desktop_job_binding", "This model requires an authenticated Factory session and its assigned absolute workspace.");
  }
  validateSubscriptionProfile(binding.subscriptionProfile);
  validateWorkspacePolicy(binding.workspacePolicy, binding.subscriptionProfile);
  if (binding.nativeGeneration !== undefined && (!Number.isSafeInteger(binding.nativeGeneration) || binding.nativeGeneration < 0
      || binding.nativeGeneration > 1_000_000 || !["controller-readonly", "controller-host", "factory-native"].includes(binding.workspacePolicy ?? ""))) {
    throw new BridgeError(400, "desktop_job_generation", "Invalid native controller generation.");
  }
  try {
    const cwd = realpathSync(binding.cwd);
    const directory = lstatSync(cwd);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error();
    if (binding.workspacePolicy === "controller-host" || binding.workspacePolicy === "factory-native") {
      if (cwd !== resolve(binding.cwd)) throw new Error();
      return { ...binding, cwd };
    }
    const git = lstatSync(join(cwd, ".git"));
    const markerAllowed = git.isFile() || (binding.workspacePolicy === "controller-readonly" && git.isDirectory());
    if (!markerAllowed || git.isSymbolicLink()
        || git.uid !== process.getuid?.()) throw new Error();
    return { ...binding, cwd };
  } catch {
    throw new BridgeError(422, "desktop_job_workspace", (binding.workspacePolicy === "controller-host" || binding.workspacePolicy === "factory-native")
      ? "Choose an existing, canonical workspace directory owned by this user."
      : "Choose a Git project root for a read-only controller, or a dedicated Git worktree for a supervised worker.");
  }
}

/**
 * A supervisor around a model phase, not a second conversation. Factory retains
 * its tools, approval broker and workspace. Native processes parked on Factory
 * tools may remain alive while another phase obtains inference capacity.
 */
export class DesktopJobsRuntime implements BridgeRuntime {
  private readonly active = new Map<string, ActivePhase>();
  private readonly known = new Map<string, DesktopJobAcquire>();
  private readonly heldHost = new Map<string, HeldHostPhase>();
  private readonly checkpointPreparations = new Map<string, Promise<void>>();
  private readonly faults: string[] = [];
  /** Queue delay of recent admissions in milliseconds, oldest first. */
  private readonly admissionDelays: number[] = [];
  private closed = false;
  readonly interrupt?: BridgeRuntime["interrupt"];
  readonly pendingHostCalls?: BridgeRuntime["pendingHostCalls"];
  readonly pendingNativeToolName?: BridgeRuntime["pendingNativeToolName"];
  readonly completeHostTool?: BridgeRuntime["completeHostTool"];
  readonly validateHostToolCompletion?: BridgeRuntime["validateHostToolCompletion"];
  readonly recordHostToolCompletion?: BridgeRuntime["recordHostToolCompletion"];
  readonly endHostSession?: BridgeRuntime["endHostSession"];
  readonly protectedSessionIds?: BridgeRuntime["protectedSessionIds"];
  readonly isSessionUsable?: BridgeRuntime["isSessionUsable"];
  readonly forget?: BridgeRuntime["forget"];

  constructor(private readonly inner: BridgeRuntime, private readonly options: DesktopJobsOptions) {
    if (!Number.isSafeInteger(options.maxRunning ?? 2) || (options.maxRunning ?? 2) < 1 || (options.maxRunning ?? 2) > 8) {
      throw new Error("Desktop job capacity must be an integer from one to eight.");
    }
    if (inner.interrupt) this.interrupt = async (sessionId, reason) => {
      const phase = this.active.get(sessionId);
      if (phase && !phase.lease) { phase.outcome = "cancelled"; phase.controller.abort(); return true; }
      if (!phase) return inner.interrupt!(sessionId, reason);
      // The inner interrupt ends handle() before it returns its clean-boundary
      // proof. Keep execute() from turning that interruption into a failed lease.
      let settle!: (clean: boolean) => void;
      const cleanup = new Promise<boolean>(resolve => { settle = resolve; });
      phase.cleanup = cleanup;
      let resumable = false;
      try {
        resumable = await inner.interrupt!(sessionId, reason);
        if (phase.cleanup !== cleanup || phase.outcome) resumable = false;
        if (resumable) phase.outcome = "idle";
      } finally {
        settle(resumable);
        if (resumable) await phase.done?.catch(() => undefined);
      }
      return resumable && phase.outcome === "idle" && phase.cleanup === cleanup && phase.settlementVerified === true;
    };
    if (inner.pendingHostCalls) this.pendingHostCalls = (id) => inner.pendingHostCalls!(id);
    if (inner.pendingNativeToolName) this.pendingNativeToolName = (id, callId) => inner.pendingNativeToolName!(id, callId);
    if (inner.validateHostToolCompletion) this.validateHostToolCompletion = (...args) => inner.validateHostToolCompletion!(...args);
    if (inner.recordHostToolCompletion) this.recordHostToolCompletion = async (id, completion) => {
      const result = await inner.recordHostToolCompletion!(id, completion);
      if (result === "accepted" || result === "duplicate") await this.acknowledgeHostReceipt(id, completion.toolUseId);
      return result;
    };
    if (inner.completeHostTool) this.completeHostTool = async (id, completion) => {
      const result = await inner.completeHostTool!(id, completion);
      if (result === "accepted") {
        if (completion.terminal) this.heldHost.get(id)?.pending.delete(completion.toolUseId);
        else await this.acknowledgeHostReceipt(id, completion.toolUseId);
      }
      if (completion.terminal) {
        await this.active.get(id)?.done?.catch(() => undefined);
        const held = this.heldHost.get(id);
        if (held) await this.finishHeldHost(id, held, held.pending.size ? "unknown" : "completed");
        else await this.update(id, { state: "completed", cleanupVerified: false });
      }
      return result;
    };
    if (inner.endHostSession) this.endHostSession = async (id, reason): Promise<RuntimeHostEnd> => {
      this.markUnresolvedHostAction(id);
      let result: RuntimeHostEnd;
      try { result = await inner.endHostSession!(id, reason); }
      catch (error) {
        const held = this.heldHost.get(id);
        if (held) await this.finishHeldHost(id, held, "unknown", false);
        throw error;
      }
      await this.active.get(id)?.done?.catch(() => undefined);
      if (!result.resumable) {
        const held = this.heldHost.get(id);
        if (held) await this.finishHeldHost(id, held, held.pending.size ? "unknown" : "completed", true);
        else await this.update(id, { state: "completed", sdkSessionId: result.sdkSessionId, cleanupVerified: true });
      }
      return result;
    };
    this.protectedSessionIds = () => [...new Set([...(inner.protectedSessionIds?.() ?? []), ...this.heldHost.keys()])];
    if (inner.isSessionUsable) this.isSessionUsable = (id) => inner.isSessionUsable!(id);
    if (inner.forget) this.forget = async (session: RetiredSession) => {
      if (this.heldHost.has(session.bridgeSessionId)) return;
      await inner.forget!(session);
      this.known.delete(session.bridgeSessionId);
    };
  }

  get kind(): BridgeRuntime["kind"] { return this.inner.kind; }
  setControl(control: RuntimeControl | undefined): void { this.inner.setControl?.(control); }
  deliverResults(...args: Parameters<BridgeRuntime["deliverResults"]>): ReturnType<BridgeRuntime["deliverResults"]> {
    return this.inner.deliverResults(...args);
  }

  handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    if (this.closed) return Promise.reject(failure("desktop_jobs_closed", "Desktop job supervisor is closed."));
    let binding: DesktopJobBinding;
    try { binding = validateDesktopJobBinding(this.options.getBinding(input)); }
    catch (error) { return Promise.reject(error); }
    if (binding.workspacePolicy === "factory-native" && !this.options.factoryNative) {
      return Promise.reject(failure("desktop_workspace_policy", "Factory-native admission requires the operator-configured model-only runtime."));
    }
    const id = input.session.bridgeSessionId;
    if (this.active.has(id)) return Promise.reject(new BridgeError(409, "desktop_job_busy", "This Factory model phase is already running."));
    const request: DesktopJobAcquire = { factorySessionId: binding.sessionId,
      bridgeSessionId: binding.nativeGeneration === undefined ? id : `${id}:g${binding.nativeGeneration}`, cwd: binding.cwd, role: binding.inferenceRole ?? input.role,
      ...(binding.subscriptionProfile === undefined ? {} : { subscriptionProfile: binding.subscriptionProfile }),
      ...(binding.workspacePolicy === undefined ? {} : { workspacePolicy: binding.workspacePolicy }),
      ...(binding.nativeGeneration !== undefined && input.recovery !== "cold-import" && input.session.sdkSessionId
        ? { resumeSessionId: input.session.sdkSessionId } : {}) };
    try { validateWorkspacePolicy(request.workspacePolicy, request.subscriptionProfile, request.role); }
    catch (error) { return Promise.reject(error); }
    const known = this.known.get(id);
    if (known && (known.bridgeSessionId !== request.bridgeSessionId || known.cwd !== request.cwd || known.factorySessionId !== request.factorySessionId
                  || known.subscriptionProfile !== request.subscriptionProfile || known.workspacePolicy !== request.workspacePolicy)) {
      return Promise.reject(new BridgeError(409, "desktop_job_identity", "This native session is already bound to another Factory session or worktree."));
    }
    const held = this.heldHost.get(id);
    const acknowledged = held ? new Set(collectToolResults(input.request.messages)
      .map(item => item.tool_use_id).filter(callId => held.pending.has(callId))) : undefined;
    if (held?.uncertain) return Promise.reject(failure("desktop_host_cleanup_unknown", "A prior host action has not been verified complete; its workspace remains reserved."));
    if (held?.pending.size && !acknowledged?.size) {
      return Promise.reject(new BridgeError(409, "desktop_host_action_pending", "Wait for the outstanding host action result before continuing this Workstream."));
    }
    this.known.set(id, request);
    const phase: ActivePhase = { controller: new AbortController(), request, queuedAt: Date.now(), claimedIdentity: !known,
      ...(held ? { ...(held.parked ? {} : { lease: held.lease }), heldHost: held, acknowledgedHostIds: acknowledged } : {}) };
    this.active.set(id, phase);
    phase.done = this.execute(input, sink, phase);
    return phase.done;
  }

  private async execute(input: RuntimeRequest, sink: StreamSink | undefined, phase: ActivePhase): Promise<RuntimeTurn> {
    const id = input.session.bridgeSessionId;
    const heartbeat = setInterval(() => sink?.activity?.(), 1_000);
    heartbeat.unref();
    try {
      if (!phase.lease) {
        phase.lease = await (this.options.acquireLease ?? ((request, signal) => acquireDesktopJobLease(this.options, request, signal)))(phase.request, phase.controller.signal);
        this.admissionDelays.push(Date.now() - phase.queuedAt);
        if (this.admissionDelays.length > RECENT_ADMISSIONS) this.admissionDelays.shift();
      }
      if (phase.heldHost) { phase.heldHost.lease = phase.lease; phase.heldHost.parked = false; }
      if (phase.controller.signal.aborted) throw failure("desktop_job_cancelled", "The queued Factory job was cancelled.");
      clearInterval(heartbeat);
      const turn = await this.inner.handle(input, sink);
      const cancelledCleanly = phase.cleanup ? await phase.cleanup : undefined;
      if (phase.unresolvedHostIds?.size) {
        await this.finishHeldHost(id, phase.heldHost ?? { request: phase.request, lease: phase.lease,
          pending: phase.unresolvedHostIds, usage: turn.response.usage, sdkSessionId: turn.sdkSessionId }, "unknown", cancelledCleanly === true);
        return turn;
      }
      if (!this.options.factoryNative && phase.request.workspacePolicy === "controller-host" && !phase.outcome) {
        const held: HeldHostPhase = phase.heldHost ?? { request: phase.request, lease: phase.lease, pending: new Set() };
        for (const callId of phase.acknowledgedHostIds ?? []) held.pending.delete(callId);
        for (const block of turn.response.content) {
          if (block.type === "tool_use" && typeof block.name === "string"
              && hostActionNeedsWorkspaceReservation(block.name, this.options.workerMcpPrefix)
              && typeof block.id === "string" && turn.pendingToolIds.includes(block.id)) held.pending.add(block.id);
        }
        held.usage = addUsage(held.usage, turn.response.usage);
        held.sdkSessionId = turn.sdkSessionId ?? held.sdkSessionId;
        if (held.pending.size) {
          this.heldHost.set(id, held);
          await phase.lease.release({ state: "waiting_host", usage: held.usage,
            sdkSessionId: held.sdkSessionId, cleanupVerified: false, hostActionReservation: true });
          phase.settlementVerified = true;
          held.parked = true;
          return turn;
        }
        this.heldHost.delete(id);
        await phase.lease.release({ state: turn.pendingToolIds.length ? "waiting_host" : "idle",
          usage: held.usage, sdkSessionId: held.sdkSessionId, cleanupVerified: false });
        phase.settlementVerified = true;
        return turn;
      }
      await phase.lease.release({ state: cancelledCleanly === false ? "unknown" : phase.outcome ?? (turn.pendingToolIds.length ? "waiting_host" : "idle"),
        usage: turn.response.usage, sdkSessionId: turn.sdkSessionId, cleanupVerified: cancelledCleanly === true });
      phase.settlementVerified = true;
      return turn;
    } catch (error) {
      // A refused lineage wrote no lease for this process. Later cleanup must
      // not try to update a lease that another controller generation owns.
      if (!phase.lease && phase.claimedIdentity && error instanceof BridgeError && error.extra.checkpoint_retained === true
          && this.known.get(id) === phase.request) this.known.delete(id);
      let cleanupVerified = !phase.lease;
      if (phase.lease) {
        const held = phase.heldHost ?? this.heldHost.get(id) ?? (phase.unresolvedHostIds?.size
          ? { request: phase.request, lease: phase.lease, pending: phase.unresolvedHostIds } : undefined);
        if (held?.pending.size) {
          // Cancelling Claude cannot establish whether a published Factory
          // command stopped. Retain its workspace independently of compute.
          let nativeCleanupVerified = false;
          try { await this.inner.cancel(id, "desktop-host-phase-failed"); nativeCleanupVerified = true; }
          catch { this.faults.push("native_cleanup_failed"); }
          await this.finishHeldHost(id, held, "unknown", nativeCleanupVerified);
          throw error;
        }
        try {
          if (phase.cleanup) cleanupVerified = await phase.cleanup;
          else { await this.inner.cancel(id, "desktop-job-phase-failed"); cleanupVerified = true; }
        }
        catch { this.faults.push("native_cleanup_failed"); }
        try {
          await phase.lease.release({ state: cleanupVerified ? (phase.outcome ?? "failed") : "unknown", cleanupVerified });
          phase.settlementVerified = true;
        }
        catch {
          this.faults.push("lease_cleanup_failed");
          if (cleanupVerified) {
            try {
              await this.update(id, { state: phase.outcome ?? "failed", cleanupVerified: true });
              phase.settlementVerified = true;
            }
            catch { this.faults.push("lease_recovery_failed"); }
          }
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (this.active.get(id) === phase) this.active.delete(id);
    }
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    await this.checkpointPreparations.get(sessionId)?.catch(() => undefined);
    const held = this.heldHost.get(sessionId);
    if (held && !this.active.has(sessionId)) {
      try { await this.inner.cancel(sessionId, reason); }
      catch (error) {
        await this.finishHeldHost(sessionId, held, "unknown", false);
        throw error;
      }
      await this.finishHeldHost(sessionId, held, held.pending.size ? "unknown" : "cancelled", true);
      if (held.pending.size) throw failure("desktop_host_cleanup_unknown", "The host action may still be running; its workspace remains reserved.");
      return;
    }
    const phase = this.active.get(sessionId);
    let cleanupError: unknown;
    const cleanup = Promise.resolve().then(() => {
      this.markUnresolvedHostAction(sessionId);
      return this.inner.cancel(sessionId, reason);
    }).then(() => true, (error: unknown) => { cleanupError = error; return false; });
    if (phase) { phase.outcome = "cancelled"; phase.cleanup = cleanup; phase.controller.abort(); }
    const cleanupVerified = await cleanup;
    if (phase?.done) await phase.done.catch(() => undefined);
    const unresolved = this.heldHost.get(sessionId);
    if (unresolved?.pending.size && !unresolved.uncertain) await this.finishHeldHost(sessionId, unresolved, "unknown", cleanupVerified);
    if (this.heldHost.get(sessionId)?.uncertain) {
      throw failure("desktop_host_cleanup_unknown", "The host action may still be running; its workspace remains reserved.");
    }
    await this.update(sessionId, { state: cleanupVerified ? "cancelled" : "unknown", cleanupVerified });
    if (!cleanupVerified) throw cleanupError;
  }

  async prepareColdRetry(sessionId: string): Promise<void> {
    if (this.active.has(sessionId) || this.heldHost.has(sessionId) || !this.inner.prepareColdRetry) {
      throw failure("desktop_retry_unsafe", "The native generation cannot be safely retired for retry.");
    }
    // The native runtime owns the cold-import safety decision and process proof.
    // Retain the old lease identity until its terminal record is acknowledged.
    await this.inner.prepareColdRetry(sessionId);
    await this.update(sessionId, { state: "failed", cleanupVerified: true });
    this.known.delete(sessionId);
  }

  prepareCheckpointRetry(sessionId: string, sdkSessionId: string): Promise<void> {
    if (this.closed || this.active.has(sessionId) || this.heldHost.has(sessionId) || this.checkpointPreparations.has(sessionId) || !this.inner.prepareCheckpointRetry) {
      return Promise.reject(failure("desktop_retry_unsafe", "The native checkpoint cannot be safely retired for retry."));
    }
    const preparation = (async () => {
      await this.inner.prepareCheckpointRetry!(sessionId, sdkSessionId);
      await this.update(sessionId, { state: "failed", sdkSessionId, cleanupVerified: true });
      this.known.delete(sessionId);
    })();
    this.checkpointPreparations.set(sessionId, preparation);
    return preparation.finally(() => { this.checkpointPreparations.delete(sessionId); });
  }

  /** This process has used the session's current lease identity and must keep it. */
  ownsNativeSession(sessionId: string): boolean {
    return this.active.has(sessionId) || this.heldHost.has(sessionId) || this.known.has(sessionId);
  }

  inspectNativeGenerations(request: NativeGenerationInspection): Promise<NativeGenerationEvidence[]> {
    return (this.options.inspectGenerations ?? (item => inspectDesktopJobGenerations(this.options, item)))(request);
  }

  private async update(id: string, result: DesktopJobRelease): Promise<void> {
    const request = this.known.get(id);
    if (!request) return;
    await (this.options.updateRecord ?? ((item, outcome) => updateDesktopJobRecord(this.options, item, outcome)))(request, result);
  }

  private async acknowledgeHostReceipt(id: string, toolUseId: string): Promise<void> {
    const held = this.heldHost.get(id);
    if (!held) return;
    held.pending.delete(toolUseId);
    if (!held.pending.size && !this.active.has(id)) {
      await this.update(id, { state: "waiting_host", cleanupVerified: false, hostActionReservation: false });
      this.heldHost.delete(id);
    }
  }

  private async finishHeldHost(id: string, held: HeldHostPhase, state: "unknown" | "completed" | "cancelled", nativeCleanupVerified = false): Promise<void> {
    const wasUncertain = held.uncertain === true;
    if (state === "unknown") {
      held.uncertain = true;
      this.heldHost.set(id, held);
    }
    const result = { state, usage: held.usage, sdkSessionId: held.sdkSessionId,
      cleanupVerified: state !== "unknown" || nativeCleanupVerified };
    const reservation = { ...result, hostActionReservation: state === "unknown" };
    if (held.parked || (wasUncertain && state !== "unknown")) await this.update(id, reservation);
    else await held.lease.release(reservation);
    held.parked = true;
    if (state === "unknown") {
      held.uncertain = true;
      this.heldHost.set(id, held);
      this.faults.push("host_action_cleanup_unproven");
    } else this.heldHost.delete(id);
  }

  private markUnresolvedHostAction(id: string): void {
    const phase = this.active.get(id);
    if (this.options.factoryNative || phase?.request.workspacePolicy !== "controller-host" || !phase.lease) return;
    const pending = (this.inner.pendingHostCalls?.(id) ?? [])
      .filter(call => hostActionNeedsWorkspaceReservation(call.toolName, this.options.workerMcpPrefix));
    if (pending.length) {
      phase.unresolvedHostIds = new Set(pending.map(call => call.toolUseId));
      phase.outcome = "unknown";
    }
  }

  describe(): Record<string, unknown> {
    const workerSlots = this.options.maxRunning ?? 2;
    const at = Date.now();
    const phases = [...this.active.values()];
    const queued = phases.filter((phase) => !phase.lease);
    const accounts: Record<string, Record<"controllerQueued" | "controllerRunning" | "workerQueued" | "workerRunning", number>> = {};
    for (const phase of phases) {
      const account = accounts[phase.request.subscriptionProfile ?? "factory-api"] ??= { controllerQueued: 0, controllerRunning: 0, workerQueued: 0, workerRunning: 0 };
      account[`${executionLane(phase.request)}${phase.lease ? "Running" : "Queued"}`]++;
    }
    const delays = [...this.admissionDelays].sort((left, right) => left - right);
    return { ...this.inner.describe?.(), desktopJobs: { activePhases: this.active.size,
      maxRunning: workerSlots + 1, workerSlots, controllerSlots: 1, faults: this.faults.slice(-32),
      heldHostActions: this.heldHost.size,
      queue: { queuedPhases: queued.length, runningPhases: phases.length - queued.length,
        oldestQueuedMs: queued.length ? Math.max(...queued.map((phase) => at - phase.queuedAt)) : null,
        recentAdmissions: { count: delays.length, medianDelayMs: delays.length ? delays[Math.floor(delays.length / 2)] : null, maxDelayMs: delays.at(-1) ?? null } },
      accounts,
      capacityScope: "this process's phases; the shared lease ledger report covers every service and the remaining provider allowance stays unknown",
      scope: "active model phases; host action workspace reservations do not occupy compute; parked native processes remain managed by the inner runtime" } };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.checkpointPreparations.values()]);
    const active = [...new Set([...this.active.keys(), ...this.heldHost.keys()])];
    const outcomes = await Promise.allSettled(active.map((id) => this.cancel(id, "desktop-supervisor-closed")));
    await this.inner.close?.();
    const inactive = [...this.known.keys()].filter((id) => !active.includes(id));
    outcomes.push(...await Promise.allSettled(inactive.map((id) => this.update(id, { state: "cancelled", cleanupVerified: true }))));
    if (outcomes.some((item) => item.status === "rejected")) throw failure("desktop_jobs_cleanup", "Some supervised Factory phases could not be closed cleanly.");
  }
}

function addUsage(previous: Usage | undefined, current: Usage): Usage {
  const value: Usage = { input_tokens: 0, output_tokens: 0 };
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    if (previous?.[key] !== undefined || current[key] !== undefined) value[key] = (previous?.[key] ?? 0) + (current[key] ?? 0);
  }
  return value;
}

type WireMessage = Record<string, unknown>;
class LeaseChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<string>;
  readonly exited: Promise<void>;
  private resolveReady!: (id: string) => void;
  private rejectReady!: (error: Error) => void;
  private resolveExit!: () => void;
  private rejectExit!: (error: Error) => void;
  private finalMessage = false;
  private releasePromise?: Promise<void>;
  private timer: NodeJS.Timeout;
  private buffer = "";
  private settled = false;
  private admitted = false;
  private deferring = false;
  private deferred = false;
  inspection?: unknown;

  constructor(options: DesktopLeaseOptions, first: WireMessage, private readonly signal?: AbortSignal) {
    if (!isAbsolute(options.pythonExecutable) || !isAbsolute(options.runtimePackagePath) || !isAbsolute(options.stateRoot)) throw new Error("Desktop supervisor paths must be absolute.");
    const packagePath = realpathSync(options.runtimePackagePath);
    if (!lstatSync(join(packagePath, "native_runtime/factory_lease.py")).isFile()) throw new Error("The installed desktop lease helper is unavailable.");
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.exited = new Promise((resolve, reject) => { this.resolveExit = resolve; this.rejectExit = reject; });
    // Update requests do not await ready; acquisition failures may precede release.
    void this.ready.catch(() => undefined);
    void this.exited.catch(() => undefined);
    this.child = spawn(options.pythonExecutable, ["-m", "native_runtime.factory_lease", "--state-root", options.stateRoot,
      "--max-running", String(options.maxRunning ?? 2)], { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", LC_ALL: "C",
        PYTHONPATH: packagePath, PYTHONDONTWRITEBYTECODE: "1" } });
    this.timer = setTimeout(() => this.deferAdmission(options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS), options.admissionTimeoutMs ?? 300_000);
    this.timer.unref();
    this.child.stdout.on("data", (data: Buffer) => this.consume(data));
    // Error diagnostics from the helper may contain paths; never relay raw text.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail("desktop_job_channel", "The Factory job control channel closed unexpectedly."));
    this.child.on("error", () => this.fail("desktop_job_spawn", "The Factory job helper could not start."));
    this.child.on("exit", (code) => {
      clearTimeout(this.timer);
      signal?.removeEventListener("abort", this.abort);
      if (this.settled) return;
      this.settled = true;
      if (code === 0 && this.finalMessage) {
        this.resolveExit();
        if (this.deferred) this.rejectReady(new BridgeError(503, "desktop_job_timeout",
          "The scheduler deferred this request before model execution. Retry the same continuation.",
          { retry_safe: true, phase: "admission" }));
      }
      else this.rejectExit(failure("desktop_job_channel", "The Factory job helper ended without a verified release."));
      this.rejectReady(failure(signal?.aborted ? "desktop_job_cancelled" : "desktop_job_channel", "The Factory job helper ended before admission."));
    });
    signal?.addEventListener("abort", this.abort, { once: true });
    this.send(first);
    if (signal?.aborted) this.abort();
  }

  private abort = (): void => { if (!this.admitted) this.send({ op: "cancel" }); };
  private send(value: WireMessage): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private consume(data: Buffer): void {
    this.buffer += data.toString("utf8");
    if (this.buffer.length > 65_536) { this.fail("desktop_job_protocol", "Invalid Factory job helper response."); return; }
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let message: WireMessage;
      try { message = JSON.parse(line); } catch { this.fail("desktop_job_protocol", "Invalid Factory job helper response."); return; }
      if (message?.ok === false && message.error === "factory_lease_refused"
          && ["invalid_workspace", "invalid_binding"].includes(String(message.code))) {
        this.fail(message.code === "invalid_workspace" ? "desktop_job_workspace" : "desktop_job_binding",
          message.code === "invalid_workspace" ? "The selected workspace does not meet this execution policy. Choose a valid owned folder or Git workspace."
            : "The selected workspace policy, account or session binding is invalid.",
          message.code === "invalid_workspace" ? 422 : 400);
        return;
      }
      if (message?.ok === false && message.error === "factory_lease_refused" && message.code === "native_generation"
          && (NATIVE_GENERATION_REFUSALS as readonly string[]).includes(String(message.reason))) {
        this.fail("native_generation_refused", "This Workstream's native lease generation is unavailable to this controller. Nothing ran and its checkpoint was retained.",
          409, { phase: "admission", checkpoint_retained: true, reason: String(message.reason) });
        return;
      }
      if (!message || message.ok !== true || typeof message.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(message.jobId)) {
        this.fail("desktop_job_protocol", "The Factory job helper refused the operation."); return;
      }
      if (message.event === "ready") {
        clearTimeout(this.timer);
        if (this.deferring) continue;
        if (this.signal?.aborted) this.abort();
        else {
          this.admitted = true;
          this.signal?.removeEventListener("abort", this.abort);
          this.resolveReady(message.jobId);
        }
      } else if (message.event === "deferred" && this.deferring) {
        this.deferred = true;
        this.finalMessage = true;
      } else if (message.event === "released" || message.event === "updated" || message.event === "cancelled") this.finalMessage = true;
      else if (message.event === "inspected") { this.inspection = message.generations; this.finalMessage = true; }
      else if (message.event !== "queued") this.fail("desktop_job_protocol", "Invalid Factory job helper response.");
    }
  }
  private deferAdmission(timeoutMs: number): void {
    if (this.settled || this.admitted) return;
    this.deferring = true;
    this.send({ op: "defer" });
    this.timer = setTimeout(() => this.fail("desktop_job_timeout",
      "The scheduler admission deadline elapsed without a confirmed deferral."), timeoutMs);
    this.timer.unref();
  }
  private fail(code: string, message: string, status = 503, extra: Record<string, string | boolean> = {}): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.abort);
    const error = new BridgeError(status, code, message, extra);
    this.rejectReady(error); this.rejectExit(error);
    // Only this child is signalled. Its EOF policy records uncertain ownership.
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  release(result: DesktopJobRelease, timeoutMs: number): Promise<void> {
    if (!this.releasePromise) {
      this.timer = setTimeout(() => this.fail("desktop_job_release", "Factory job release could not be verified."), timeoutMs);
      this.timer.unref();
      this.send({ op: "release", ...safeRelease(result) });
      this.releasePromise = this.exited;
    }
    return this.releasePromise;
  }
}

function safeRelease(result: DesktopJobRelease): WireMessage {
  const usage: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const value = result.usage?.[key];
    if (Number.isSafeInteger(value) && value! >= 0) usage[key] = value!;
  }
  return { state: result.state, cleanupVerified: result.cleanupVerified === true,
    ...(result.hostActionReservation === undefined ? {} : { hostActionReservation: result.hostActionReservation }),
    ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
}

export async function acquireDesktopJobLease(options: DesktopLeaseOptions, request: DesktopJobAcquire, signal: AbortSignal): Promise<DesktopJobLease> {
  const channel = new LeaseChannel(options, { op: "acquire", ...safeAcquire(request) }, signal);
  const jobId = await channel.ready;
  return { jobId, release: (result) => channel.release(result, options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS) };
}

export async function updateDesktopJobRecord(options: DesktopLeaseOptions, request: DesktopJobAcquire, result: DesktopJobRelease): Promise<void> {
  const channel = new LeaseChannel({ ...options, admissionTimeoutMs: options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS }, { op: "update", ...safeAcquire(request, false), ...safeRelease(result) });
  await channel.exited;
}

/** Read-only lease lineage for one bridge conversation. */
export async function inspectDesktopJobGenerations(options: DesktopLeaseOptions, request: NativeGenerationInspection): Promise<NativeGenerationEvidence[]> {
  validateSubscriptionProfile(request.subscriptionProfile);
  const recordedPolicy = request.useRecordedWorkspacePolicy === true;
  if (!request.subscriptionProfile || !/:g(?:0|[1-9]\d{0,6})$/.test(request.bridgeSessionId)
      || (request.useRecordedWorkspacePolicy !== undefined && typeof request.useRecordedWorkspacePolicy !== "boolean")
      || (recordedPolicy ? request.workspacePolicy !== undefined : !request.workspacePolicy)) {
    throw new BridgeError(400, "desktop_job_binding", "Lease inspection requires a subscription generation identity.");
  }
  if (!recordedPolicy) validateWorkspacePolicy(request.workspacePolicy, request.subscriptionProfile);
  const channel = new LeaseChannel({ ...options, admissionTimeoutMs: options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS }, { op: "inspect",
    factorySessionId: request.factorySessionId, bridgeSessionId: request.bridgeSessionId, cwd: request.cwd,
    subscriptionProfile: request.subscriptionProfile,
    ...(recordedPolicy ? { useRecordedWorkspacePolicy: true } : { workspacePolicy: request.workspacePolicy }),
    ...(request.sdkSessionId === undefined ? {} : { sdkSessionId: request.sdkSessionId }) });
  await channel.exited;
  const value = channel.inspection;
  if (!Array.isArray(value) || value.length > 64 || !value.every(isGenerationEvidence)) {
    throw failure("desktop_job_protocol", "Invalid Factory job helper response.");
  }
  return value.map(item => ({ ...item }));
}

function isGenerationEvidence(value: unknown): value is NativeGenerationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Number.isSafeInteger(item.generation) && (item.generation as number) >= 0 && (item.generation as number) <= 1_000_000
    && typeof item.state === "string" && item.state.length <= 64
    && ["externalCleanupRequired", "hostActionReservation", "ownerAlive", "supervisorAlive", "cleanupVerified", "bindingMatches"]
      .every(key => typeof item[key] === "boolean")
    && (item.checkpointMatches === null || typeof item.checkpointMatches === "boolean")
    && (item.endedAt === null || (typeof item.endedAt === "string" && item.endedAt.length <= 64))
    && ["session_update", "phase_release", "other"].includes(String(item.endedBy));
}

function validateSubscriptionProfile(profile: unknown): void {
  if (profile !== undefined && (typeof profile !== "string" || !(SUBSCRIPTION_PROFILES as readonly string[]).includes(profile))) {
    throw new BridgeError(400, "desktop_job_profile", "Only fixed team1 through team8 subscription profiles are supported.");
  }
}

function validateWorkspacePolicy(policy: unknown, profile: unknown, role?: unknown): void {
  if (policy !== undefined && (!["controller-readonly", "controller-host", "factory-native"].includes(String(policy))
      || !(SUBSCRIPTION_PROFILES as readonly string[]).includes(String(profile))
      || (policy === "factory-native"
        ? role !== undefined && !["chat", "orchestrator", "worker", "validator"].includes(String(role))
        : role === "worker" || role === "validator"
          || (policy === "controller-host" && role !== undefined && role !== "chat" && role !== "orchestrator")))) {
    throw new BridgeError(400, "desktop_workspace_policy", "Directory policies require an explicitly configured subscription controller.");
  }
}

function safeAcquire(request: DesktopJobAcquire, resume = true): WireMessage {
  validateSubscriptionProfile(request.subscriptionProfile);
  validateWorkspacePolicy(request.workspacePolicy, request.subscriptionProfile, request.role);
  return { factorySessionId: request.factorySessionId, bridgeSessionId: request.bridgeSessionId,
    cwd: request.cwd, role: request.role,
    ...(request.subscriptionProfile === undefined ? {} : { subscriptionProfile: request.subscriptionProfile }),
    ...(request.workspacePolicy === undefined ? {} : { workspacePolicy: request.workspacePolicy }),
    ...(resume && request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}) };
}
