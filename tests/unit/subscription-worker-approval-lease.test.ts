import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRecord } from "../../src/workers/worker-state.js";
import { APIWorkerService, type WorkerLease, type WorkerRunContext } from "../../src/workers/service.js";

vi.mock("../../src/workers/subscription-auth.js", async original => ({
  ...await original<typeof import("../../src/workers/subscription-auth.js")>(),
  prepareSubscription: vi.fn(async () => ({ env: {}, expectedIdentity: { profile: "team1", email: "fixture@example.invalid", configDir: "/fixture/profile" } })),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for approval lease fixture.");
    await new Promise(done => setTimeout(done, 5));
  }
}
function success(context: WorkerRunContext) {
  context.message({ type: "result", subtype: "success", session_id: "fixture-session", result: "done" });
}
function permission(context: WorkerRunContext, id: string) {
  return context.options.canUseTool!("Bash", { command: "fixture-" + id }, { signal: context.options.abortController!.signal, toolUseID: id, requestId: id });
}

describe("subscription approval seat handoff", () => {
  let root: string, repository: string;
  const services: APIWorkerService[] = [];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "subscription-approval-")));
    repository = join(root, "repo"); mkdirSync(repository);
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.close()));
    rmSync(root, { recursive: true, force: true });
  });
  function fixture(run: (context: WorkerRunContext) => Promise<void>) {
    const leases: Array<WorkerLease & { release: ReturnType<typeof vi.fn> }> = [];
    const requests: Array<{ worker: Readonly<WorkerRecord>; signal: AbortSignal; gate: ReturnType<typeof deferred<WorkerLease>> }> = [];
    const newLease = () => {
      const lease = { release: vi.fn(async () => {}) };
      leases.push(lease); return lease;
    };
    const first = newLease();
    const finalize = vi.fn(async () => {});
    const runtime = new APIWorkerService({
      stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"), allowedRepositories: [repository],
      provider: { kind: "subscription", profile: "team1" }, maxMs: 10_000,
      verifyRuntime: () => ({ executable: "/fixture/claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" }),
      cleanup: async () => {}, run, finalizeLease: finalize,
      acquireLease: async (worker, signal) => {
        const gate = deferred<WorkerLease>(); requests.push({ worker: structuredClone(worker), signal, gate });
        if (requests.length === 1) return first;
        return new Promise((resolve, reject) => {
          const abort = () => reject(new Error("cancelled fixture acquisition"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          gate.promise.then(lease => { signal.removeEventListener("abort", abort); resolve(lease); });
        });
      },
    });
    services.push(runtime);
    const start = () => runtime.start({ repository, task: "Exercise local fixture approval.", workflow: "investigate" });
    return { runtime, start, leases, requests, newLease, finalize };
  }

  it("parks the worker for controller inference and reacquires the same seat before an allowed action", async () => {
    let decision: Awaited<ReturnType<typeof permission>> | undefined;
    const value = fixture(async context => { decision = await permission(context, "one"); success(context); });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1 && value.leases[0]!.release.mock.calls.length === 1);
    expect(value.leases[0]!.release).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host", cleanupVerified: false }));
    // A controller can now own the shared seat; its approval does not grant
    // inference capacity to the worker until that controller releases it.
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.requests.length === 2);
    expect(decision).toBeUndefined();
    expect(value.requests[1]!.worker).toMatchObject({ id: worker.id, worktree: worker.worktree, subscriptionProfile: "team1" });
    const resumed = value.newLease(); value.requests[1]!.gate.resolve(resumed);
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "allow" });
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    expect(resumed.release).toHaveBeenCalledWith(expect.objectContaining({ state: "completed", cleanupVerified: true }));
    expect(value.finalize).not.toHaveBeenCalled();
  });

  it("denies oversized actions without parking the lease and still permits a smaller reviewed action", async () => {
    const decisions: unknown[] = [];
    let smallerDecision: unknown;
    const value = fixture(async context => {
      for (const tool of ["Write", "Edit", "Workflow"]) {
        if (tool === "Workflow") {
          const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]! as (...args: unknown[]) => Promise<unknown>;
          decisions.push(await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: "large-workflow",
            tool_input: { script: "export default async () => 1; //" + "x".repeat(5000) } }, "large-workflow", { signal: context.options.abortController!.signal }));
        } else {
          decisions.push(await context.options.canUseTool!(tool, { file_path: join(context.worker.worktree, "large.txt"), content: "x".repeat(5000) },
            { signal: context.options.abortController!.signal, toolUseID: "large-" + tool, requestId: "large-" + tool }));
        }
        expect(value.runtime.status(context.worker.id)).toMatchObject({ state: "running", pendingApprovalCount: 0, approvals: [] });
        expect(value.requests).toHaveLength(1);
        expect(value.leases[0]!.release).not.toHaveBeenCalled();
      }
      smallerDecision = await permission(context, "smaller");
      success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1);
    expect(decisions).toMatchObject([
      { behavior: "deny", message: expect.stringContaining("smaller") },
      { behavior: "deny", message: expect.stringContaining("smaller") },
      { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("smaller") } },
    ]);
    expect(value.leases[0]!.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "waiting_host" }));
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.requests.length === 2);
    const resumed = value.newLease(); value.requests[1]!.gate.resolve(resumed);
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(smallerDecision).toMatchObject({ behavior: "allow" });
    expect(value.runtime.status(worker.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [], cleanupVerified: true });
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    expect(resumed.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "completed", cleanupVerified: true }));
  });

  it.each(["waiting for approval", "reacquiring the seat"])("holds an oversized denial while another action is %s", async phase => {
    const addLarge = deferred<void>();
    let largeStarted = false, largeDecision: unknown, decisions: unknown;
    const value = fixture(async context => {
      const small = permission(context, "small");
      await addLarge.promise;
      const large = context.options.canUseTool!("Write", { file_path: join(context.worker.worktree, "large.txt"), content: "x".repeat(5000) },
        { signal: context.options.abortController!.signal, toolUseID: "large", requestId: "large" });
      largeStarted = true;
      void large.then(decision => { largeDecision = decision; });
      decisions = await Promise.all([small, large]);
      success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1);
    const approveSmall = () => value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    if (phase === "reacquiring the seat") {
      approveSmall();
      await until(() => value.requests.length === 2);
    }
    addLarge.resolve();
    await until(() => largeStarted);
    expect(value.runtime.status(worker.id).approvals).toHaveLength(phase === "waiting for approval" ? 1 : 0);
    expect(largeDecision).toBeUndefined();
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    if (phase === "waiting for approval") approveSmall();
    await until(() => value.requests.length === 2);
    expect(largeDecision).toBeUndefined();
    const resumed = value.newLease(); value.requests[1]!.gate.resolve(resumed);
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decisions).toMatchObject([{ behavior: "allow" }, { behavior: "deny", message: expect.stringContaining("smaller") }]);
    expect(value.runtime.status(worker.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [], cleanupVerified: true });
    expect(value.requests).toHaveLength(2);
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    expect(resumed.release).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent approvals and waits for the seat before returning a denial too", async () => {
    let decisions: unknown;
    const value = fixture(async context => { decisions = await Promise.all([permission(context, "one"), permission(context, "two")]); success(context); });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 2);
    const [one, two] = value.runtime.status(worker.id).approvals;
    value.runtime.approve({ id: worker.id, approvalId: one!.id, decision: "allow" });
    expect(value.requests).toHaveLength(1);
    value.runtime.approve({ id: worker.id, approvalId: two!.id, decision: "deny" });
    await until(() => value.requests.length === 2);
    expect(decisions).toBeUndefined();
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    const resumed = value.newLease(); value.requests[1]!.gate.resolve(resumed);
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decisions).toMatchObject([{ behavior: "allow" }, { behavior: "deny" }]);
    expect(value.requests).toHaveLength(2);
    expect(resumed.release).toHaveBeenCalledOnce();
  });

  it("cancels an acquisition without returning allow or releasing an obsolete lease twice", async () => {
    let decision: unknown;
    const value = fixture(async context => { decision = await permission(context, "one"); success(context); });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1);
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.requests.length === 2);
    await value.runtime.cancel(worker.id);
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(value.requests[1]!.signal.aborted).toBe(true);
    expect(value.leases[0]!.release).toHaveBeenCalledOnce();
    expect(value.finalize).toHaveBeenCalledWith(expect.objectContaining({ id: worker.id, subscriptionProfile: "team1" }), expect.objectContaining({ state: "cancelled", cleanupVerified: true }));
  });

  it("parks a newly acquired lease again if another approval arrives during acquisition", async () => {
    const addSecond = deferred<void>(); let decisions: unknown;
    const value = fixture(async context => {
      const one = permission(context, "one"); await addSecond.promise;
      const two = permission(context, "two"); decisions = await Promise.all([one, two]); success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1);
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.requests.length === 2);
    addSecond.resolve(); await until(() => value.runtime.status(worker.id).approvals.length === 1);
    const intermediate = value.newLease(); value.requests[1]!.gate.resolve(intermediate);
    await until(() => intermediate.release.mock.calls.length === 1);
    expect(intermediate.release).toHaveBeenCalledWith(expect.objectContaining({ state: "waiting_host", cleanupVerified: false }));
    expect(decisions).toBeUndefined();
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.requests.length === 3);
    const resumed = value.newLease(); value.requests[2]!.gate.resolve(resumed);
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decisions).toMatchObject([{ behavior: "allow" }, { behavior: "allow" }]);
    expect(intermediate.release).toHaveBeenCalledOnce(); expect(resumed.release).toHaveBeenCalledOnce();
  });
});
