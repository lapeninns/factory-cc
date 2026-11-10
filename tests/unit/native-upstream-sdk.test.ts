import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import { historyMessageHashes, sessionContextHash } from "../../src/sessions/correlate.js";
import { hostResultDigest, mcpResultContent } from "../../src/runtime/host-recovery.js";
import { BridgeError, type ContentBlock, type Message, type MessagesRequest } from "../../src/types.js";
import { FACTORY_SESSION, hostStart, restartConfig } from "../helpers/native-restart.js";
import { postMessages } from "../helpers/server.js";

/** Only the provider adapter is replaced. HTTP admission and SdkRuntime are real. */
class ProviderAdapter implements SdkHandle {
  readonly options: Record<string, unknown>[] = [];
  readonly inputs: SdkUserInput[] = [];
  readonly handlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
  closes = 0;
  toolInvocations = 0;
  constructor(readonly sdkSessionId: string, readonly failures: number[]) {}
  tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>): unknown {
    this.handlers.set(name, handler);
    return { name, handler };
  }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    return { ...options, instance: {
      isConnected: () => true, sendToolListChanged() {}, server: { setRequestHandler() {}, async sendToolListChanged() {} },
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => {
        this.handlers.set(name, async (...args) => { this.toolInvocations++; return handler(...args); });
        return { update() {}, remove: () => this.handlers.delete(name) };
      },
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.options.push(args.options);
    const adapter = this;
    return {
      async interrupt() {},
      close() { adapter.closes++; },
      accountInfo: async () => ({ subscriptionType: "team", apiProvider: "firstParty", apiKeySource: "none", email: "member5@example.invalid" }),
      mcpServerStatus: async () => [{ name: "droid", status: "connected", tools: [...adapter.handlers.keys()].map(name => ({ name })) }],
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          const status = adapter.failures[adapter.inputs.length];
          adapter.inputs.push(input);
          yield { type: "system", subtype: "init", session_id: adapter.sdkSessionId };
          if (status) throw new BridgeError(status, status === 429 ? "rate_limit_error" : "overloaded_error", "synthetic provider failure", { retry_after: 60 });
          yield { type: "result", subtype: "success", is_error: false, result: "Continued exactly once", session_id: adapter.sdkSessionId };
        }
      },
    };
  }
}

const roots: string[] = [], apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture(failures: number[] = [], resultOnly = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retained-http-sdk-"))); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const base = restartConfig(root), sdkId = randomUUID();
  const config = { ...base, desktopJobs: false, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
    env: { ...account.env, CLAUDE_CONFIG_DIR: join(root, account.profile) } })) };
  const sdk = new ProviderAdapter(sdkId, failures), logger = { info() {}, warn() {}, error() {} };
  const runtime = new SdkRuntime(config, logger, sdk);
  const coldRetry = vi.spyOn(runtime, "prepareColdRetry"), checkpointRetry = vi.spyOn(runtime, "prepareCheckpointRetry");
  const app = createBridgeApp(config, logger, "", runtime); apps.push(app); await listen(app, config);
  const token = await hostStart(app, root);
  const headers = { "x-bridge-role": "orchestrator" };
  const tool = { name: "Script", input_schema: { type: "object" as const, properties: {} } };
  const resultContent: ContentBlock[] = [{ type: "text", text: "completed Script" }, { type: "text", text: "owned result" }];
  const resultId = "already-completed";
  const completed: Message[] = [{ role: "user", content: "Earlier instruction" },
    { role: "assistant", content: [{ type: "tool_use", id: resultId, name: "Script", input: {} }] }];
  const finalContent: ContentBlock[] = [{ type: "tool_result", tool_use_id: resultId, content: resultContent },
    ...(resultOnly ? [] : [{ type: "text", text: `[factory-cc-session:${token}] Continue the workstream` }])];
  const request: MessagesRequest = { model: "opus", max_tokens: 64, tools: [tool], messages: [
    { role: "user", content: `[factory-cc-session:${token}] Rewritten compacted prefix` }, ...completed,
    { role: "user", content: finalContent },
  ] };
  const record = app.store.create({ role: "orchestrator", model: "opus", toolNames: ["Script"], nativeGeneration: 7, claudeAccount: "team5" });
  const directory = join(root, "team5", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(directory, { recursive: true });
  const file = join(directory, sdkId + ".jsonl");
  writeFileSync(file, [
    { sessionId: sdkId, message: { role: "assistant", content: [{ type: "tool_use", id: resultId, name: "mcp__droid__Script", input: {} }] } },
    { sessionId: sdkId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content: mcpResultContent(JSON.stringify(resultContent)) }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  app.store.update(record.bridgeSessionId, { state: "IDLE", controllerWorkspacePolicy: "controller-host", factorySessionId: FACTORY_SESSION, factoryCwd: cwd, sdkSessionId: sdkId,
    contextHash: sessionContextHash(headers, request, cwd), historyMessageHashes: historyMessageHashes(completed),
    requestMessageHashes: historyMessageHashes([...completed, { role: "user", content: "Prior failed request" }]),
    retryableRequestKind: "native-upstream", retryableRequestHash: "a".repeat(64),
    retainedCheckpoint: { sdkSessionId: sdkId, account: "team5", sourceGeneration: 4, preparedAt: new Date().toISOString(), origin: "operator-restored",
      checkpointSha256: createHash("sha256").update(readFileSync(file)).digest("hex"), settledToolIds: [resultId],
      settledToolResults: [{ toolUseId: resultId, resultSha256: hostResultDigest(JSON.stringify(resultContent), false) }] } });
  return { app, runtime, sdk, sdkId, record, request, headers, coldRetry, checkpointRetry, token };
}

/** Mirrors Factory Wz before the outbound role/content-only projection. */
function factoryTurnBoundaries(messages: Array<Message & { visibility?: string; hiddenFromUserViews?: boolean }>): Message[] {
  const result: Message[] = [];
  let pendingResultIndex = -1;
  for (const message of messages) {
    if (message.role === "assistant") pendingResultIndex = -1;
    else if (Array.isArray(message.content) && message.content.some(block => block.type === "tool_result")) pendingResultIndex = result.length;
    else if (pendingResultIndex >= 0 && message.role === "user" && message.hiddenFromUserViews !== true && message.visibility !== "llm_only") {
      result.splice(pendingResultIndex + 1, 0, { role: "assistant", content: [{ type: "text", text: "---" }] });
      pendingResultIndex = -1;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}
function vendorRequest(f: Awaited<ReturnType<typeof fixture>>): MessagesRequest {
  return { ...f.request, messages: factoryTurnBoundaries([...f.request.messages,
    { role: "user", content: [{ type: "text", text: "internal context" }], visibility: "llm_only" },
    { role: "user", content: [{ type: "text", text: `[factory-cc-session:${f.token}] Continue` }] },
  ]) };
}

describe("retained checkpoint HTTP to SDK delivery", () => {
  it.each([false, true])("reconciles the proven result through real SDK admission (result only=%s)", async resultOnly => {
    const f = await fixture([], resultOnly);
    const response = await postMessages(f.app.url, "client", f.request, f.headers);
    expect(response.status).toBe(200);
    expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.inputs).toHaveLength(1);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId);
    expect(f.sdk.inputs[0]!.message.content.some(block => block.type === "tool_result")).toBe(false);
    expect(f.record.retainedCheckpoint).toBeUndefined();
    expect(f.record.retryableRequestKind).toBeUndefined();
    expect(f.coldRetry).not.toHaveBeenCalled();
  });

  it("reconciles the vendor-inserted result boundary through HTTP and the real SDK", async () => {
    const f = await fixture([], true), request = vendorRequest(f);
    expect(request.messages[4]).toEqual({ role: "assistant", content: [{ type: "text", text: "---" }] });
    const response = await postMessages(f.app.url, "client", request, f.headers);
    expect(response.status).toBe(200);
    expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId);
    expect(f.sdk.inputs).toHaveLength(1);
    expect(f.sdk.toolInvocations).toBe(0);
    expect(f.sdk.inputs[0]!.message.content.some(block => block.type === "tool_result")).toBe(false);
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.coldRetry).not.toHaveBeenCalled();
  });

  it.each(["wrong-marker", "extra-block", "unknown-result", "failed-result", "no-followup"])("refuses unsafe vendor boundary %s before SDK admission", async kind => {
    const f = await fixture([], true), request = vendorRequest(f), before = structuredClone(f.record);
    if (kind === "wrong-marker") request.messages[4] = { role: "assistant", content: [{ type: "text", text: "----" }] };
    if (kind === "extra-block") request.messages[4] = { role: "assistant", content: [{ type: "text", text: "---" }, { type: "text", text: "new response" }] };
    if (kind === "unknown-result") request.messages[3] = { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "done" }] };
    if (kind === "failed-result") request.messages[3] = { role: "user", content: [{ type: "tool_result", tool_use_id: "already-completed", content: "done", is_error: true }] };
    if (kind === "no-followup") request.messages = request.messages.slice(0, 5);
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(409);
    expect(f.sdk.options).toHaveLength(0);
    expect(f.record).toEqual(before);
    expect(f.app.store.list()).toHaveLength(1);
  });

  it.each(["none", "missing", "null", "numeric"])("refuses %s selection before a real SDK query", async kind => {
    const f = await fixture(), before = structuredClone(f.record);
    const request = kind === "none" ? { ...f.request, tool_choice: { type: "none" } } : { ...f.request,
      messages: [...f.request.messages, { role: "user", content: [{ type: "tool_result", content: "done",
        ...(kind === "missing" ? {} : { tool_use_id: kind === "null" ? null : 42 }) }] }] };
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(409);
    expect(f.sdk.options).toHaveLength(0);
    expect(f.record).toEqual(before);
    expect(f.app.store.list()).toHaveLength(1);
  });

  it("keeps validated resume intent after a pre-prompt admission deferral", async () => {
    const f = await fixture();
    vi.spyOn(f.runtime, "handle").mockRejectedValueOnce(new BridgeError(503, "desktop_job_timeout", "deferred",
      { retry_safe: true, phase: "admission" }));
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(503);
    expect(f.record.retryableRequestKind).toBe("native-upstream");
    expect(f.record.retainedCheckpoint?.sdkSessionId).toBe(f.sdkId);
    expect(f.sdk.options).toHaveLength(0);
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(200);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId);
  });

  it.each([{ status: 429, boundary: false }, { status: 529, boundary: false }, { status: 429, boundary: true }, { status: 529, boundary: true }])(
    "preserves rewritten-prefix retry %j on the same SDK", async ({ status, boundary }) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T13:30:00Z"));
    const f = await fixture([status], boundary), request = boundary ? vendorRequest(f) : f.request;
    const failed = await postMessages(f.app.url, "client", request, f.headers);
    expect(failed.status).toBe(status);
    expect(failed.json.error).toMatchObject({ checkpoint_retained: true, retry_mode: "native_checkpoint" });
    expect(f.record).toMatchObject({ state: "IDLE", sdkSessionId: f.sdkId, claudeAccount: "team5", nativeGeneration: 8,
      retryableRequestKind: "native-upstream" });
    expect(f.record.retainedCheckpoint?.settledToolIds).toEqual(["already-completed"]);
    expect(f.checkpointRetry).toHaveBeenCalledWith(f.record.bridgeSessionId, f.sdkId);
    expect(f.sdk.closes).toBeGreaterThan(0);
    if (status === 429) {
      expect(f.record.accountCooldowns?.team5).toBe("2026-11-10T13:31:00.000Z");
      expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(429);
      expect(f.sdk.inputs).toHaveLength(1);
      vi.setSystemTime(new Date("2026-11-10T13:32:00Z"));
    }
    const retried = await postMessages(f.app.url, "client", request, f.headers);
    expect(retried.status).toBe(200);
    expect(retried.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.inputs).toHaveLength(2);
    expect(f.sdk.options.map(options => options.resume)).toEqual([f.sdkId, f.sdkId]);
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.coldRetry).not.toHaveBeenCalled();
  });
});
