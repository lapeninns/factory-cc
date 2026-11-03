import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { StableDroidToolNames } from "../../src/runtime/droid-mcp-catalog.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { sanitizedSubscriptionEnvironment } from "../../src/workers/subscription-auth.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ask = { name: "AskUser", input_schema: { type: "object", properties: { questionnaire: { type: "string" } }, required: ["questionnaire"], additionalProperties: false } };
const actions = {
  Execute: { command: "df -h ." },
  Create: { file_path: "/fixture/report.txt", content: "report" },
  Edit: { file_path: "/fixture/report.txt", old_str: "old", new_str: "new" },
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

function setup(options: { original?: keyof typeof actions; hostTools?: boolean; askTool?: boolean; invoke?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "controller-host-tools-")); roots.push(root);
  mkdirSync(join(root, "policies")); mkdirSync(join(root, "workflows"));
  writeFileSync(join(root, "policies/team-policy.md"), "Fixture policy.\n");
  writeFileSync(join(root, "workflows/implement.md"), "Fixture workflow.\n");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/fixture/team1");
  vi.stubEnv("BRIDGE_SDK_CWD", root);
  const config = loadConfig({ mode: "sdk", authMode: "subscription", desktopProfile: true, desktopJobs: true, desktopLifecycle: true,
    desktopRuntimePath: root, desktopStateRoot: join(root, "state"), controllerReadOnly: true, workerPool: true, controllerPool: true,
    controllerHostTools: options.hostTools !== false, workerControlFile: join(root, "control.json"), workerMcpPrefix: "factory-workers-pool___",
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
