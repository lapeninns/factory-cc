import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BridgeError, type Usage } from "../types.js";
import type { BridgeRuntime, RetiredSession, RuntimeControl, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";

/** Values supplied by the authenticated host controller, never request metadata. */
export const SUBSCRIPTION_PROFILES = ["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"] as const;
export type SubscriptionProfile = typeof SUBSCRIPTION_PROFILES[number];
export type DesktopWorkspacePolicy = "controller-readonly";
export interface DesktopJobBinding { sessionId: string; cwd: string; launchId?: string; subscriptionProfile?: SubscriptionProfile; workspacePolicy?: DesktopWorkspacePolicy }
export type DesktopJobState = "waiting_host" | "idle" | "completed" | "failed" | "cancelled" | "unknown";
export interface DesktopJobRelease {
  state: DesktopJobState;
  usage?: Usage;
  sdkSessionId?: string;
  /** Applies to tracked runtime processes, not arbitrary daemonisation. */
  cleanupVerified?: boolean;
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
}
export interface DesktopJobLease { jobId: string; release(result: DesktopJobRelease): Promise<void> }
export interface DesktopLeaseOptions {
  pythonExecutable: string;
  runtimePackagePath: string;
  stateRoot: string;
  maxRunning?: number;
  admissionTimeoutMs?: number;
  releaseTimeoutMs?: number;
}
export interface DesktopJobsOptions extends DesktopLeaseOptions {
  getBinding(input: RuntimeRequest): DesktopJobBinding | undefined;
  acquireLease?(request: DesktopJobAcquire, signal: AbortSignal): Promise<DesktopJobLease>;
  updateRecord?(request: DesktopJobAcquire, result: DesktopJobRelease): Promise<void>;
}

interface ActivePhase {
  controller: AbortController;
  request: DesktopJobAcquire;
  lease?: DesktopJobLease;
  outcome?: DesktopJobState;
  done?: Promise<RuntimeTurn>;
  cleanup?: Promise<boolean>;
}

function failure(code: string, message: string): BridgeError { return new BridgeError(503, code, message); }

export function validateDesktopJobBinding(binding: DesktopJobBinding | undefined): DesktopJobBinding {
  if (!binding || !binding.sessionId || binding.sessionId.length > 256 || !isAbsolute(binding.cwd)) {
    throw failure("desktop_job_binding", "This model requires an authenticated Factory session and its assigned worktree.");
  }
  validateSubscriptionProfile(binding.subscriptionProfile);
  validateWorkspacePolicy(binding.workspacePolicy, binding.subscriptionProfile);
  try {
    const cwd = realpathSync(binding.cwd);
    const directory = lstatSync(cwd);
    const git = lstatSync(join(cwd, ".git"));
    const markerAllowed = git.isFile() || (binding.workspacePolicy === "controller-readonly" && git.isDirectory());
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || !markerAllowed || git.isSymbolicLink()
        || git.uid !== process.getuid?.()) throw new Error();
    return { ...binding, cwd };
  } catch {
    throw failure("desktop_job_workspace", "Open this Factory session in a dedicated Git worktree before using the supervised model.");
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
  private readonly faults: string[] = [];
  private closed = false;
  readonly interrupt?: BridgeRuntime["interrupt"];
  readonly pendingHostCalls?: BridgeRuntime["pendingHostCalls"];
  readonly completeHostTool?: BridgeRuntime["completeHostTool"];
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
      return inner.interrupt!(sessionId, reason);
    };
    if (inner.pendingHostCalls) this.pendingHostCalls = (id) => inner.pendingHostCalls!(id);
    if (inner.completeHostTool) this.completeHostTool = async (id, completion) => {
      const result = await inner.completeHostTool!(id, completion);
      if (completion.terminal) {
        await this.active.get(id)?.done?.catch(() => undefined);
        await this.update(id, { state: "completed", cleanupVerified: false });
      }
      return result;
    };
    if (inner.endHostSession) this.endHostSession = async (id, reason): Promise<RuntimeHostEnd> => {
      const result = await inner.endHostSession!(id, reason);
      await this.active.get(id)?.done?.catch(() => undefined);
      if (!result.resumable) await this.update(id, { state: "completed", sdkSessionId: result.sdkSessionId, cleanupVerified: true });
      return result;
    };
    if (inner.protectedSessionIds) this.protectedSessionIds = () => inner.protectedSessionIds!();
    if (inner.isSessionUsable) this.isSessionUsable = (id) => inner.isSessionUsable!(id);
    if (inner.forget) this.forget = async (session: RetiredSession) => {
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
    const id = input.session.bridgeSessionId;
    if (this.active.has(id)) return Promise.reject(new BridgeError(409, "desktop_job_busy", "This Factory model phase is already running."));
    const request: DesktopJobAcquire = { factorySessionId: binding.sessionId, bridgeSessionId: id, cwd: binding.cwd, role: input.role,
      ...(binding.subscriptionProfile === undefined ? {} : { subscriptionProfile: binding.subscriptionProfile }),
      ...(binding.workspacePolicy === undefined ? {} : { workspacePolicy: binding.workspacePolicy }) };
    try { validateWorkspacePolicy(request.workspacePolicy, request.subscriptionProfile, request.role); }
    catch (error) { return Promise.reject(error); }
    const known = this.known.get(id);
    if (known && (known.cwd !== request.cwd || known.factorySessionId !== request.factorySessionId
                  || known.subscriptionProfile !== request.subscriptionProfile || known.workspacePolicy !== request.workspacePolicy)) {
      return Promise.reject(new BridgeError(409, "desktop_job_identity", "This native session is already bound to another Factory session or worktree."));
    }
    this.known.set(id, request);
    const phase: ActivePhase = { controller: new AbortController(), request };
    this.active.set(id, phase);
    phase.done = this.execute(input, sink, phase);
    return phase.done;
  }

  private async execute(input: RuntimeRequest, sink: StreamSink | undefined, phase: ActivePhase): Promise<RuntimeTurn> {
    const id = input.session.bridgeSessionId;
    const heartbeat = setInterval(() => sink?.activity?.(), 1_000);
    heartbeat.unref();
    try {
      phase.lease = await (this.options.acquireLease ?? ((request, signal) => acquireDesktopJobLease(this.options, request, signal)))(phase.request, phase.controller.signal);
      if (phase.controller.signal.aborted) throw failure("desktop_job_cancelled", "The queued Factory job was cancelled.");
      clearInterval(heartbeat);
      const turn = await this.inner.handle(input, sink);
      const cancelledCleanly = phase.cleanup ? await phase.cleanup : undefined;
      await phase.lease.release({ state: cancelledCleanly === false ? "unknown" : phase.outcome ?? (turn.pendingToolIds.length ? "waiting_host" : "idle"),
        usage: turn.response.usage, sdkSessionId: turn.sdkSessionId, cleanupVerified: cancelledCleanly === true });
      return turn;
    } catch (error) {
      let cleanupVerified = !phase.lease;
      if (phase.lease) {
        try {
          if (phase.cleanup) cleanupVerified = await phase.cleanup;
          else { await this.inner.cancel(id, "desktop-job-phase-failed"); cleanupVerified = true; }
        }
        catch { this.faults.push("native_cleanup_failed"); }
        try { await phase.lease.release({ state: cleanupVerified ? (phase.outcome ?? "failed") : "unknown", cleanupVerified }); }
        catch {
          this.faults.push("lease_cleanup_failed");
          if (cleanupVerified) {
            try { await this.update(id, { state: phase.outcome ?? "failed", cleanupVerified: true }); }
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
    const phase = this.active.get(sessionId);
    let cleanupError: unknown;
    const cleanup = Promise.resolve().then(() => this.inner.cancel(sessionId, reason)).then(() => true, (error: unknown) => { cleanupError = error; return false; });
    if (phase) { phase.outcome = "cancelled"; phase.cleanup = cleanup; phase.controller.abort(); }
    const cleanupVerified = await cleanup;
    if (phase?.done) await phase.done.catch(() => undefined);
    await this.update(sessionId, { state: cleanupVerified ? "cancelled" : "unknown", cleanupVerified });
    if (!cleanupVerified) throw cleanupError;
  }

  private async update(id: string, result: DesktopJobRelease): Promise<void> {
    const request = this.known.get(id);
    if (!request) return;
    await (this.options.updateRecord ?? ((item, outcome) => updateDesktopJobRecord(this.options, item, outcome)))(request, result);
  }

  describe(): Record<string, unknown> {
    return { ...this.inner.describe?.(), desktopJobs: { activePhases: this.active.size,
      maxRunning: this.options.maxRunning ?? 2, faults: this.faults.slice(-32),
      scope: "active model phases; parked native sessions remain managed by the inner runtime" } };
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.active.keys()];
    const outcomes = await Promise.allSettled(active.map((id) => this.cancel(id, "desktop-supervisor-closed")));
    await this.inner.close?.();
    const inactive = [...this.known.keys()].filter((id) => !active.includes(id));
    outcomes.push(...await Promise.allSettled(inactive.map((id) => this.update(id, { state: "cancelled", cleanupVerified: true }))));
    if (outcomes.some((item) => item.status === "rejected")) throw failure("desktop_jobs_cleanup", "Some supervised Factory phases could not be closed cleanly.");
  }
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
    this.timer = setTimeout(() => this.fail("desktop_job_timeout", "The Factory job admission timed out."), options.admissionTimeoutMs ?? 300_000);
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
      if (code === 0 && this.finalMessage) this.resolveExit();
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
      if (!message || message.ok !== true || typeof message.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(message.jobId)) {
        this.fail("desktop_job_protocol", "The Factory job helper refused the operation."); return;
      }
      if (message.event === "ready") {
        clearTimeout(this.timer);
        if (this.signal?.aborted) this.abort();
        else {
          this.admitted = true;
          this.signal?.removeEventListener("abort", this.abort);
          this.resolveReady(message.jobId);
        }
      } else if (message.event === "released" || message.event === "updated" || message.event === "cancelled") this.finalMessage = true;
      else if (message.event !== "queued") this.fail("desktop_job_protocol", "Invalid Factory job helper response.");
    }
  }
  private fail(code: string, message: string): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.abort);
    const error = failure(code, message);
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
    ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
}

export async function acquireDesktopJobLease(options: DesktopLeaseOptions, request: DesktopJobAcquire, signal: AbortSignal): Promise<DesktopJobLease> {
  const channel = new LeaseChannel(options, { op: "acquire", ...safeAcquire(request) }, signal);
  const jobId = await channel.ready;
  return { jobId, release: (result) => channel.release(result, options.releaseTimeoutMs ?? 5_000) };
}

export async function updateDesktopJobRecord(options: DesktopLeaseOptions, request: DesktopJobAcquire, result: DesktopJobRelease): Promise<void> {
  const channel = new LeaseChannel({ ...options, admissionTimeoutMs: options.releaseTimeoutMs ?? 5_000 }, { op: "update", ...safeAcquire(request), ...safeRelease(result) });
  await channel.exited;
}

function validateSubscriptionProfile(profile: unknown): void {
  if (profile !== undefined && (typeof profile !== "string" || !(SUBSCRIPTION_PROFILES as readonly string[]).includes(profile))) {
    throw new BridgeError(400, "desktop_job_profile", "Only fixed team1 through team8 subscription profiles are supported.");
  }
}

function validateWorkspacePolicy(policy: unknown, profile: unknown, role?: unknown): void {
  if (policy !== undefined && (policy !== "controller-readonly" || !(SUBSCRIPTION_PROFILES as readonly string[]).includes(String(profile))
      || role === "worker" || role === "validator")) {
    throw new BridgeError(400, "desktop_workspace_policy", "Primary checkout access requires the fixed-seat read-only controller policy.");
  }
}

function safeAcquire(request: DesktopJobAcquire): WireMessage {
  validateSubscriptionProfile(request.subscriptionProfile);
  validateWorkspacePolicy(request.workspacePolicy, request.subscriptionProfile, request.role);
  return { factorySessionId: request.factorySessionId, bridgeSessionId: request.bridgeSessionId,
    cwd: request.cwd, role: request.role,
    ...(request.subscriptionProfile === undefined ? {} : { subscriptionProfile: request.subscriptionProfile }),
    ...(request.workspacePolicy === undefined ? {} : { workspacePolicy: request.workspacePolicy }) };
}
