import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopJobsRuntime, SUBSCRIPTION_PROFILES, acquireDesktopJobLease, updateDesktopJobRecord, type DesktopJobAcquire, type DesktopJobBinding, type DesktopJobLease, type DesktopJobsOptions } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";

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
    interrupt: vi.fn(async () => true), pendingHostCalls: vi.fn(() => []),
    completeHostTool: vi.fn(async () => "accepted" as const),
    endHostSession: vi.fn(async () => ({ resumable: true, sdkSessionId: "sdk-checkpoint" })),
    describe: vi.fn(() => ({ native: true })), close: vi.fn(async () => undefined),
    protectedSessionIds: vi.fn(() => ["bridge-1"]), isSessionUsable: vi.fn(() => true), forget: vi.fn(async () => undefined) };
  const options: DesktopJobsOptions = { pythonExecutable: "/usr/bin/python3", runtimePackagePath: root, stateRoot: join(root, "state"),
    getBinding: () => binding, acquireLease: acquire, updateRecord: update };
  return { root, cwd, binding, releases, acquire, update, inner, options, runtime: new DesktopJobsRuntime(inner, options) };
}

describe("Factory model-phase supervision", () => {
  it("refuses missing trusted identity and a main checkout before model execution", async () => {
    const fixture = setup();
    fixture.options.getBinding = () => undefined;
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_binding" });
    fixture.options.getBinding = () => fixture.binding;
    rmSync(join(fixture.cwd, ".git")); mkdirSync(join(fixture.cwd, ".git"));
    await expect(fixture.runtime.handle(request())).rejects.toMatchObject({ code: "desktop_job_workspace" });
    expect(fixture.inner.handle).not.toHaveBeenCalled(); expect(fixture.acquire).not.toHaveBeenCalled();
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
