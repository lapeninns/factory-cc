import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import { StableDroidToolNames } from "../../src/runtime/droid-mcp-catalog.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { ToolDefinition } from "../../src/types.js";

const prefix = "mcp__factory_workers_team1__";
const workerNames = ["factory_worker_start", "factory_worker_status", "factory_worker_wait", "factory_worker_list", "factory_worker_cancel"].map((name) => prefix + name);
const allowedNames = ["Read", "LS", "Grep", "Glob", "ToolSearch", "AskUser", ...workerNames];
const deniedNames = ["Execute", "Create", "Write", "Edit", "Task", "SpawnAgent", "Skill", "StartMissionRun", "ExitSpecMode", "TodoWrite", "mcp__other__factory_worker_start", prefix + "factory_worker_status_extra", "mcp__database__write"];
const tools = (names: string[]): ToolDefinition[] => names.map((name) => ({ name, input_schema: { type: "object", properties: {} } }));
const runtimes: SdkRuntime[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

class Fake implements SdkHandle {
  calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  tool() { return {}; }
  createSdkMcpServer(options: Record<string, unknown>) { return { ...options, instance: {
    isConnected: () => false, sendToolListChanged: async () => {}, server: { sendToolListChanged: async () => {}, setRequestHandler() {} },
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      this.handlers.set(name, handler); return { update() {}, remove: () => this.handlers.delete(name) };
    },
  } }; }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args); const self = this;
    return { accountInfo: async () => ({ apiKeySource: "ANTHROPIC_API_KEY" }), interrupt: async () => {}, close() {},
      mcpServerStatus: async () => [{ name: "droid", status: "connected", tools: [...self.handlers.keys()].map((name) => ({ name })) }],
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: "system", subtype: "init", session_id: "native", apiKeySource: "ANTHROPIC_API_KEY" };
          yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "native" };
        }
      },
    };
  }
}
function setup(readOnly = true) {
  const loaded = loadConfig({ mode: "sdk", authMode: "anthropic-api", desktopProfile: true, permissionMode: "ask",
    workerMcpPrefix: prefix, workerControlFile: "/private/offline-worker-control.json",
    dataDir: mkdtempSync(join(tmpdir(), "controller-readonly-")), requestTimeoutMs: 1000, toolWaitMs: 1000 });
  // Runtime-only unit fixture: production loadConfig separately requires the
  // fixed-seat route and makes this operator-selected flag immutable.
  const config = { ...loaded, controllerReadOnly: readOnly };
  const fake = new Fake(), runtime = new SdkRuntime(config, logger, fake); runtimes.push(runtime);
  const base: RuntimeRequest = { role: "chat", headers: {}, request: { model: "claude-opus-5-5", max_tokens: 10,
    messages: [{ role: "user", content: "inspect only" }], tools: tools([...allowedNames, ...deniedNames]) },
    session: { bridgeSessionId: "a", role: "chat", state: "NEW", model: "claude-opus-5-5", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
  return { config, fake, runtime, base };
}
const nativeName = (original: string) => `mcp__droid__${new StableDroidToolNames().toMcp(original)}`;
const hook = (fake: Fake) => (fake.calls[0].options.hooks as any).PreToolUse[0].hooks[0];

beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "offline-fixture-key"); vi.stubEnv("BRIDGE_SDK_CWD", process.cwd()); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); vi.unstubAllEnvs(); });

it("advertises only allowed host controls and exact configured worker tools", async () => {
  const { fake, runtime, base } = setup(); await runtime.handle(base);
  const mapped = (names: string[]) => names.map((name) => new StableDroidToolNames().toMcp(name));
  // File reads retain the existing native read-tool path instead of duplicate MCP registrations.
  expect([...fake.handlers.keys()].sort()).toEqual(mapped(["ToolSearch", "AskUser", ...workerNames]).sort());
  expect(fake.calls[0].options.systemPrompt).toMatchObject({ append: expect.stringContaining("This Factory controller is read-only") });
  expect(fake.calls[0].options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Task", "Agent", "Workflow"]));
  for (const original of deniedNames) expect(fake.handlers.has(new StableDroidToolNames().toMcp(original))).toBe(false);
});

it("filters blocked dynamically discovered tools and admits only an exact allowed addition", async () => {
  const { runtime, fake, base } = setup();
  base.request.tools = tools(["ToolSearch", "AskUser", workerNames[0]]);
  await runtime.handle(base);
  const next = { ...base, request: { ...base.request, messages: [{ role: "user" as const, content: "inspect discovered tools" }],
    tools: tools(["ToolSearch", "AskUser", workerNames[0], workerNames[1], ...deniedNames]) } };
  await runtime.handle(next);
  const expected = ["ToolSearch", "AskUser", workerNames[0], workerNames[1]].map((name) => new StableDroidToolNames().toMcp(name));
  expect([...fake.handlers.keys()].sort()).toEqual(expected.sort());
  expect(fake.calls).toHaveLength(1);
});

it("rejects blocked invocation even when old registration and native hook remain available", async () => {
  const { config, runtime, fake, base } = setup(false); await runtime.handle(base);
  const oldExecute = fake.handlers.get("Execute")!;
  expect(oldExecute).toBeTypeOf("function");
  Object.defineProperty(config, "controllerReadOnly", { value: true });
  await expect(oldExecute({ command: "touch must-not-exist" })).rejects.toMatchObject({ code: "controller_tool_denied" });
  expect(await hook(fake)({ tool_name: nativeName("Execute"), tool_input: { command: "false" } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(runtime.pendingHostCalls("a")).toEqual([]);
});

it("fails closed for native side effects, unknown names and prefix lookalikes", async () => {
  const { runtime, fake, base } = setup(); await runtime.handle(base);
  for (const name of ["Bash", "Write", "Edit", "Task", "Agent", "Workflow", "ToolSearch", "mcp__droid__not_registered", nativeName(prefix + "factory_worker_status_extra")]) {
    expect(await hook(fake)({ tool_name: name, tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  }
  for (const name of ["Read", "LS", "Grep", "Glob"]) expect(await hook(fake)({ tool_name: name, tool_input: {} })).toEqual({});
  for (const name of ["ToolSearch", "AskUser", ...workerNames]) expect(await hook(fake)({ tool_name: nativeName(name), tool_input: {} })).toEqual({});
});

it("keeps the non-readonly catalog unchanged when the option is off", async () => {
  const { runtime, fake, base } = setup(false); await runtime.handle(base);
  for (const original of deniedNames) expect(fake.handlers.has(new StableDroidToolNames().toMcp(original))).toBe(true);
  expect(await hook(fake)({ tool_name: nativeName("Execute"), tool_input: {} })).toEqual({});
});
