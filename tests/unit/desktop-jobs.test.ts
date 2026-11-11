import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopJobsRuntime, SUBSCRIPTION_PROFILES, acquireDesktopJobLease, updateDesktopJobRecord, validateDesktopJobBinding, type DesktopJobAcquire, type DesktopJobBinding, type DesktopJobLease, type DesktopJobsOptions } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime, RuntimeHostCall, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-jobs-")));
  roots.push(root);
  const cwd = join(root, "worktree"); mkdirSync(cwd); writeFileSync(join(cwd, ".git"), "gitdir: /fixture/git/worktrees/test\n");
  return { root, cwd };
}
function request(id = "bridge-1"): RuntimeRequest {
  return { role: "worker", headers: {}, request: { model: "opus", max_tokens: 10, messages: [{ role: "user", content: "private prompt" }] },
    session: { bridgeSessionId: id, role: "worker", state: "GENERATING", model: "opus", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: false } } };
}
function turn(pendingToolIds: string[] = []): RuntimeTurn {
  return { response: { id: "message-1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
    stop_reason: pendingToolIds.length ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 3 } },
  pendingToolIds, sdkSessionId: "ff9b0b64-17cd-4694-8c50-16bb85c6276e" };
}
function setup() {
  const { root, cwd } = workspace();
  const binding: DesktopJobBinding = { sessionId: "factory-1", cwd };
  const releases = vi.fn(async () => undefined);
  const acquire = vi.fn(async (): Promise<DesktopJobLease> => ({ jobId: "job-1", release: releases }));
  const update = vi.fn(async () => undefined);
  const inner = { kind: "sdk" as const, handle: vi.fn(async () => turn()), cancel: vi.fn(async () => undefined),
    deliverResults: vi.fn(async () => ["accepted" as const]), setControl: vi.fn(),
    interrupt: vi.fn(async () => true), pendingHostCalls: vi.fn((): RuntimeHostCall[] => []),
    completeHostTool: vi.fn(async () => "accepted" as const),
    endHostSession: vi.fn(async () => ({ resumable: true, sdkSessionId: "sdk-checkpoint" })),
    describe: vi.fn(() => ({ native: true })), close: vi.fn(async () => undefined),
    protectedSessionIds: vi.fn(() => ["bridge-1"]), isSessionUsable: vi.fn(() => true), forget: vi.fn(async () => undefined) };
  const options: DesktopJobsOptions = { pythonExecutable: "/usr/bin/python3", runtimePackagePath: root, stateRoot: join(root, "state"),
    getBinding: () => binding, acquireLease: acquire, updateRecord: update };
  return { root, cwd, binding, releases, acquire, update, inner, options, runtime: new DesktopJobsRuntime(inner, options) };
}

describe("Factory model-phase supervision", () => {
  it("retains lease ownership until checkpoint retry cleanup is acknowledged", async () => {
    const fixture = setup();
    const prepare = vi.fn(async () => undefined);
    (fixture.inner as BridgeRuntime).prepareCheckpointRetry = prepare;
    await fixture.runtime.handle(request());
    fixture.update.mockRejectedValueOnce(new Error("lease update failed"));
    await expect(fixture.runtime.prepareCheckpointRetry("bridge-1", "sdk")).rejects.toThrow("lease update failed");
    expect(fixture.runtime.ownsNativeSession("bridge-1")).toBe(true);
    await fixture.runtime.prepareCheckpointRetry("bridge-1", "sdk");
    expect(fixture.runtime.ownsNativeSession("bridge-1")).toBe(false);
    expect(prepare).toHaveBeenCalledWith("bridge-1", "sdk");
    expect(fixture.update).toHaveBeenLastCalledWith(expect.any(Object), { state: "failed", sdkSessionId: "sdk", cleanupVerified: true });
  });

  it("serializes shutdown behind checkpoint retry settlement", async () => {
    const fixture = setup(), acknowledged = deferred<undefined>();
    (fixture.inner as BridgeRuntime).prepareCheckpointRetry = vi.fn(async () => undefined);
    await fixture.runtime.handle(request());
    fixture.update.mockImplementationOnce(async () => acknowledged.promise);
    const preparing = fixture.runtime.prepareCheckpointRetry("bridge-1", "sdk");
    await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledTimes(1));
    const closing = fixture.runtime.close();
    expect(fixture.inner.close).not.toHaveBeenCalled();
    acknowledged.resolve(undefined);
    await preparing; await closing;
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.update).toHaveBeenCalledWith(expect.any(Object), { state: "failed", sdkSessionId: "sdk", cleanupVerified: true });
  });

  it("settles a clean interrupted native phase as idle before permitting its next admission", async () => {
    const fixture = setup();
    const running = deferred<RuntimeTurn>();
    fixture.inner.handle.mockImplementationOnce(() => running.promise);
    fixture.inner.interrupt.mockImplementationOnce(async () => {
      running.reject(new Error("clean native interruption"));
      await Promise.resolve();
      return true;
    });
    const pending = fixture.runtime.handle(request());
    const observed = pending.catch(() => undefined);
    await vi.waitFor(() => expect(fixture.inner.handle).toHaveBeenCalled());
    expect(await fixture.runtime.interrupt!("bridge-1", "client-disconnect")).toBe(true);
    await observed;
    expect(fixture.inner.cancel).not.toHaveBeenCalled();
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "idle", cleanupVerified: true }));
    await expect(fixture.runtime.handle(request())).resolves.toMatchObject({ pendingToolIds: [] });
  });

  it.each([true, false])("requires acknowledged native lease settlement after interrupt, fallback succeeds=%s", async fallbackSucceeds => {
    const fixture = setup(), running = deferred<RuntimeTurn>();
    fixture.inner.handle.mockImplementationOnce(() => running.promise);
    fixture.releases.mockRejectedValue(new Error("release did not persist"));
    if (!fallbackSucceeds) fixture.update.mockRejectedValue(new Error("fallback did not persist"));
    fixture.inner.interrupt.mockImplementationOnce(async () => {
      running.reject(new Error("clean native interruption"));
      return true;
    });
    const pending = fixture.runtime.handle(request()).catch(() => undefined);
    await vi.waitFor(() => expect(fixture.inner.handle).toHaveBeenCalled());
    expect(await fixture.runtime.interrupt!("bridge-1", "client-disconnect")).toBe(fallbackSucceeds);
    await pending;
    expect(fixture.update).toHaveBeenCalledWith(expect.any(Object), { state: "idle", cleanupVerified: true });
  });

  it("refuses missing trusted identity and a main checkout before model execution", async () => {
    const fixture = setup();
    fixture.options.getBinding = () => undefined;
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_binding" });
    fixture.options.getBinding = () => fixture.binding;
    rmSync(join(fixture.cwd, ".git")); mkdirSync(join(fixture.cwd, ".git"));
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_workspace" });
    expect(fixture.inner.handle).not.toHaveBeenCalled(); expect(fixture.acquire).not.toHaveBeenCalled();
  });

  it("refuses native workspace admission without the model-only runtime policy", async () => {
    const fixture = setup();
    fixture.binding.workspacePolicy = "factory-native";
    fixture.binding.subscriptionProfile = "team1";
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_workspace_policy" });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.inner.handle).not.toHaveBeenCalled();
  });

  it("preserves Factory request/tools and releases active inference capacity while waiting for host tools", async () => {
    const fixture = setup(); fixture.inner.handle.mockResolvedValueOnce(turn(["tool-1"]));
    const input = request(), sink = { textDelta: vi.fn(), toolTrace: vi.fn() };
    await fixture.runtime.handle(input, sink);
    expect(fixture.acquire).toHaveBeenCalledWith({ factorySessionId: "factory-1", bridgeSessionId: "bridge-1", cwd: fixture.cwd, role: "worker" }, expect.any(AbortSignal));
    expect(fixture.inner.handle).toHaveBeenCalledWith(input, sink);
    expect(fixture.releases).toHaveBeenCalledWith({ state: "waiting_host", usage: turn().response.usage,
      sdkSessionId: turn().sdkSessionId, cleanupVerified: false });
    await fixture.runtime.handle(input);
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
    expect(fixture.releases).toHaveBeenLastCalledWith(expect.objectContaining({ state: "idle" }));
  });

  it("binds a native session permanently to its Factory identity and workspace", async () => {
    const fixture = setup(); await fixture.runtime.handle(request());
    fixture.binding.sessionId = "other-factory";
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_identity" });
    expect(fixture.inner.handle).toHaveBeenCalledTimes(1);
  });

  it.each(SUBSCRIPTION_PROFILES)("binds %s and refuses a later seat change", async (profile) => {
    const fixture = setup(); fixture.binding.subscriptionProfile = profile;
    await fixture.runtime.handle(request());
    expect(fixture.acquire).toHaveBeenCalledWith(expect.objectContaining({ subscriptionProfile: profile }), expect.any(AbortSignal));
    fixture.binding.subscriptionProfile = profile === "team1" ? "team2" : "team1";
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_identity" });
    expect(fixture.inner.handle).toHaveBeenCalledTimes(1);
  });

  it("heartbeats while queued and starts no native work until admitted", async () => {
    vi.useFakeTimers(); const fixture = setup(); const gate = deferred<DesktopJobLease>();
    fixture.options.acquireLease = () => gate.promise;
    const activity = vi.fn(), running = fixture.runtime.handle(request(), { activity, textDelta() {}, toolTrace() {} });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(activity).toHaveBeenCalledTimes(2); expect(fixture.inner.handle).not.toHaveBeenCalled();
    gate.resolve({ jobId: "job-1", release: fixture.releases }); await running;
    await vi.advanceTimersByTimeAsync(2_100); expect(activity).toHaveBeenCalledTimes(2);
  });

  it("cancels queued admission without invoking native handle", async () => {
    const fixture = setup();
    fixture.options.acquireLease = (_item, signal) => new Promise((_yes, no) => signal.addEventListener("abort", () => no(new Error("cancelled")), { once: true }));
    const running = fixture.runtime.handle(request()); const observed = running.catch(() => undefined);
    await fixture.runtime.cancel("bridge-1", "user-cancelled"); await observed;
    expect(fixture.inner.handle).not.toHaveBeenCalled();
    expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ bridgeSessionId: "bridge-1" }), { state: "cancelled", cleanupVerified: true });
  });

  it("waits for native cancellation cleanup before releasing an admitted phase", async () => {
    const fixture = setup(), completion = deferred<RuntimeTurn>(), cleanup = deferred<undefined>();
    fixture.inner.handle.mockImplementation(() => completion.promise);
    fixture.inner.cancel.mockImplementation(() => cleanup.promise);
    const running = fixture.runtime.handle(request()); await Promise.resolve(); await Promise.resolve();
    const cancellation = fixture.runtime.cancel("bridge-1", "user"); completion.resolve(turn());
    await Promise.resolve(); await Promise.resolve(); expect(fixture.releases).not.toHaveBeenCalled();
    cleanup.resolve(undefined); await Promise.all([running, cancellation]);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled", cleanupVerified: true }));
  });

  it("reports queued and running phases per account and lane with recent admission delay", async () => {
    vi.useFakeTimers(); const fixture = setup(); const gate = deferred<DesktopJobLease>();
    fixture.options.acquireLease = () => gate.promise;
    fixture.binding.subscriptionProfile = "team3";
    const running = fixture.runtime.handle(request());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { maxRunning: 3, workerSlots: 2, controllerSlots: 1,
      queue: { queuedPhases: 1, runningPhases: 0, oldestQueuedMs: 1_500, recentAdmissions: { count: 0, medianDelayMs: null, maxDelayMs: null } },
      accounts: { team3: { workerQueued: 1, workerRunning: 0, controllerQueued: 0, controllerRunning: 0 } } } });
    gate.resolve({ jobId: "job-1", release: fixture.releases }); await running;
    const status = fixture.runtime.describe() as { desktopJobs: Record<string, unknown> };
    expect(status.desktopJobs).toMatchObject({ queue: { queuedPhases: 0, runningPhases: 0, oldestQueuedMs: null,
      recentAdmissions: { count: 1, medianDelayMs: 1_500, maxDelayMs: 1_500 } }, accounts: {} });
    expect(JSON.stringify(status)).not.toContain("private prompt");
  });

  it("records uncertain cleanup and does not claim native error cleanup succeeded", async () => {
    const fixture = setup(); fixture.inner.handle.mockRejectedValue(new Error("upstream failure"));
    fixture.inner.cancel.mockRejectedValue(new Error("cleanup failure"));
    await expect(fixture.runtime.handle(request())).rejects.toThrow("upstream failure");
    expect(fixture.releases).toHaveBeenCalledWith({ state: "unknown", cleanupVerified: false });
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { faults: ["native_cleanup_failed"] } });
  });

  it("rejects overlapping requests but permits independent sessions", async () => {
    const fixture = setup(), done = deferred<RuntimeTurn>(); fixture.inner.handle.mockImplementation(() => done.promise);
    const first = fixture.runtime.handle(request());
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_busy" });
    const second = fixture.runtime.handle(request("bridge-2"));
    done.resolve(turn()); await Promise.all([first, second]);
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
  });

  it("forwards control, delivery, resume helpers and end-of-host observations", async () => {
    const fixture = setup(), control = { requestApproval: vi.fn() };
    fixture.runtime.setControl(control);
    expect(fixture.inner.setControl).toHaveBeenCalledWith(control);
    const results = [{ tool_use_id: "tool-1", content: "private tool data" }];
    await fixture.runtime.deliverResults("bridge-1", results);
    expect(fixture.inner.deliverResults).toHaveBeenCalledWith("bridge-1", results);
    expect(fixture.runtime.protectedSessionIds?.()).toEqual(["bridge-1"]);
    expect(fixture.runtime.isSessionUsable?.("bridge-1")).toBe(true);
    await fixture.runtime.handle(request());
    expect(await fixture.runtime.endHostSession?.("bridge-1", "end")).toEqual({ resumable: true, sdkSessionId: "sdk-checkpoint" });
    expect(fixture.update).not.toHaveBeenCalled();
    await fixture.runtime.close(); expect(fixture.inner.close).toHaveBeenCalled();
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_jobs_closed" });
  });
});

describe("explicit host-directory controllers", () => {
  function hostFixture() {
    const value = setup();
    rmSync(join(value.cwd, ".git"));
    value.binding.subscriptionProfile = "team1";
    value.binding.workspacePolicy = "controller-host";
    value.binding.nativeGeneration = 0;
    const input = request(); input.role = "orchestrator"; input.session.role = "orchestrator";
    return { ...value, input };
  }
  function hostTurn(id = "host-1", name = "Execute"): RuntimeTurn {
    const value = turn([id]);
    value.response.content = [{ type: "tool_use", id, name, input: { command: "df -h" } }];
    return value;
  }
  function withResult(input: RuntimeRequest, id = "host-1"): RuntimeRequest {
    return { ...input, request: { ...input.request, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] }] } };
  }

  it("admits ordinary owned folders only under the explicit host policy and retains generation binding", async () => {
    const fixture = hostFixture();
    expect(validateDesktopJobBinding(fixture.binding).cwd).toBe(fixture.cwd);
    await fixture.runtime.handle(fixture.input);
    expect(fixture.acquire).toHaveBeenCalledWith(expect.objectContaining({ bridgeSessionId: "bridge-1:g0", workspacePolicy: "controller-host", subscriptionProfile: "team1" }), expect.any(AbortSignal));
    expect(() => validateDesktopJobBinding({ ...fixture.binding, workspacePolicy: "controller-readonly" })).toThrow(expect.objectContaining({ status: 422, code: "desktop_job_workspace" }));
    expect(() => validateDesktopJobBinding({ ...fixture.binding, cwd: "relative" })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects redirected folders and worker or unknown roles before admission", async () => {
    const fixture = hostFixture(), link = join(fixture.root, "redirect"); symlinkSync(fixture.cwd, link);
    expect(() => validateDesktopJobBinding({ ...fixture.binding, cwd: link })).toThrow(expect.objectContaining({ status: 422 }));
    if (process.getuid?.() !== 0) expect(() => validateDesktopJobBinding({ ...fixture.binding, cwd: "/" }))
      .toThrow(expect.objectContaining({ status: 422 }));
    for (const role of ["worker", "validator", "unknown"] as const) {
      await expect(fixture.runtime.handle({ ...fixture.input, role })).rejects.toMatchObject({ status: 400, code: "desktop_workspace_policy" });
    }
    expect(fixture.acquire).not.toHaveBeenCalled(); expect(fixture.inner.handle).not.toHaveBeenCalled();
  });

  it.each(["Execute", "Create", "Edit"])("parks %s with a workspace reservation and reacquires compute for its matching result", async name => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn("host-1", name));
    await fixture.runtime.handle(fixture.input);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host", hostActionReservation: true }));
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 1 } });
    await expect(fixture.runtime.handle(fixture.input)).rejects.toMatchObject({ status: 409, code: "desktop_host_action_pending" });
    await expect(fixture.runtime.handle(withResult(fixture.input, "other-call"))).rejects.toMatchObject({ code: "desktop_host_action_pending" });
    expect(fixture.releases).toHaveBeenCalledOnce();
    await fixture.runtime.handle(withResult(fixture.input));
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
    expect(fixture.releases).toHaveBeenCalledTimes(2);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "idle", usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 6 } }));
  });

  it.each(["Task", "SpawnAgent", "mcp__github__create_pull_request", "factory-workers-pool___unknown_mutation"])("reserves the workspace for pending %s", async name => {
    const fixture = hostFixture();
    fixture.options.workerMcpPrefix = "factory-workers-pool___";
    fixture.inner.handle.mockResolvedValueOnce(hostTurn("pending-writer", name));
    await fixture.runtime.handle(fixture.input);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host", hostActionReservation: true }));
    await expect(fixture.runtime.handle(fixture.input)).rejects.toMatchObject({ code: "desktop_host_action_pending" });
    expect(fixture.inner.handle).toHaveBeenCalledOnce();
  });

  it.each(["SpawnAgent", "mcp__fixture__write_file"])("blocks a second same-folder Workstream until pending %s is acknowledged", async name => {
    const first = hostFixture(), second = hostFixture();
    const stateRoot = join(first.root, "native-state");
    for (const fixture of [first, second]) {
      fixture.options.runtimePackagePath = resolve("native-runtime");
      fixture.options.stateRoot = stateRoot;
      fixture.options.admissionTimeoutMs = 5_000;
      fixture.options.releaseTimeoutMs = 2_000;
      fixture.options.acquireLease = undefined;
      fixture.options.updateRecord = undefined;
    }
    second.binding.sessionId = "factory-second";
    second.binding.cwd = first.cwd;
    second.binding.subscriptionProfile = "team2";
    second.input.session.bridgeSessionId = "bridge-second";
    first.inner.handle.mockResolvedValueOnce(hostTurn("pending-mutation", name));
    try {
      await first.runtime.handle(first.input);
      second.options.admissionTimeoutMs = 100;
      await expect(second.runtime.handle(second.input)).rejects.toMatchObject({
        code: "desktop_job_timeout", extra: { retry_safe: true },
      });
      expect(second.inner.handle).not.toHaveBeenCalled();
      await first.runtime.completeHostTool!("bridge-1", {
        toolUseId: "pending-mutation", toolName: name, input: { command: "df -h" }, content: "done",
      });
      second.options.admissionTimeoutMs = 5_000;
      await second.runtime.handle(second.input);
      expect(second.inner.handle).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([first.runtime.close(), second.runtime.close()]);
    }
  });

  it("Factory-native Task releases the parent reservation so its same-folder child can infer", async () => {
    const first = hostFixture(), second = hostFixture();
    const stateRoot = join(first.root, "native-state");
    for (const fixture of [first, second]) {
      fixture.options.factoryNative = true;
      fixture.options.runtimePackagePath = resolve("native-runtime");
      fixture.options.stateRoot = stateRoot;
      fixture.options.admissionTimeoutMs = 5_000;
      fixture.options.releaseTimeoutMs = 2_000;
      fixture.options.acquireLease = undefined;
      fixture.options.updateRecord = undefined;
    }
    second.binding.sessionId = "factory-child";
    second.binding.cwd = first.cwd;
    second.binding.subscriptionProfile = "team2";
    second.input.session.bridgeSessionId = "bridge-child";
    first.inner.handle.mockResolvedValueOnce(hostTurn("pending-task", "Task"));
    try {
      await first.runtime.handle(first.input);
      expect(first.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 0 } });
      await second.runtime.handle(second.input);
      expect(second.inner.handle).toHaveBeenCalledOnce();
      await first.runtime.handle(withResult(first.input, "pending-task"));
      expect(first.inner.handle).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.allSettled([first.runtime.close(), second.runtime.close()]);
    }
  });

  it("keeps the native orchestrator responsive while its same-folder agent is generating", async () => {
    const parent = hostFixture(), agent = hostFixture(), finishAgent = deferred<RuntimeTurn>();
    for (const fixture of [parent, agent]) {
      fixture.options.factoryNative = true;
      fixture.binding.workspacePolicy = "factory-native";
      fixture.options.runtimePackagePath = resolve("native-runtime");
      fixture.options.stateRoot = join(parent.root, "native-state");
      fixture.options.admissionTimeoutMs = 5_000;
      fixture.options.releaseTimeoutMs = 2_000;
      fixture.options.acquireLease = undefined;
      fixture.options.updateRecord = undefined;
    }
    agent.binding.sessionId = "native-agent";
    agent.binding.cwd = parent.cwd;
    agent.binding.subscriptionProfile = "team2";
    agent.input.role = "worker";
    agent.input.session.bridgeSessionId = "native-agent-bridge";
    const began = deferred<void>();
    agent.inner.handle.mockImplementationOnce(async () => { began.resolve(); return finishAgent.promise; });
    parent.inner.handle.mockResolvedValueOnce(hostTurn("native-send", "SendMessage"));
    let running: Promise<RuntimeTurn> | undefined;
    try {
      await parent.runtime.handle(parent.input);
      running = agent.runtime.handle(agent.input);
      await began.promise;
      // The child retains inference. The parent must still be able to think
      // and publish InterruptAgent rather than waiting for child completion.
      await parent.runtime.handle(withResult(parent.input, "native-send"));
      expect(parent.inner.handle).toHaveBeenCalledTimes(2);
      expect(agent.inner.handle).toHaveBeenCalledOnce();
    } finally {
      finishAgent.resolve(turn());
      if (running) await running;
      await Promise.allSettled([parent.runtime.close(), agent.runtime.close()]);
    }
  });

  it.each(["Read", "ListAgents", "TodoWrite", "factory-workers-pool___factory_worker_start", "factory-workers-pool___factory_worker_wait"])("keeps safe read or supervised control %s outside workspace reservations", async name => {
    const fixture = hostFixture();
    fixture.options.workerMcpPrefix = "factory-workers-pool___";
    fixture.inner.handle.mockResolvedValueOnce(hostTurn("read-or-control", name));
    await fixture.runtime.handle(fixture.input);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host" }));
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 0 } });
  });

  it("retains unknown native cleanup separately from a completed inference phase", async () => {
    const fixture = hostFixture();
    fixture.inner.handle.mockResolvedValueOnce(hostTurn()).mockRejectedValueOnce(new Error("continuation failed"));
    fixture.inner.cancel.mockRejectedValue(new Error("native cleanup failed"));
    await fixture.runtime.handle(fixture.input);
    await expect(fixture.runtime.handle(withResult(fixture.input))).rejects.toThrow("continuation failed");
    expect(fixture.releases).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "unknown", hostActionReservation: true, cleanupVerified: false,
    }));
  });

  it.each([true, false])("records native cleanup outcome %s when cancelling a parked host action", async clean => {
    const fixture = hostFixture();
    fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    if (!clean) fixture.inner.cancel.mockRejectedValue(new Error("native cleanup failed"));
    await fixture.runtime.handle(fixture.input);
    await expect(fixture.runtime.cancel("bridge-1", "stop")).rejects.toThrow();
    expect(fixture.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      state: "unknown", hostActionReservation: true, cleanupVerified: clean,
    }));
  });

  it("accepts a trusted host completion receipt without replaying a historical result", async () => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    await fixture.runtime.handle(fixture.input);
    await fixture.runtime.completeHostTool!("bridge-1", { toolUseId: "host-1", toolName: "Execute", input: { command: "df -h" }, content: "done" });
    await fixture.runtime.handle(fixture.input);
    expect(fixture.acquire).toHaveBeenCalledTimes(2); expect(fixture.releases).toHaveBeenCalledTimes(2);
    expect(fixture.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "waiting_host", hostActionReservation: false }));
  });

  it("protects held host records from session retention even when the inner runtime no longer lists them", async () => {
    const fixture = hostFixture(); fixture.input.session.bridgeSessionId = "bridge-held";
    fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    await fixture.runtime.handle(fixture.input);
    expect(fixture.runtime.protectedSessionIds?.()).toEqual(["bridge-1", "bridge-held"]);
    await expect(fixture.runtime.cancel("bridge-held", "cancel")).rejects.toMatchObject({ code: "desktop_host_cleanup_unknown" });
    expect(fixture.runtime.protectedSessionIds?.()).toEqual(["bridge-1", "bridge-held"]);
  });

  it("retains workspace ownership while releasing compute between consecutive host actions", async () => {
    const fixture = hostFixture();
    fixture.inner.handle.mockResolvedValueOnce(hostTurn("host-a")).mockResolvedValueOnce(hostTurn("host-b"));
    await fixture.runtime.handle(fixture.input);
    expect(fixture.releases).toHaveBeenCalledOnce();
    await fixture.runtime.handle(withResult(fixture.input, "host-a"));
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
    expect(fixture.releases).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 1 } });
    await fixture.runtime.handle(withResult(fixture.input, "host-b"));
    expect(fixture.acquire).toHaveBeenCalledTimes(3); expect(fixture.releases).toHaveBeenCalledTimes(3);
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 0 } });
  });

  it("does not mistake an unrelated historical result for completion of a current command", async () => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    await fixture.runtime.handle(fixture.input);
    const historical = withResult(fixture.input, "old-unrelated-call");
    historical.request.messages.push({ role: "user", content: "new unrelated turn" });
    await expect(fixture.runtime.handle(historical)).rejects.toMatchObject({ code: "desktop_host_action_pending" });
    expect(fixture.releases).toHaveBeenCalledOnce();
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("accepts a current command result before a newer steering message", async () => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    await fixture.runtime.handle(fixture.input);
    const steered = withResult(fixture.input);
    steered.request.messages.push({ role: "assistant", content: "Tool completed." }, { role: "user", content: "Continue." });
    await fixture.runtime.handle(steered);
    expect(fixture.acquire).toHaveBeenCalledTimes(2); expect(fixture.releases).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "close", "end"])("keeps unresolved host execution unknown after %s instead of claiming cleanup", async operation => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn());
    fixture.inner.endHostSession.mockResolvedValue({ resumable: false, sdkSessionId: "checkpoint" });
    await fixture.runtime.handle(fixture.input);
    if (operation === "cancel") await expect(fixture.runtime.cancel("bridge-1", "test")).rejects.toMatchObject({ code: "desktop_host_cleanup_unknown" });
    else if (operation === "close") await expect(fixture.runtime.close()).rejects.toMatchObject({ code: "desktop_jobs_cleanup" });
    else await fixture.runtime.endHostSession!("bridge-1", "end");
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host", hostActionReservation: true }));
    expect(fixture.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "unknown", cleanupVerified: true, hostActionReservation: true }));
    if (operation !== "close") await expect(fixture.runtime.handle(withResult(fixture.input))).rejects.toMatchObject({ code: "desktop_host_cleanup_unknown" });
  });

  it("keeps normal host Read and AskUser turns parked without reserving side-effect capacity", async () => {
    const fixture = hostFixture(); fixture.inner.handle.mockResolvedValueOnce(hostTurn("read", "Read"));
    await fixture.runtime.handle(fixture.input);
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host" }));
    expect(fixture.runtime.describe()).toMatchObject({ desktopJobs: { heldHostActions: 0 } });
  });

  it("does not claim a published command stopped when cancellation races the active model phase", async () => {
    const fixture = hostFixture(), output = deferred<RuntimeTurn>();
    fixture.inner.handle.mockImplementationOnce(() => output.promise);
    fixture.inner.pendingHostCalls.mockReturnValue([{ toolUseId: "host-1", toolName: "Execute", input: { command: "df -h" } }]);
    const running = fixture.runtime.handle(fixture.input);
    await Promise.resolve(); await Promise.resolve();
    const cancelled = fixture.runtime.cancel("bridge-1", "stop");
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "desktop_host_cleanup_unknown" });
    await Promise.resolve(); await Promise.resolve();
    output.resolve(hostTurn());
    await running; await rejected;
    expect(fixture.releases).toHaveBeenCalledWith(expect.objectContaining({ state: "unknown", cleanupVerified: true }));
    expect(fixture.update).not.toHaveBeenCalled();
  });
});

function fakeHelper(script: string) {
  const fixture = workspace();
  mkdirSync(join(fixture.root, "native_runtime")); writeFileSync(join(fixture.root, "native_runtime/__init__.py"), "");
  writeFileSync(join(fixture.root, "native_runtime/factory_lease.py"), script);
  const options: DesktopJobsOptions = { pythonExecutable: "/usr/bin/python3", runtimePackagePath: fixture.root, stateRoot: join(fixture.root, "state"),
    getBinding: () => ({ sessionId: "factory", cwd: fixture.cwd }), admissionTimeoutMs: 1_000, releaseTimeoutMs: 1_000 };
  const acquire: DesktopJobAcquire = { factorySessionId: "factory", bridgeSessionId: "bridge", cwd: fixture.cwd, role: "worker" };
  return { ...fixture, options, acquire };
}

describe("private shared-lease subprocess protocol", () => {
  it("marks an admission timeout retry-safe only after durable deferral acknowledgement", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nprint(json.dumps({'ok':True,'event':'queued','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r=={'op':'defer'}\nprint(json.dumps({'ok':True,'event':'deferred','jobId':'job-fixture'}),flush=True)\n`);
    fixture.options.admissionTimeoutMs = 30;
    await expect(acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal))
      .rejects.toMatchObject({ code: "desktop_job_timeout", extra: { retry_safe: true, phase: "admission" } });
  });

  it("does not call an unconfirmed deferral safe to retry", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nprint(json.dumps({'ok':True,'event':'queued','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r=={'op':'defer'}\nsys.exit(2)\n`);
    fixture.options.admissionTimeoutMs = 30;
    await expect(acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal))
      .rejects.toMatchObject({ code: "desktop_job_channel", extra: {} });
  });

  it("defers a racing ready response without exposing a model execution lease", async () => {
    const fixture = fakeHelper(`import json,sys,time\na=json.loads(sys.stdin.readline())\nprint(json.dumps({'ok':True,'event':'queued','jobId':'job-fixture'}),flush=True)\ntime.sleep(.08)\nprint(json.dumps({'ok':True,'event':'ready','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r=={'op':'defer'}\nprint(json.dumps({'ok':True,'event':'deferred','jobId':'job-fixture'}),flush=True)\n`);
    fixture.options.admissionTimeoutMs = 30;
    await expect(acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal))
      .rejects.toMatchObject({ code: "desktop_job_timeout", extra: { retry_safe: true } });
  });

  it.each(["invalid_workspace", "invalid_binding"])("returns permanent helper %s errors without retryable status or raw details", async code => {
    const fixture = fakeHelper(`import json\nprint(json.dumps({'ok':False,'error':'factory_lease_refused','code':${JSON.stringify(code)}}),flush=True)\n`);
    await expect(acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal))
      .rejects.toMatchObject({ status: code === "invalid_workspace" ? 422 : 400 });
  });
  it.each(SUBSCRIPTION_PROFILES)("forwards only fixed %s and allowlisted metadata", async (profile) => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nassert set(a)=={'op','factorySessionId','bridgeSessionId','cwd','role','subscriptionProfile'}\nassert a['subscriptionProfile']==${JSON.stringify(profile)}\nprint(json.dumps({'ok':True,'event':'ready','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r['op']=='release'\nprint(json.dumps({'ok':True,'event':'released','jobId':'job-fixture'}),flush=True)\n`);
    const request = { ...fixture.acquire, subscriptionProfile: profile, secret: "must-not-cross-protocol" };
    const lease = await acquireDesktopJobLease(fixture.options, request, new AbortController().signal);
    await lease.release({ state: "completed", cleanupVerified: true });
  });

  it("retains the fixed subscription profile in completion updates", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nassert a['op']=='update' and a['subscriptionProfile']=='team8'\nprint(json.dumps({'ok':True,'event':'updated','jobId':'job-fixture'}),flush=True)\n`);
    await updateDesktopJobRecord(fixture.options, { ...fixture.acquire, subscriptionProfile: "team8" }, { state: "completed", cleanupVerified: true });
  });

  it("rejects unsupported or non-string subscription profiles before launching a helper", async () => {
    const fixture = fakeHelper("raise Exception('must not run')\n");
    for (const profile of ["team0", "team9", "team01", "", "factory-api", null, { toString: () => "team1" }]) {
      const request = { ...fixture.acquire, subscriptionProfile: profile } as unknown as DesktopJobAcquire;
      await expect(acquireDesktopJobLease(fixture.options, request, new AbortController().signal)).rejects.toMatchObject({ code: "desktop_job_profile" });
      await expect(updateDesktopJobRecord(fixture.options, request, { state: "completed" })).rejects.toMatchObject({ code: "desktop_job_profile" });
    }
  });

  it("uses ready/release acknowledgements and does not send inherited credentials", async () => {
    const fixture = fakeHelper(`import json,os,sys\na=json.loads(sys.stdin.readline())\nassert 'ANTHROPIC_API_KEY' not in os.environ\nassert set(a)=={'op','factorySessionId','bridgeSessionId','cwd','role'}\nprint(json.dumps({'ok':True,'event':'queued','jobId':'job-fixture'}),flush=True)\nprint(json.dumps({'ok':True,'event':'ready','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r['op']=='release' and r['state']=='waiting_host'\nassert 'private' not in json.dumps(r)\nprint(json.dumps({'ok':True,'event':'released','jobId':'job-fixture'}),flush=True)\n`);
    vi.stubEnv("ANTHROPIC_API_KEY", "private-credential");
    try {
      const lease = await acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal);
      expect(lease.jobId).toBe("job-fixture");
      await lease.release({ state: "waiting_host", usage: { input_tokens: 3, output_tokens: 4 }, cleanupVerified: false });
    } finally { vi.unstubAllEnvs(); }
  });

  it("sends cancellation only before admission and waits for cleanup after admission", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nprint(json.dumps({'ok':True,'event':'ready','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r['op']=='release',r\nprint(json.dumps({'ok':True,'event':'released','jobId':'job-fixture'}),flush=True)\n`);
    const controller = new AbortController();
    const lease = await acquireDesktopJobLease(fixture.options, fixture.acquire, controller.signal);
    controller.abort();
    await lease.release({ state: "cancelled", cleanupVerified: true });
  });

  it("accepts a queued cancellation acknowledgement without reporting a protocol failure", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nprint(json.dumps({'ok':True,'event':'queued','jobId':'job-fixture'}),flush=True)\nr=json.loads(sys.stdin.readline())\nassert r=={'op':'cancel'}\nprint(json.dumps({'ok':True,'event':'cancelled','jobId':'job-fixture'}),flush=True)\n`);
    const controller = new AbortController();
    const pending = acquireDesktopJobLease(fixture.options, fixture.acquire, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "desktop_job_cancelled" });
  });

  it("updates a known record without acquiring a new inference slot", async () => {
    const fixture = fakeHelper(`import json,sys\na=json.loads(sys.stdin.readline())\nassert a['op']=='update' and a['cleanupVerified'] is True\nprint(json.dumps({'ok':True,'event':'updated','jobId':'job-fixture'}),flush=True)\n`);
    await updateDesktopJobRecord(fixture.options, fixture.acquire, { state: "cancelled", cleanupVerified: true });
  });

  it("fails closed and sanitizes malformed helper responses", async () => {
    const fixture = fakeHelper("print('private-secret-malformed-response',flush=True)\n");
    await expect(acquireDesktopJobLease(fixture.options, fixture.acquire, new AbortController().signal)).rejects.toMatchObject({ code: "desktop_job_protocol" });
  });
});
