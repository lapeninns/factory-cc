import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSTREAM_DECISION_POLICY } from "../../src/runtime/decision-policy.js";
import { loadConfig } from "../../src/config.js";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { StableDroidToolNames } from "../../src/runtime/droid-mcp-catalog.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { sanitizedSubscriptionEnvironment } from "../../src/workers/subscription-auth.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ask = { name: "AskUser", input_schema: { type: "object", properties: { questionnaire: { type: "string" } }, required: ["questionnaire"], additionalProperties: false } };
const actions = {
  AskUser: { questionnaire: "1. [question] Which production account should receive the release?\n[topic] Essential account selection\n[option] Account A (Recommended)\n[option] Account B" },
  Execute: { command: "df -h ." },
  Create: { file_path: "/fixture/report.txt", content: "report" },
  Edit: { file_path: "/fixture/report.txt", old_str: "old", new_str: "new" },
  Task: { subagent_type: "general", prompt: "Inspect the owned fixture" },
  SpawnAgent: { task: "Inspect the owned fixture" },
  "factory-workers-pool___factory_worker_accounts": {},
  "factory-workers-pool___factory_worker_start": { repository: "/fixture/repository", task: "Inspect the owned fixture", workflow: "investigate", operationId: "fixture-inspection" },
};
const roots: string[] = [], runtimes: SdkRuntime[] = [];

class Fake implements SdkHandle {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, any> }> = [];
  observedResult?: unknown;
  secondInput?: Record<string, unknown>;
  secondResult?: unknown;
  constructor(readonly original: keyof typeof actions, readonly input = structuredClone(actions[original]) as Record<string, unknown>, readonly invoke = true) {}
  tool() { return {}; }
  createSdkMcpServer(options: Record<string, unknown>) { return { ...options, instance: {
    isConnected: () => false, sendToolListChanged: async () => {}, server: { sendToolListChanged: async () => {}, setRequestHandler() {} },
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      this.handlers.set(name, handler); return { update() {}, remove: () => this.handlers.delete(name) };
    },
  } }; }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args); const self = this;
    return { accountInfo: async () => ({ subscriptionType: "team", apiProvider: "firstParty", email: "team1@example.invalid" }), interrupt: async () => {}, close() {},
      mcpServerStatus: async () => [{ name: "droid", status: "connected", tools: [...self.handlers.keys()].map(name => ({ name })) }], async *[Symbol.asyncIterator]() {
      for await (const _ of args.prompt) {
        yield { type: "system", subtype: "init", session_id: "native", apiKeySource: "none" };
        if (self.invoke) {
          const name = new StableDroidToolNames().toMcp(self.original);
          const pending = self.handlers.get(name)!(self.input);
          const other = self.secondInput ? self.handlers.get(name)!(self.secondInput) : undefined;
          yield { type: "assistant", session_id: "native", message: { id: "native-message", content: [
            { type: "tool_use", id: "host-action", name: `mcp__droid__${name}`, input: self.input },
            ...(self.secondInput ? [{ type: "tool_use", id: "host-action-two", name: `mcp__droid__${name}`, input: self.secondInput }] : []),
          ] } };
          self.observedResult = await pending;
          if (other) self.secondResult = await other;
        }
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "native" };
      }
    } };
  }
}

function setup(options: { original?: keyof typeof actions; hostTools?: boolean; spawnAgents?: boolean; askTool?: boolean; invoke?: boolean; approvalPolicy?: "ask" | "bypass" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "controller-host-tools-")); roots.push(root);
  mkdirSync(join(root, "policies")); mkdirSync(join(root, "workflows"));
  writeFileSync(join(root, "policies/team-policy.md"), "Fixture policy.\n");
  writeFileSync(join(root, "workflows/implement.md"), "Fixture workflow.\n");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/fixture/team1");
  vi.stubEnv("BRIDGE_SDK_CWD", root);
  const config = loadConfig({ mode: "sdk", authMode: "subscription", desktopProfile: true, desktopJobs: true, desktopLifecycle: true,
    desktopRuntimePath: root, desktopStateRoot: join(root, "state"), controllerReadOnly: true, workerPool: true, controllerPool: true,
    controllerHostTools: options.hostTools !== false, controllerSpawnAgents: options.spawnAgents, controllerApprovalPolicy: options.approvalPolicy,
    workerControlFile: join(root, "control.json"), workerMcpPrefix: "factory-workers-pool___",
    subscriptionProfile: "team1", subscriptionExpectedEmail: "team1@example.invalid",
    subscriptionAccounts: SUBSCRIPTION_PROFILES.map(profile => ({ profile, expectedEmail: `${profile}@example.invalid`, weight: 1,
      env: sanitizedSubscriptionEnvironment({ PATH: process.env.PATH }, `/fixture/${profile}`) })),
    dataDir: join(root, "data"), sdkCwd: root, models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "fixture" }],
    permissionMode: "ask", requestTimeoutMs: 1000, toolWaitMs: 1000, approvalTimeoutMs: 1000,
  });
  const original = options.original ?? "Execute", fake = new Fake(original, undefined, options.invoke !== false);
  const runtime = new SdkRuntime(config, logger, fake); runtimes.push(runtime);
  let mode = "auto";
  const control = { factoryPermissionMode: () => mode, requestApproval: vi.fn(async () => ({ behavior: "deny" as const, message: "Not the host action channel" })) };
  runtime.setControl(control);
  const definition = { name: original, input_schema: { type: "object", properties: Object.fromEntries(Object.keys(actions[original]).map(key => [key, { type: "string" }])), required: Object.keys(actions[original]), additionalProperties: false } };
  const base: RuntimeRequest = { role: "orchestrator", headers: {}, request: { model: "claude-opus-5-5", max_tokens: 10,
    messages: [{ role: "user", content: "run the bounded host action" }], tools: [...(options.askTool === false ? [] : [ask]), definition] },
    session: { bridgeSessionId: "session-host", role: "orchestrator", state: "NEW", model: "claude-opus-5-5", claudeAccount: "team1", nativeGeneration: 0,
      toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
  return { runtime, fake, base, control, setMode: (value: string) => { mode = value; } };
}
function toolResult(base: RuntimeRequest, id: string, content: string): RuntimeRequest {
  return { ...base, request: { ...base.request, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }] } };
}
function answer(base: RuntimeRequest, question: any, choice = "Allow this action once") {
  const text = question.input.questionnaire.split("\n")[0].replace("1. [question] ", "");
  return toolResult(base, question.id, `1. [question] ${text}\n[answer] ${choice}`);
}
const callFrom = (turn: Awaited<ReturnType<SdkRuntime["handle"]>>) => turn.response.content.find(block => block.type === "tool_use") as any;

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|BRIDGE_|OPENROUTER_)/.test(name)) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs(); vi.clearAllMocks();
});

describe("exactly approved Factory host operations", () => {
  it.each(["factory-workers-pool___factory_worker_accounts", "factory-workers-pool___factory_worker_start"] as const)("forwards advertised %s with host tools enabled", async original => {
    const { runtime, fake, base } = setup({ original, approvalPolicy: "bypass" });
    const action = callFrom(await runtime.handle(base));
    expect(action).toMatchObject({ name: original, input: actions[original] });
    expect((await runtime.handle(toolResult(base, action.id, "host result"))).response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: false });
  });

  it("includes the shared policy and leaves essential recommended questions waiting for a real answer", async () => {
    const { runtime, fake, base, control } = setup({ original: "AskUser", approvalPolicy: "bypass", askTool: false });
    const question = callFrom(await runtime.handle(base));
    expect(fake.calls[0]!.options.systemPrompt.append).toContain(WORKSTREAM_DECISION_POLICY);
    expect(question).toMatchObject({ name: "AskUser", input: actions.AskUser });
    expect(fake.observedResult).toBeUndefined();
    expect(runtime.pendingHostCalls(base.session.bridgeSessionId)).toHaveLength(1);
    expect(control.requestApproval).not.toHaveBeenCalled();
    await runtime.handle(toolResult(base, question.id, "Account B"));
    expect(fake.observedResult).toMatchObject({ content: [{ type: "text", text: "Account B" }] });
  });

  it.each(["Task", "SpawnAgent"] as const)("keeps %s delegation on the managed worker path", async original => {
    const { runtime, fake, base } = setup({ original, invoke: false, approvalPolicy: "bypass" });
    await runtime.handle(base);
    const name = `mcp__droid__${new StableDroidToolNames().toMcp(original)}`;
    expect(fake.handlers.has(name.slice("mcp__droid__".length))).toBe(false);
    const options = fake.calls[0]!.options;
    expect(await options.hooks.PreToolUse[0].hooks[0]({ tool_name: name, tool_input: actions[original] }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await options.canUseTool(name, actions[original])).toMatchObject({ behavior: "deny" });
    expect(options.systemPrompt.append).toContain("delegate useful independent work through factory_worker_start");
    expect(options.systemPrompt.append).not.toContain("Use synchronous Factory Task");
  });

  it("publishes SpawnAgent for visible Workstream agents when the operator opts in", async () => {
    const { runtime, fake, base, control } = setup({ original: "SpawnAgent", spawnAgents: true, approvalPolicy: "bypass", askTool: false });
    const first = await runtime.handle(base), action = callFrom(first);
    expect(action).toMatchObject({ name: "SpawnAgent", id: "host-action", input: actions.SpawnAgent });
    const append = fake.calls[0]!.options.systemPrompt.append as string;
    expect(append).toContain("Delegate work the user should see and steer with SpawnAgent");
    expect(append).toContain("InterruptAgent stops its current turn");
    expect(append).toContain("Use factory_worker_start only when");
    expect(append).toContain("Factory Task is unavailable in this controller");
    expect(append).not.toContain("SpawnAgent are unavailable");
    expect((await runtime.handle(toolResult(base, action.id, "agent started"))).response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: false });
    expect(control.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps Factory Task on the managed worker path when SpawnAgent is enabled", async () => {
    const { runtime, fake, base } = setup({ original: "Task", spawnAgents: true, invoke: false, approvalPolicy: "bypass" });
    await runtime.handle(base);
    const name = `mcp__droid__${new StableDroidToolNames().toMcp("Task")}`;
    expect(fake.handlers.has(name.slice("mcp__droid__".length))).toBe(false);
    expect(await fake.calls[0]!.options.canUseTool(name, actions.Task)).toMatchObject({ behavior: "deny" });
  });

  it("refuses SpawnAgent opt-in without pooled host tools", () => {
    expect(() => setup({ hostTools: false, spawnAgents: true })).toThrow(/SpawnAgent delegation requires pooled subscription host tools/);
  });

  it("keeps newly discovered Factory Task and SpawnAgent tools outside the active catalog", async () => {
    const { runtime, fake, base } = setup({ invoke: false, approvalPolicy: "bypass" });
    await runtime.handle(base);
    const discovered = {
      ...base,
      request: {
        ...base.request,
        messages: [{ role: "user" as const, content: "Continue with the newly discovered tools" }],
        tools: [...base.request.tools!, ...(["Task", "SpawnAgent"] as const).map(name => ({
          name, input_schema: { type: "object" as const },
        }))],
      },
    };
    await runtime.handle(discovered);
    const options = fake.calls[0]!.options;
    for (const original of ["Task", "SpawnAgent"] as const) {
      const name = `mcp__droid__${new StableDroidToolNames().toMcp(original)}`;
      expect(fake.handlers.has(name.slice("mcp__droid__".length))).toBe(false);
      expect(await options.hooks.PreToolUse[0].hooks[0]({ tool_name: name, tool_input: actions[original] }))
        .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(await options.canUseTool(name, actions[original])).toMatchObject({ behavior: "deny" });
    }
  });

  it("records authenticated completion without resuming the SDK before admission", async () => {
    const { runtime, fake, base } = setup({ approvalPolicy: "bypass" });
    const action = callFrom(await runtime.handle(base));
    const receipt = { toolUseId: action.id, toolName: "Execute", input: action.input, content: "authenticated result [factory-cc-session:" + "a".repeat(64) + "]" };
    runtime.validateHostToolCompletion(base.session.bridgeSessionId, receipt);
    expect(await runtime.recordHostToolCompletion(base.session.bridgeSessionId, receipt)).toBe("accepted");
    expect(await runtime.recordHostToolCompletion(base.session.bridgeSessionId, receipt)).toBe("duplicate");
    expect(fake.observedResult).toBeUndefined();
    expect(runtime.pendingHostCalls(base.session.bridgeSessionId)).toHaveLength(1);
    const next = toolResult(base, action.id, "Droid display wrapper differs");
    next.session = { ...base.session, hostCompletionReceipts: [receipt] };
    expect((await runtime.handle(next)).response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("authenticated result") }] });
    expect(JSON.stringify(fake.observedResult)).not.toContain("factory-cc-session:");
    expect(await runtime.recordHostToolCompletion(base.session.bridgeSessionId, receipt)).toBe("duplicate");
  });

  it("rejects conflicting authenticated completion and keeps the original pending action", async () => {
    const { runtime, fake, base } = setup({ approvalPolicy: "bypass" });
    const action = callFrom(await runtime.handle(base));
    const receipt = { toolUseId: action.id, toolName: "Execute", input: action.input, content: "first result" };
    await runtime.recordHostToolCompletion(base.session.bridgeSessionId, receipt);
    await expect(runtime.recordHostToolCompletion(base.session.bridgeSessionId, { ...receipt, content: "changed" }))
      .rejects.toMatchObject({ code: "conflicting_host_completion" });
    expect(fake.observedResult).toBeUndefined();
    await runtime.handle(toolResult(base, action.id, "first result"));
  });

  it.each(["Execute", "Create", "Edit"] as const)("explicit bypass publishes %s without the extra AskUser question", async original => {
    const { runtime, fake, base, control } = setup({ original, approvalPolicy: "bypass", askTool: false });
    const first = await runtime.handle(base), action = callFrom(first);
    expect(action).toMatchObject({ name: original, id: "host-action", input: actions[original] });
    expect(first.response.content.some(block => block.type === "tool_use" && block.name === "AskUser")).toBe(false);
    expect(fake.calls[0]!.options).toMatchObject({ permissionMode: "default", allowDangerouslySkipPermissions: false });
    expect(runtime.describe()).toMatchObject({ controllerHostTools: true, controllerApprovalPolicy: "bypass", permissionMode: "ask", pendingApprovals: 0 });
    expect(fake.calls[0]!.options.systemPrompt.append).toContain("Factory's own permissions still apply");
    expect((await runtime.handle(toolResult(base, action.id, "host result"))).response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: false });
    expect(control.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps Factory spec mode authoritative with bridge approval bypass", async () => {
    const { runtime, fake, base, setMode } = setup({ approvalPolicy: "bypass" });
    setMode("spec");
    const result = await runtime.handle(base);
    expect(result.response.content.some(block => block.type === "tool_use")).toBe(false);
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("bypass retains the input snapshot and rejects a stale handler after cancellation", async () => {
    const { runtime, fake, base } = setup({ approvalPolicy: "bypass" });
    const action = callFrom(await runtime.handle(base));
    fake.input.command = "changed after dispatch";
    expect(action.input).toEqual({ command: "df -h ." });
    const handler = fake.handlers.get(new StableDroidToolNames().toMcp("Execute"))!;
    await runtime.cancel(base.session.bridgeSessionId, "cancelled by test");
    await expect(handler({ command: "pwd" })).rejects.toMatchObject({ code: "stale_native_query" });
  });

  it("bypass keeps direct native writes, shell, Workflow and agent spawning blocked", async () => {
    const { runtime, fake, base } = setup({ approvalPolicy: "bypass", invoke: false });
    await runtime.handle(base);
    const options = fake.calls[0]!.options, hook = options.hooks.PreToolUse[0].hooks[0];
    for (const tool of ["Bash", "Write", "Edit", "Workflow", "Task", "SpawnAgent"]) {
      expect(await hook({ tool_name: tool, tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(await options.canUseTool(tool, {})).toMatchObject({ behavior: "deny" });
    }
  });

  it.each(["Execute", "Create", "Edit"] as const)("asks before publishing %s and then forwards the exact approved action", async original => {
    const { runtime, fake, base, control } = setup({ original });
    const first = await runtime.handle(base), question = callFrom(first);
    expect(question.name).toBe("AskUser");
    expect(question.input.questionnaire).toContain(`Factory host action ${original}`);
    expect(first.response.content.some(block => block.type === "tool_use" && block.name === original)).toBe(false);
    const approved = await runtime.handle(answer(base, question)), action = callFrom(approved);
    expect(action).toMatchObject({ name: original, id: "host-action", input: actions[original] });
    const complete = await runtime.handle(toolResult(base, action.id, "bounded host result"));
    expect(complete.response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: false });
    expect(control.requestApproval).not.toHaveBeenCalled();
  });

  it.each(["Deny this action", "allow"])("does not publish the host command after answer %s", async choice => {
    const { runtime, fake, base } = setup();
    const question = callFrom(await runtime.handle(base));
    const complete = await runtime.handle(answer(base, question, choice));
    expect(complete.response.stop_reason).toBe("end_turn");
    expect(complete.response.content.some(block => block.type === "tool_use" && block.name === "Execute")).toBe(false);
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("does not expose host operations without the explicit operator flag", async () => {
    const { runtime, fake, base } = setup({ hostTools: false, invoke: false });
    await runtime.handle(base);
    expect([...fake.handlers.keys()]).not.toContain(new StableDroidToolNames().toMcp("Execute"));
  });

  it("refuses the operation when the host does not advertise a supported AskUser", async () => {
    const { runtime, fake, base } = setup({ askTool: false });
    const complete = await runtime.handle(base);
    expect(complete.response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("rechecks authenticated Factory spec mode after the question", async () => {
    const { runtime, fake, base, setMode } = setup();
    const question = callFrom(await runtime.handle(base)); setMode("spec");
    expect((await runtime.handle(answer(base, question))).response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("keeps the approved input snapshot if the native caller later mutates its object", async () => {
    const { runtime, fake, base } = setup();
    const question = callFrom(await runtime.handle(base)); fake.input.command = "unreviewed command";
    const action = callFrom(await runtime.handle(answer(base, question)));
    expect(action.input).toEqual({ command: "df -h ." });
    await runtime.handle(toolResult(base, action.id, "bounded host result"));
  });

  it("refuses a competing host action while the first approval is pending", async () => {
    const { runtime, fake, base } = setup(); fake.secondInput = { command: "pwd" };
    const question = callFrom(await runtime.handle(base));
    expect(question.name).toBe("AskUser");
    const action = callFrom(await runtime.handle(answer(base, question)));
    expect(action).toMatchObject({ id: "host-action", name: "Execute", input: { command: "df -h ." } });
    const complete = await runtime.handle(toolResult(base, action.id, "bounded host result"));
    expect(complete.response.stop_reason).toBe("end_turn");
    expect(fake.secondResult).toMatchObject({ isError: true });
    expect(complete.response.content.some(block => block.type === "tool_use")).toBe(false);
  });

  it("does not execute after the host withdraws the tool while approval is pending", async () => {
    const { runtime, fake, base } = setup();
    const question = callFrom(await runtime.handle(base));
    const withdrawn = answer(base, question);
    withdrawn.request.tools = [ask];
    const complete = await runtime.handle(withdrawn);
    expect(complete.response.stop_reason).toBe("end_turn");
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("cancellation while approval is pending cannot send the host operation", async () => {
    const { runtime, fake, base } = setup();
    expect(callFrom(await runtime.handle(base)).name).toBe("AskUser");
    await runtime.cancel(base.session.bridgeSessionId, "cancelled by test");
    expect(fake.observedResult).toMatchObject({ isError: true });
  });

  it("keeps direct native write and shell tools denied", async () => {
    const { runtime, fake, base } = setup({ invoke: false }); await runtime.handle(base);
    const options = fake.calls[0]!.options;
    const hook = options.hooks.PreToolUse[0].hooks[0];
    expect(await hook({ tool_name: "Bash", tool_input: { command: "df -h ." } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await options.canUseTool("Write", { file_path: "/fixture/file", content: "x" })).toMatchObject({ behavior: "deny" });
  });
});
