import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { APIWorkerService, type APIWorkerServiceOptions, type WorkerRunContext } from "../../src/workers/service.js";
import { WORKSTREAM_DECISION_POLICY } from "../../src/runtime/decision-policy.js";
import { BridgeError } from "../../src/types.js";
import { WorkerStartRejected } from "../../src/workers/start-rejection.js";
import { startWorkerControl } from "../../src/workers/control.js";
import { decideWorkerApproval, readPendingWorkerApprovals } from "../../src/runtime/worker-permission-client.js";
import * as workerState from "../../src/workers/worker-state.js";

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
  afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); vi.restoreAllMocks(); });
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

  it("retains accepted operation evidence when worktree creation cannot be confirmed", async () => {
    const runtime = service();
    writeFileSync(join(repo, ".git", "worktrees"), "fixture obstruction");
    const input = { repository: repo, task: "fixture", workflow: "investigate" as const, operationId: "accepted-operation", operationOwner: "a".repeat(64) };
    const result = await runtime.start(input);
    expect(result).toMatchObject({ state: "unknown", reason: "workspace_preparation_unconfirmed", cleanupVerified: null });
    expect(runtime.lookup(input.operationId, input.operationOwner)).toMatchObject({ id: result.id });
    expect((await runtime.start(input)).id).toBe(result.id);
    expect(runtime.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(folder, "state", result.id + ".json"), "utf8"))).toMatchObject({ operation: { id: input.operationId } });
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
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining(WORKSTREAM_DECISION_POLICY) });
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining("Shared policy marker.") });
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining("return a final blocked handoff containing the exact question, available options and relevant context to the controller.") });
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining("Do not invoke AskUserQuestion or another questionnaire tool to collect user choices from this worker, and never invent a user answer.") });
  });
  it("includes routine decision autonomy with the default worker policy while preserving permission gates", async () => {
    let captured: WorkerRunContext | undefined;
    let decision: unknown;
    const input = { command: "deploy --recommended", description: "Deploy production (Recommended)" };
    const runtime = service({ run: async (context) => {
      captured = context;
      decision = await context.options.canUseTool!("Bash", input, { signal: context.options.abortController!.signal, toolUseID: "recommended-action", requestId: "recommended-request" });
      success(context);
    } });
    const item = await runtime.start({ repository: repo, task: "Prepare a reviewable change.", workflow: "implement" });
    await until(() => runtime.status(item.id).state === "waiting_approval");
    expect(captured!.options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: expect.stringContaining(WORKSTREAM_DECISION_POLICY) });
    expect(captured!.options.systemPrompt).toMatchObject({ append: expect.stringContaining("This worker's approval transport carries allow/deny decisions and cannot deliver selected AskUserQuestion answers.") });
    expect(captured!.options.permissionMode).toBe("default");
    expect(decision).toBeUndefined();
    const pending = runtime.status(item.id).approvals[0]!;
    expect(pending).toMatchObject({ toolName: "Bash", input });
    runtime.approve({ id: item.id, approvalId: pending.id, decision: "deny" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(decision).toMatchObject({ behavior: "deny" });
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
  it("keeps the native error result as the failure reason when the SDK throws afterwards", async () => {
    const runtime = service({ run: async (context) => {
      context.message({ type: "system", subtype: "init", session_id: "turn-limit-session" });
      context.message({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "turn-limit-session" });
      throw new Error("Reached maximum number of turns");
    } });
    const worker = await runtime.start({ repository: repo, task: "x", workflow: "implement" });
    await until(() => runtime.status(worker.id).state === "failed");
    const status = runtime.status(worker.id);
    expect(status).toMatchObject({ reason: "error_max_turns", failure: { stage: "execution", code: "error_max_turns" }, sdkSessionId: "turn-limit-session" });
    const cwd = status.workingDirectory ?? status.worktree;
    expect(status.transcriptPath).toBe(join(folder, "state", "native-config", worker.id, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "turn-limit-session.jsonl"));
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

  it("deduplicates concurrent operation starts and recovers the same result after restart", async () => {
    let executions = 0;
    const runtime = service({ run: async context => { executions++; success(context); } });
    const input = { repository: repo, task: "one side effect", workflow: "implement" as const, operationId: "request-1", operationOwner: "a".repeat(64) };
    const [first, second] = await Promise.all([runtime.start(input), runtime.start(input)]);
    expect(second.id).toBe(first.id);
    await until(() => runtime.status(first.id).state === "completed");
    expect(executions).toBe(1);
    await expect(runtime.start({ ...input, task: "different input" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(runtime.lookup(input.operationId, "b".repeat(64))).toEqual({ found: false });
    await runtime.close();
    const restored = service({ run: async context => { executions++; success(context); } });
    const recovered = await restored.start(input);
    expect(recovered).toMatchObject({ id: first.id, state: "completed", cleanupVerified: true, leaseReleased: true });
    expect(executions).toBe(1);
    expect(restored.list()).toHaveLength(1);
  });

  it("keeps identical operation IDs isolated by owner and preserves legacy starts", async () => {
    const runtime = service();
    const input = { repository: repo, task: "fixture", workflow: "investigate" as const, operationId: "same-id" };
    const a = await runtime.start({ ...input, operationOwner: "a".repeat(64) });
    const b = await runtime.start({ ...input, operationOwner: "b".repeat(64) });
    expect(a.id).not.toBe(b.id);
    const legacy = await runtime.start({ repository: repo, task: "legacy", workflow: "investigate" });
    expect(legacy.operation).toBeUndefined();
    await expect(runtime.start({ ...input, operationOwner: undefined })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reserves bounded pending admission before concurrent starts create workspaces", async () => {
    const runtime = service({ maxConcurrent: 1, maxPendingWorkers: 2, run: async () => new Promise<void>(() => undefined) });
    const input = { repository: repo, task: "fixture", workflow: "investigate" as const };
    const results = await Promise.allSettled([runtime.start(input), runtime.start(input), runtime.start(input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "capacity_unavailable" } });
    expect(runtime.list()).toHaveLength(2);
    expect(readdirSync(join(folder, "workspaces"))).toHaveLength(2);
    const queued = runtime.list().find(worker => worker.state === "queued")!;
    await runtime.cancel(queued.id);
    const replacement = await runtime.start(input);
    expect(replacement.state).toBe("queued");
    expect(runtime.list()).toHaveLength(3);
  });

  it("persists recoverable task input before accepted intent and workspace creation", async () => {
    const events: string[] = [];
    const originalTask = workerState.writeWorkerTask, originalWorker = workerState.writeWorker;
    vi.spyOn(workerState, "writeWorkerTask").mockImplementation((root, id, task) => {
      events.push("task");
      expect(existsSync(join(folder, "workspaces", id))).toBe(false);
      originalTask(root, id, task);
    });
    vi.spyOn(workerState, "writeWorker").mockImplementation((root, record) => {
      const pending = join(root, ".pending-task-" + record.id + ".json");
      expect(existsSync(pending)).toBe(true);
      if (record.state === "starting") {
        events.push("intent");
        expect(existsSync(record.worktree)).toBe(false);
      } else if (record.state === "queued") {
        events.push("workspace");
        expect(existsSync(record.worktree)).toBe(true);
      }
      originalWorker(root, record);
    });
    const runtime = service({ executionHost: {
      start: async worker => ({ ...worker, state: "running", approvals: [] }),
      status: worker => ({ ...worker, state: "running", approvals: [] }),
      cancel: async worker => ({ ...worker, state: "cancelled", approvals: [] }),
      approve: async worker => ({ ...worker, approvals: [] }),
      detach: async () => {},
    } });
    await runtime.start({ repository: repo, task: "recoverable fixture input", workflow: "investigate" });
    expect(events.slice(0, 3)).toEqual(["task", "intent", "workspace"]);
  });

  it("keeps successful output nonterminal until cleanup and lease release settle", async () => {
    let cleanup!: () => void, release!: () => void;
    let cleanupEntered = false, releaseEntered = false;
    const runtime = service({
      cleanup: async () => { cleanupEntered = true; await new Promise<void>(resolve => { cleanup = resolve; }); },
      acquireLease: async () => ({ release: async () => { releaseEntered = true; await new Promise<void>(resolve => { release = resolve; }); } }),
    });
    const item = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => cleanupEntered);
    expect(runtime.status(item.id)).toMatchObject({ state: "cleaning", resultState: "completed", result: "Worker fixture complete.", cleanupVerified: null, leaseReleased: false });
    expect(runtime.status(item.id).endedAt).toBeUndefined();
    cleanup();
    await until(() => releaseEntered);
    expect(runtime.status(item.id)).toMatchObject({ state: "cleaning", cleanupVerified: true, leaseReleased: false });
    release();
    await until(() => runtime.status(item.id).state === "completed");
    expect(runtime.status(item.id)).toMatchObject({ cleanupVerified: true, leaseReleased: true, settledAt: expect.any(String), endedAt: expect.any(String) });
  });

  it("preserves successful results when cleanup or lease release fails", async () => {
    const cleanupFailed = service({ cleanup: async () => { throw new Error("private cleanup detail"); } });
    const a = await cleanupFailed.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => cleanupFailed.status(a.id).state === "unknown");
    expect(cleanupFailed.status(a.id)).toMatchObject({ resultState: "completed", result: "Worker fixture complete.", cleanupVerified: false, failure: { stage: "cleanup" } });
    await cleanupFailed.close();
    const releaseFailed = service({ stateRoot: join(folder, "other-state"), cleanup: async () => {}, acquireLease: async () => ({ release: async () => { throw new Error("private lease detail"); } }) });
    const b = await releaseFailed.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => releaseFailed.status(b.id).state === "unknown");
    expect(releaseFailed.status(b.id)).toMatchObject({ resultState: "completed", result: "Worker fixture complete.", cleanupVerified: true, leaseReleased: false, failure: { stage: "lease_release" } });
    expect(releaseFailed.status(b.id).settledAt).toBeUndefined();
  });

  it.each(["desktop_job_workspace", "desktop_job_binding"])("preserves a confirmed pre-admission %s refusal without finalizing a nonexistent lease", async code => {
    const finalizeLease = vi.fn(async () => { throw new Error("No lease was created"); });
    const run = vi.fn(async (context: WorkerRunContext) => { success(context); });
    const runtime = service({ acquireLease: async () => { throw new BridgeError(422, code, "Fixture admission refusal"); }, finalizeLease, run });
    const item = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id)).toMatchObject({ reason: code, resultState: "failed", cleanupVerified: true,
      leaseReleased: true, failure: { stage: "admission", code } });
    expect(finalizeLease).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("confirms verified cleanup through the owner's update when a lease release is not acknowledged", async () => {
    const finalizeLease = vi.fn(async (_worker: unknown, _result: unknown) => { if (finalizeLease.mock.calls.length < 2) throw new Error("Stopped helper still owns the record"); });
    const runtime = service({ cleanup: async () => {}, leaseRecoveryDelaysMs: [0, 0, 0], finalizeLease,
      acquireLease: async () => ({ release: async () => { throw new Error("Release acknowledgement timed out"); } }) });
    const item = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "completed");
    expect(finalizeLease).toHaveBeenCalledTimes(2);
    expect(finalizeLease.mock.calls[1][1]).toMatchObject({ state: "completed", cleanupVerified: true });
    expect(runtime.status(item.id)).toMatchObject({ resultState: "completed", cleanupVerified: true, leaseReleased: true });
    expect(runtime.status(item.id).settledAt).toBeDefined();
  });

  it("keeps the lease uncertain when no confirmation retry succeeds or cleanup is unverified", async () => {
    const finalizeLease = vi.fn(async () => { throw new Error("Release remains unconfirmed"); });
    const release = async () => { throw new Error("Release acknowledgement timed out"); };
    const exhausted = service({ cleanup: async () => {}, leaseRecoveryDelaysMs: [0, 0], finalizeLease, acquireLease: async () => ({ release }) });
    const a = await exhausted.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => exhausted.status(a.id).state === "unknown");
    expect(finalizeLease).toHaveBeenCalledTimes(2);
    expect(exhausted.status(a.id)).toMatchObject({ cleanupVerified: true, leaseReleased: false, reason: "shared_lease_release_unproven" });
    await exhausted.close();
    finalizeLease.mockClear();
    const unverified = service({ stateRoot: join(folder, "other-state"), cleanup: async () => { throw new Error("cleanup unproven"); },
      leaseRecoveryDelaysMs: [0], finalizeLease, acquireLease: async () => ({ release }) });
    const b = await unverified.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => unverified.status(b.id).state === "unknown" && unverified.status(b.id).endedAt !== undefined);
    expect(finalizeLease).not.toHaveBeenCalled();
    expect(unverified.status(b.id)).toMatchObject({ cleanupVerified: false, leaseReleased: false });
  });

  it("retains uncertain admission when the control channel fails without proof of rejection", async () => {
    const finalizeLease = vi.fn(async () => { throw new Error("Release remains unconfirmed"); });
    const runtime = service({ acquireLease: async () => { throw new BridgeError(503, "desktop_job_channel", "Fixture transport failure"); }, finalizeLease });
    const item = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "unknown");
    expect(finalizeLease).toHaveBeenCalledTimes(1);
    expect(runtime.status(item.id)).toMatchObject({ cleanupVerified: true, leaseReleased: false, reason: "shared_lease_release_unproven" });
  });

  it("persists a bounded error code and phase without the native error message", async () => {
    const runtime = service({ run: async () => { throw Object.assign(new Error("private token text"), { code: "ECONNRESET" }); } });
    const item = await runtime.start({ repository: repo, task: "fixture", workflow: "investigate" });
    await until(() => runtime.status(item.id).state === "failed");
    expect(runtime.status(item.id).failure).toMatchObject({ stage: "execution", code: "ECONNRESET" });
    expect(readFileSync(join(folder, "state", item.id + ".json"), "utf8")).not.toContain("private token text");
  });
});
