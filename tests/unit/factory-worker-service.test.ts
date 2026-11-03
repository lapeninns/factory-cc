import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { APIWorkerService, type APIWorkerServiceOptions, type WorkerRunContext } from "../../src/workers/service.js";
import { BridgeError } from "../../src/types.js";
import { WorkerStartRejected } from "../../src/workers/start-rejection.js";
import { startWorkerControl } from "../../src/workers/control.js";
import { decideWorkerApproval, readPendingWorkerApprovals } from "../../src/runtime/worker-permission-client.js";

const support = () => ({ executable: "/fixture/unmodified-claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" });
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state."); await sleep(10); }
}
function success(context: WorkerRunContext): void {
  context.message({ type: "assistant", session_id: "session-fixture", message: { id: "msg-1", model: "claude-opus-5-5", content: [], usage: { input_tokens: 12, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } });
  context.message({ type: "result", subtype: "success", is_error: false, session_id: "session-fixture", result: "Worker fixture complete.", usage: { input_tokens: 12, output_tokens: 7 } });
}

describe("Factory supervised API workers", () => {
  let folder: string, repo: string;
  const services: APIWorkerService[] = [];
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), "factory-workers-")));
    repo = join(folder, "source"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "file.txt"), "committed\n");
    execFileSync("git", ["-C", repo, "add", "file.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  });
  afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });
  function service(changes: Partial<APIWorkerServiceOptions> = {}): APIWorkerService {
    const result = new APIWorkerService({ stateRoot: join(folder, "state"), workspaceRoot: join(folder, "workspaces"), allowedRepositories: [repo],
      provider: { kind: "anthropic" }, maxBudgetUsd: 0.2, maxMs: 10_000, sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "fixture-api-value" }, verifyRuntime: support,
      run: async (context) => success(context), ...changes });
    services.push(result); return result;
  }
  it("classifies read-only preflight rejection before creating a worktree", async () => {
    const runtime = service({ verifyRuntime: () => { throw new BridgeError(503, "workflow_runtime_unverified", "private runtime detail"); } });
    await expect(runtime.start({ repository: repo, task: "fixture", workflow: "investigate" })).rejects.toMatchObject({ code: "runtime_unverified" });
    expect(runtime.list()).toEqual([]);
    expect(readdirSync(join(folder, "workspaces"))).toEqual([]);
    const blocked = service();
    await blocked.close();
    await expect(blocked.start({ repository: repo, task: "fixture", workflow: "investigate" })).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("keeps a failure after worktree creation begins outside the preflight classification", async () => {
    const runtime = service();
    writeFileSync(join(repo, ".git", "worktrees"), "fixture obstruction");
    const error = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WorkerStartRejected);
    expect(runtime.list()).toEqual([]);
  });

  it("uses distinct worktrees, preserves dirty source and secrets, and records only observed evidence", async () => {
    writeFileSync(join(repo, "file.txt"), "dirty original\n");
    writeFileSync(join(repo, ".env"), "FIXTURE_SECRET=not-for-worker\n");
    const runtime = service({ run: async (context) => { expect(readFileSync(join(context.worker.worktree, "file.txt"), "utf8")).toBe("committed\n"); writeFileSync(join(context.worker.worktree, "output.txt"), "result"); success(context); } });
    const a = await runtime.start({ repository: repo, task: "Do not store this private task.", workflow: "implement" });
    const b = await runtime.start({ repository: repo, task: "Second private task.", workflow: "investigate" });
    await until(() => runtime.list().every((item) => item.state === "completed"));
    expect(a.worktree).not.toBe(b.worktree);
    expect(a.branch).not.toBe(b.branch);
    expect(readdirSync(a.worktree)).not.toContain(".env");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("dirty original\n");
    const finished = runtime.status(a.id);
    expect(finished.sourceDirty).toBe(true);
    expect(finished.observedModels).toEqual(["claude-opus-5-5"]);
    expect(finished.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 });
    expect(finished.cleanupVerified).toBe(true);
    const saved = readFileSync(join(folder, "state", a.id + ".json"), "utf8");
    expect(saved).not.toContain("private task");
    expect(saved).not.toContain("fixture-api-value");
  });
  it("pins the official runtime, API environment, manual permissions, workflow and sandbox", async () => {
    let captured: WorkerRunContext | undefined;
    const runtime = service({ policyText: "Shared policy marker.", workflowText: { investigate: "Investigation guide." }, run: async (context) => { captured = context; success(context); } });
    const item = await runtime.start({ repository: repo, task: "Inspect.", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "completed");
    const options = captured!.options;
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("medium");
    expect(options.pathToClaudeCodeExecutable).toBe("/fixture/unmodified-claude");
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe("default");
    expect(options.settings).toMatchObject({ ultracode: true, workflowSizeGuideline: "small" });
    expect(options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(options.env!.ANTHROPIC_API_KEY).toBe("fixture-api-value");
    expect(options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.env!.CLAUDE_CONFIG_DIR).toContain(item.id);
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: expect.stringContaining("Investigation guide.") });
  });
  it("requires explicit matching approval and never persists the tool input", async () => {
    let decision: unknown;
    const runtime = service({ run: async (context) => {
      decision = await context.options.canUseTool!("Bash", { command: "run fixture", apiKey: "sensitive" }, { signal: context.options.abortController!.signal, toolUseID: "tool-1", requestId: "req-1" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Run fixture.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "waiting_approval");
    const pending = runtime.status(item.id).approvals[0]!;
    expect(pending.input).toEqual({ command: "run fixture", apiKey: "[redacted]" });
    expect(() => runtime.approve({ id: item.id, approvalId: "wrong", decision: "allow" })).toThrow();
    expect(runtime.status(item.id).state).toBe("waiting_approval");
    runtime.approve({ id: item.id, approvalId: pending.id, decision: "deny" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(() => runtime.approve({ id: item.id, approvalId: pending.id, decision: "allow" })).toThrow();
    expect(readFileSync(join(folder, "state", item.id + ".json"), "utf8")).not.toContain("run fixture");
  });
  it("allows only the exact pending input once", async () => {
    let decision: unknown;
    const runtime = service({ run: async (context) => {
      decision = await context.options.canUseTool!("Write", { file_path: join(context.worker.worktree, "allowed.txt"), content: "fixture" }, { signal: context.options.abortController!.signal, toolUseID: "write-1", requestId: "req-1" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Write fixture.", workflow: "implement" });
    await until(() => runtime.status(item.id).approvals.length === 1);
    runtime.approve({ id: item.id, approvalId: runtime.status(item.id).approvals[0]!.id, decision: "allow" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { content: "fixture" } });
  });
  it.each(["Write", "Edit", "Workflow"])("denies an oversized %s before parking it for approval", async (tool) => {
    let decision: unknown;
    const runtime = service({ run: async (context) => {
      const input = tool === "Workflow" ? { script: "export default async () => 1; //" + "x".repeat(5000) }
        : { file_path: join(context.worker.worktree, "large.txt"), content: "x".repeat(5000) };
      decision = await context.options.canUseTool!(tool, input, { signal: context.options.abortController!.signal, toolUseID: "large-action", requestId: "large-request" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Attempt a large action.", workflow: "implement" });
    await until(() => decision !== undefined);
    await until(() => runtime.status(item.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("smaller") });
    expect(runtime.status(item.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [], cleanupVerified: true });
  });
  it.each([4000, 4001])("enforces the %i-character summary boundary through the real approval channel", async (length) => {
    let decision: unknown, input: { file_path: string; content: string } | undefined;
    const runtime = service({ run: async (context) => {
      input = { file_path: join(context.worker.worktree, "boundary.txt"), content: "" };
      input.content = "x".repeat(length - `Write: ${JSON.stringify(input)}`.length);
      expect(`Write: ${JSON.stringify(input)}`).toHaveLength(length);
      decision = await context.options.canUseTool!("Write", input, { signal: context.options.abortController!.signal, toolUseID: "boundary-action", requestId: "boundary-request" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Exercise the approval boundary.", workflow: "implement" });
    if (length === 4000) {
      await until(() => runtime.status(item.id).state === "waiting_approval");
      const controlPath = join(folder, "boundary-control.json"), control = await startWorkerControl(runtime, controlPath);
      try {
        const signal = new AbortController().signal;
        const pending = await readPendingWorkerApprovals(controlPath, item.id, signal);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.input).toEqual(input);
        await decideWorkerApproval(controlPath, item.id, pending[0]!, "allow", signal);
      } finally { await control.close(); }
    }
    await until(() => runtime.status(item.id).state === "completed");
    expect(decision).toMatchObject(length === 4000 ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: expect.stringContaining("smaller") });
    expect(runtime.status(item.id)).toMatchObject({ pendingApprovalCount: 0, approvals: [], cleanupVerified: true });
  });
  it("requires explicit Workflow approval in PreToolUse even without a native permission callback", async () => {
    let hookResult: unknown;
    const runtime = service({ run: async (context) => {
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]!;
      hookResult = await (hook as (...args: unknown[]) => Promise<unknown>)(
        { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_use_id: "wf-1", tool_input: { script: "export default async () => 1;" } },
        "wf-1", { signal: context.options.abortController!.signal });
      context.message({ type: "system", subtype: "task_notification", task_id: "workflow-1", tool_use_id: "wf-1", status: "completed", session_id: "session-fixture" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Workflow.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "waiting_approval");
    expect(hookResult).toBeUndefined();
    const pending = runtime.status(item.id).approvals[0]!;
    expect(pending.toolName).toBe("Workflow");
    expect(pending.toolUseId).toBe("wf-1");
    runtime.approve({ id: item.id, approvalId: pending.id, decision: "allow" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(hookResult).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });
  it("rejects alternate Workflow entry points without asking and denies a cancelled pending workflow", async () => {
    let denied: unknown;
    const runtime = service({ run: async (context) => {
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]! as (...args: unknown[]) => Promise<unknown>;
      const invalid = await hook({ hook_event_name: "PreToolUse", tool_name: "Workflow", tool_use_id: "bad", tool_input: { script: "x", isolation: "remote" } }, "bad", { signal: context.options.abortController!.signal });
      expect(invalid).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      denied = await hook({ hook_event_name: "PreToolUse", tool_name: "Workflow", tool_use_id: "wf-cancel", tool_input: { script: "export default async () => 1;" } }, "wf-cancel", { signal: context.options.abortController!.signal });
    } });
    const item = await runtime.start({ repository: repo, task: "Workflow.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "waiting_approval");
    const pending = runtime.status(item.id).approvals[0]!;
    await runtime.cancel(item.id);
    await until(() => denied !== undefined);
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(() => runtime.approve({ id: item.id, approvalId: pending.id, decision: "allow" })).toThrow();
  });
  it("does not call an approved Workflow completed without a completion event", async () => {
    const runtime = service({ run: async (context) => {
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]! as (...args: unknown[]) => Promise<unknown>;
      await hook({ hook_event_name: "PreToolUse", tool_name: "Workflow", tool_use_id: "wf-pending", tool_input: { script: "export default async () => 1;" } }, "wf-pending", { signal: context.options.abortController!.signal });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Workflow.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "waiting_approval");
    runtime.approve({ id: item.id, approvalId: runtime.status(item.id).approvals[0]!.id, decision: "allow" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id).reason).toBe("child_completion_unproven");
  });
  it("queues beyond capacity and cancels without starting the queued task", async () => {
    const started: string[] = [];
    const runtime = service({ maxConcurrent: 1, run: async (context) => { started.push(context.worker.id); await new Promise<void>((done) => context.options.abortController!.signal.addEventListener("abort", () => done(), { once: true })); } });
    const first = await runtime.start({ repository: repo, task: "First.", workflow: "implement" });
    await until(() => started.length === 1);
    const second = await runtime.start({ repository: repo, task: "Second.", workflow: "implement" });
    expect(runtime.status(second.id).state).toBe("queued");
    expect((await runtime.cancel(second.id)).state).toBe("cancelled");
    await runtime.cancel(first.id);
    expect(started).toEqual([first.id]);
  });
  it("cancels pending permission and keeps capacity when cleanup is unproven", async () => {
    let denied: unknown;
    const runtime = service({ maxConcurrent: 1, cleanup: async () => { throw new Error("fixture cleanup failure"); }, run: async (context) => {
      denied = await context.options.canUseTool!("Bash", { command: "fixture" }, { signal: context.options.abortController!.signal, toolUseID: "x", requestId: "r" });
    } });
    const first = await runtime.start({ repository: repo, task: "First.", workflow: "implement" });
    await until(() => runtime.status(first.id).state === "waiting_approval");
    expect((await runtime.cancel(first.id)).state).toBe("unknown");
    expect(denied).toMatchObject({ behavior: "deny" });
    const second = await runtime.start({ repository: repo, task: "Second.", workflow: "implement" });
    expect(runtime.status(second.id).state).toBe("queued");
  });
  it("refuses unapproved repositories and missing or subscription credentials before worktree creation", async () => {
    const runtime = service({ sourceEnv: {} });
    await expect(runtime.start({ repository: repo, task: "x", workflow: "implement" })).rejects.toThrow();
    expect(readdirSync(join(folder, "workspaces"))).toEqual([]);
    const subscription = service({ sourceEnv: { CLAUDE_CODE_OAUTH_TOKEN: "secret", ANTHROPIC_API_KEY: "fixture" } });
    await expect(subscription.start({ repository: repo, task: "x", workflow: "implement" })).rejects.toThrow();
    const other = join(folder, "other"); mkdirSync(other);
    await expect(subscription.start({ repository: other, task: "x", workflow: "implement" })).rejects.toThrow(/allowlist/);
  });
  it("routes only the explicit OpenRouter credential and model", async () => {
    let captured: WorkerRunContext | undefined;
    const runtime = service({ provider: { kind: "openrouter" }, sourceEnv: { BRIDGE_OPENROUTER_API_KEY: "fixture-openrouter" }, run: async (context) => { captured = context; success(context); } });
    const item = await runtime.start({ repository: repo, task: "x", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(captured!.options.env!.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(captured!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe("fixture-openrouter");
    expect(captured!.options.env!.ANTHROPIC_API_KEY).toBe("");
    expect(captured!.options.env!.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-5.5");
  });
  it("rejects out-of-worktree file writes, including symlink escapes, before permission", async () => {
    const runtime = service({ run: async (context) => {
      const target = join(folder, "elsewhere"); mkdirSync(target);
      symlinkSync(target, join(context.worker.worktree, "outside"));
      const hook = context.options.hooks!.PreToolUse![0]!.hooks[0]!;
      const event = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(context.worker.worktree, "outside", "secret.txt"), content: "bad" } };
      const result = await (hook as (...args: unknown[]) => Promise<unknown>)(event, "t", { signal: context.options.abortController!.signal });
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "completed");
  });
  it("does not mark a missing result or error result completed", async () => {
    const missing = service({ run: async () => undefined });
    const a = await missing.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => missing.status(a.id).state === "failed");
    expect(missing.status(a.id).reason).toBe("native_result_missing");
    const failed = service({ stateRoot: join(folder, "other-state"), workspaceRoot: join(folder, "other-workspaces"), run: async (context) => context.message({ type: "result", subtype: "error_max_budget_usd", is_error: true }) });
    const b = await failed.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => failed.status(b.id).state === "failed");
    expect(failed.status(b.id).reason).toBe("error_max_budget_usd");
    expect(failed.status(b.id).usage).toBeUndefined();
  });
  it("keeps the root identity and fails a root success if a child failed", async () => {
    const runtime = service({ run: async (context) => {
      context.message({ type: "system", subtype: "init", session_id: "root-session" });
      context.message({ type: "result", parent_tool_use_id: "child-tool", session_id: "child-session", subtype: "error_max_turns", is_error: true });
      context.message({ type: "result", session_id: "root-session", subtype: "success", result: "Root says done." });
    } });
    const item = await runtime.start({ repository: repo, task: "Children.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id).sdkSessionId).toBe("root-session");
    expect(runtime.status(item.id).reason).toBe("child_task_failed");
    expect(runtime.status(item.id).children).toEqual([{ id: "tool:child-tool", state: "failed" }]);
  });
  it("does not treat a child result alone as root completion", async () => {
    const runtime = service({ run: async (context) => {
      context.message({ type: "result", parent_tool_use_id: "child-tool", session_id: "child-session", subtype: "success", result: "Child done." });
    } });
    const item = await runtime.start({ repository: repo, task: "Children.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id).sdkSessionId).toBeUndefined();
    expect(runtime.status(item.id).result).toBeUndefined();
    expect(runtime.status(item.id).reason).toBe("native_result_missing");
  });
  it("requires a completion notification for a known background task", async () => {
    const pending = service({ run: async (context) => {
      context.message({ type: "system", subtype: "task_started", task_id: "background-1", run_id: "run-1", session_id: "root" });
      context.message({ type: "result", subtype: "success", session_id: "root", result: "Root done." });
    } });
    const a = await pending.start({ repository: repo, task: "Background.", workflow: "implement" });
    await until(() => pending.status(a.id).state === "failed");
    expect(pending.status(a.id).reason).toBe("child_completion_unproven");
    const complete = service({ stateRoot: join(folder, "complete-state"), workspaceRoot: join(folder, "complete-workspaces"), run: async (context) => {
      context.message({ type: "system", subtype: "task_started", task_id: "background-1", run_id: "run-1", session_id: "root" });
      context.message({ type: "system", subtype: "task_notification", task_id: "background-1", run_id: "run-1", session_id: "root", status: "completed" });
      context.message({ type: "result", subtype: "success", session_id: "root", result: "Root done." });
    } });
    const b = await complete.start({ repository: repo, task: "Background.", workflow: "implement" });
    await until(() => complete.status(b.id).state === "completed");
  });
  it("enforces deadline even if an injected runner ignores abort", async () => {
    const runtime = service({ maxMs: 1000, run: async () => new Promise<void>(() => undefined) });
    const item = await runtime.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id).reason).toBe("deadline_exceeded");
  });
  it("keeps interrupted prior records unknown rather than restarting their task", async () => {
    const runtime = service();
    const item = await runtime.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "completed");
    await runtime.close();
    const path = join(folder, "state", item.id + ".json");
    const record = JSON.parse(readFileSync(path, "utf8")); record.state = "running"; record.cleanupVerified = null;
    writeFileSync(path, JSON.stringify(record)); chmodSync(path, 0o600);
    const restored = service();
    expect(restored.status(item.id).state).toBe("unknown");
    expect(restored.status(item.id).reason).toBe("service_restarted_without_process_ownership");
  });
});
