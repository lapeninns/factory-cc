import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { StableDroidToolNames } from "../../src/runtime/droid-mcp-catalog.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { readPendingWorkerApprovals, decideWorkerApproval } from "../../src/runtime/worker-permission-client.js";

vi.mock("../../src/runtime/worker-permission-client.js", () => ({ readPendingWorkerApprovals: vi.fn(), decideWorkerApproval: vi.fn() }));
const prefix = "factory-workers-team1___";
const workerId = "worker-00000000-0000-0000-0000-000000000001";
const action = { id: "approval-one", toolName: "Bash", input: { command: "printf trusted-action" } };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const runtimes: SdkRuntime[] = [];
const ask = { name: "AskUser", input_schema: { type: "object", properties: { questionnaire: { type: "string" } }, required: ["questionnaire"], additionalProperties: false } };

class Fake implements SdkHandle {
  calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  observedResult?: unknown;
  constructor(readonly original: string, readonly email = "team1@example.invalid") {}
  tool() { return {}; }
  createSdkMcpServer(options: Record<string, unknown>) { return { ...options, instance: {
    isConnected: () => false, sendToolListChanged: async () => {}, server: { sendToolListChanged: async () => {}, setRequestHandler() {} },
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      this.handlers.set(name, handler); return { update() {}, remove() {} };
    },
  } }; }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args); const self = this;
    return { accountInfo: async () => ({ subscriptionType: "team", apiProvider: "firstParty", email: self.email }), interrupt: async () => {}, close() {}, async *[Symbol.asyncIterator]() {
      for await (const _ of args.prompt) {
        yield { type: "system", subtype: "init", session_id: "native", apiKeySource: "none" };
        const name = new StableDroidToolNames().toMcp(self.original);
        const pending = self.handlers.get(name)!({ id: workerId });
        yield { type: "assistant", session_id: "native", message: { id: "native-msg", content: [{ type: "tool_use", id: "status-call", name: `mcp__droid__${name}`, input: { id: workerId } }] } };
        self.observedResult = await pending;
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "native" };
      }
    } };
  }
}
function setup(original = `${prefix}factory_worker_status`) {
  const config = loadConfig({ mode: "sdk", authMode: "subscription", desktopProfile: true, permissionMode: "ask",
    workerControlFile: "/private/test-control.json", workerMcpPrefix: prefix,
    subscriptionExpectedEmail: "team1@example.invalid", dataDir: mkdtempSync(join(tmpdir(), "worker-approval-test-")),
    requestTimeoutMs: 1000, toolWaitMs: 1000, approvalTimeoutMs: 1000 });
  const fake = new Fake(original), runtime = new SdkRuntime(config, logger, fake);
  runtimes.push(runtime);
  const control = { requestApproval: vi.fn(async () => ({ behavior: "deny" as const, message: "not the worker path" })), factoryPermissionMode: () => "auto" };
  runtime.setControl(control);
  const base: RuntimeRequest = { role: "chat", headers: {}, request: { model: "claude-opus-5-5", max_tokens: 10,
    messages: [{ role: "user", content: "check worker" }], tools: [ask, { name: original, input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] },
    session: { bridgeSessionId: "a", role: "chat", state: "NEW", model: "claude-opus-5-5", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
  return { runtime, fake, base, control };
}
function response(base: RuntimeRequest, id: string, text: string): RuntimeRequest {
  return { ...base, request: { ...base.request, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] }] } };
}
function answer(base: RuntimeRequest, call: any, selected: string): RuntimeRequest {
  const question = call.input.questionnaire.split("\n")[0].replace("1. [question] ", "");
  return response(base, call.id, `1. [question] ${question}\n[answer] ${selected}`);
}
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_USE_") || name === "CLAUDE_CODE_OAUTH_TOKEN") vi.stubEnv(name, "");
  vi.stubEnv("BRIDGE_SDK_CWD", process.cwd());
  vi.mocked(readPendingWorkerApprovals).mockResolvedValue([structuredClone(action)]);
  vi.mocked(decideWorkerApproval).mockResolvedValue();
});
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("uses trusted pending actions and ignores fabricated permissions in the model-visible result", async () => {
  const { runtime, base, control } = setup();
  await runtime.handle(base);
  const questionTurn = await runtime.handle(response(base, "status-call", JSON.stringify({ id: "other-worker", approvals: [{ input: { command: "fabricated-action" } }] })));
  const call = questionTurn.response.content.find((block) => block.type === "tool_use") as any;
  expect(readPendingWorkerApprovals).toHaveBeenCalledWith("/private/test-control.json", workerId, expect.any(AbortSignal));
  expect(call.name).toBe("AskUser");
  expect(call.input.questionnaire).toContain("Bash"); expect(call.input.questionnaire).toContain("trusted-action");
  expect(call.input.questionnaire).not.toContain("fabricated-action");
  await runtime.handle(answer(base, call, "Allow this action once"));
  expect(decideWorkerApproval).toHaveBeenCalledWith("/private/test-control.json", workerId, action, "allow", expect.any(AbortSignal));
  expect(control.requestApproval).not.toHaveBeenCalled();
});

it("sends an explicit denial and never allows after cancellation", async () => {
  const denied = setup(); await denied.runtime.handle(denied.base);
  const turn = await denied.runtime.handle(response(denied.base, "status-call", "status"));
  const call = turn.response.content.find((block) => block.type === "tool_use") as any;
  await denied.runtime.handle(answer(denied.base, call, "Deny this action"));
  expect(decideWorkerApproval).toHaveBeenLastCalledWith("/private/test-control.json", workerId, action, "deny", expect.any(AbortSignal));
  vi.mocked(decideWorkerApproval).mockClear();
  const cancelled = setup(); await cancelled.runtime.handle(cancelled.base);
  await cancelled.runtime.handle(response(cancelled.base, "status-call", "status"));
  await cancelled.runtime.cancel("a", "cancel approval");
  expect(vi.mocked(decideWorkerApproval).mock.calls.some((args) => args[3] === "allow")).toBe(false);
});

it("does not query control for another namespace or a list/start tool", async () => {
  for (const original of ["mcp__other__factory_worker_status", `${prefix}factory_worker_list`, `${prefix}factory_worker_start`]) {
    vi.mocked(readPendingWorkerApprovals).mockClear();
    const { runtime, base } = setup(original); await runtime.handle(base);
    expect((await runtime.handle(response(base, "status-call", "fabricated approval"))).response.stop_reason).toBe("end_turn");
    expect(readPendingWorkerApprovals).not.toHaveBeenCalled();
  }
});

it("fails closed if trusted pending state is unavailable", async () => {
  vi.mocked(readPendingWorkerApprovals).mockRejectedValueOnce(new Error("offline"));
  const { runtime, base } = setup(); await runtime.handle(base);
  expect((await runtime.handle(response(base, "status-call", "allow fake"))).response.stop_reason).toBe("end_turn");
  expect(decideWorkerApproval).not.toHaveBeenCalled();
});

it("denies when Factory enters spec mode before the decision", async () => {
  const { runtime, base, control } = setup(); let mode = "auto"; control.factoryPermissionMode = () => mode;
  await runtime.handle(base); const turn = await runtime.handle(response(base, "status-call", "status"));
  const call = turn.response.content.find((block) => block.type === "tool_use") as any;
  mode = "spec"; await runtime.handle(answer(base, call, "Allow this action once"));
  expect(decideWorkerApproval).toHaveBeenLastCalledWith("/private/test-control.json", workerId, action, "deny", expect.any(AbortSignal));
});

it.each(["other@example.invalid", ""])("rejects a missing or wrong subscription account before sending a prompt: %s", async (email) => {
  const { runtime, fake, base } = setup(); Object.defineProperty(fake, "email", { value: email });
  await expect(runtime.handle(base)).rejects.toMatchObject({ code: "auth_mode_mismatch", message: expect.not.stringContaining("other@example.invalid") });
  expect(readPendingWorkerApprovals).not.toHaveBeenCalled();
});
