import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIWorkerService, type APIWorkerServiceOptions, type WorkerRunContext } from "../../src/workers/service.js";

vi.mock("../../src/workers/subscription-auth.js", async original => ({
  ...await original<typeof import("../../src/workers/subscription-auth.js")>(),
  prepareSubscription: vi.fn(async () => ({ env: {}, expectedIdentity: { profile: "team1", email: "fixture@example.invalid", configDir: "/fixture/profile" } })),
}));

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Worker bypass fixture timed out.");
    await new Promise(done => setTimeout(done, 5));
  }
}
function success(context: WorkerRunContext) {
  context.message({ type: "result", subtype: "success", session_id: "fixture-session", result: "done" });
}
function request(context: WorkerRunContext, tool: string, input: Record<string, unknown>, signal = context.options.abortController!.signal) {
  return context.options.canUseTool!(tool, input, { signal, toolUseID: "tool-" + tool, requestId: "request-" + tool });
}

describe("explicit subscription worker approval bypass", () => {
  let root: string, repository: string;
  const services: APIWorkerService[] = [];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "subscription-bypass-")));
    repository = join(root, "repo"); mkdirSync(repository);
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.close()));
    rmSync(root, { recursive: true, force: true });
  });
  function fixture(run: (context: WorkerRunContext) => Promise<void>, changes: Partial<APIWorkerServiceOptions> = {}) {
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({ release }));
    const runtime = new APIWorkerService({
      stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"), allowedRepositories: [repository],
      provider: { kind: "subscription", profile: "team1" }, approvalPolicy: "bypass", maxMs: 10_000,
      verifyRuntime: () => ({ executable: "/fixture/claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" }),
      cleanup: async () => {}, acquireLease: acquire, run, ...changes,
    });
    services.push(runtime);
    return { runtime, release, acquire,
      start: () => runtime.start({ repository, task: "Local bypass fixture.", workflow: "investigate" }) };
  }

  it("automatically approves concurrent permitted actions with exact cloned inputs and one held lease", async () => {
    let decisions: unknown;
    const value = fixture(async context => {
      expect(context.options.permissionMode).toBe("default");
      expect(context.options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [context.worker.worktree] } });
      const input = { file_path: join(context.worker.worktree, "large.txt"), content: "x".repeat(5000) };
      const write = request(context, "Write", input);
      input.content = "mutated after dispatch";
      decisions = await Promise.all([write, request(context, "Bash", { command: "git status --short" })]);
      expect(value.runtime.status(context.worker.id)).toMatchObject({ state: "running", pendingApprovalCount: 0, approvals: [] });
      expect(value.acquire).toHaveBeenCalledOnce();
      expect(value.release).not.toHaveBeenCalled();
      success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decisions).toMatchObject([{ behavior: "allow", updatedInput: { content: "x".repeat(5000) } },
      { behavior: "allow", updatedInput: { command: "git status --short" } }]);
    expect(value.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "completed", cleanupVerified: true }));
  });

  it("automatically permits a validated workflow while retaining child completion tracking", async () => {
    let decision: unknown;
    const value = fixture(async context => {
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]! as (...args: unknown[]) => Promise<unknown>;
      const input = { script: "export default async () => 1;" };
      decision = await hook({ hook_event_name: "PreToolUse", tool_name: "Workflow", tool_use_id: "workflow-1", tool_input: input }, "workflow-1", { signal: context.options.abortController!.signal });
      expect(value.runtime.status(context.worker.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [], children: [{ id: "tool:workflow-1", state: "running" }] });
      context.message({ type: "system", subtype: "task_notification", task_id: "child-1", tool_use_id: "workflow-1", status: "completed", session_id: "fixture-session" });
      success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { script: "export default async () => 1;" } } });
    expect(value.acquire).toHaveBeenCalledOnce();
  });

  it("retains blocked tools, worktree boundaries, workflow validation and cancelled action checks", async () => {
    const value = fixture(async context => {
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]! as (...args: unknown[]) => Promise<unknown>;
      for (const [tool, input] of [
        ["EnterWorktree", {}], ["CronCreate", {}], ["Write", { file_path: join(root, "outside.txt"), content: "outside" }],
        ["Workflow", { script: "inline", isolation: "remote" }],
      ] as const) {
        expect(await request(context, tool, input)).toMatchObject({ behavior: "deny" });
        expect(await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: tool, tool_input: input }, tool, { signal: context.options.abortController!.signal }))
          .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      }
      const cancelled = new AbortController(); cancelled.abort();
      expect(await request(context, "Bash", { command: "never-run" }, cancelled.signal)).toMatchObject({ behavior: "deny" });
      expect(value.runtime.status(context.worker.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [] });
      success(context);
    });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).state === "completed");
  });

  it("keeps ask as the default and waits for an exact decision", async () => {
    let decision: unknown;
    const value = fixture(async context => { decision = await request(context, "Bash", { command: "git status --short" }); success(context); }, { approvalPolicy: undefined });
    const worker = await value.start();
    await until(() => value.runtime.status(worker.id).approvals.length === 1);
    expect(decision).toBeUndefined();
    value.runtime.approve({ id: worker.id, approvalId: value.runtime.status(worker.id).approvals[0]!.id, decision: "allow" });
    await until(() => value.runtime.status(worker.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "allow" });
    expect(value.acquire).toHaveBeenCalledTimes(2);
  });

  it.each(["anthropic", "openrouter"] as const)("does not allow an API worker to opt into bypass: %s", kind => {
    expect(() => fixture(async context => success(context), { provider: { kind }, maxBudgetUsd: 1, approvalPolicy: "bypass" }))
      .toThrow(/explicit subscription policy/);
  });
});
