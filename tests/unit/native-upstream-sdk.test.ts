import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import { DesktopJobsRuntime } from "../../src/runtime/desktop-jobs.js";
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
  attemptTools = false;
  hostActionOnInput = 0;
  denials: unknown[] = [];
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
    const sdkSessionId = args.options.resume ? adapter.sdkSessionId : randomUUID();
    return {
      async interrupt() {},
      close() { adapter.closes++; },
      accountInfo: async () => ({ subscriptionType: "team", apiProvider: "firstParty", apiKeySource: "none", email: "member5@example.invalid" }),
      mcpServerStatus: async () => [{ name: "droid", status: "connected", tools: [...adapter.handlers.keys()].map(name => ({ name })) }],
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          const status = adapter.failures[adapter.inputs.length];
          adapter.inputs.push(input);
          yield { type: "system", subtype: "init", session_id: sdkSessionId };
          if (adapter.attemptTools) {
            const permit = args.options.canUseTool as (name: string, input: unknown, options: unknown) => Promise<unknown>;
            for (const name of ["Bash", "mcp__droid__Script"]) adapter.denials.push(await permit(name, { command: "changed command" },
              { signal: new AbortController().signal, toolUseID: `attempt-${name}` }));
          }
          if (adapter.hostActionOnInput === adapter.inputs.length) {
            const id = `new-host-${adapter.inputs.length}`;
            yield { type: "assistant", session_id: sdkSessionId,
              message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__droid__Script", input: { command: "intentional-new" } }] } };
            await adapter.handlers.get("Script")!({ command: "intentional-new" }, { toolUseId: id });
          }
          if (status) throw new BridgeError(status, status === 429 ? "rate_limit_error" : "overloaded_error", "synthetic provider failure", { retry_after: 60 });
          yield { type: "result", subtype: "success", is_error: false, result: "Continued exactly once", session_id: sdkSessionId };
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

async function fixture(failures: number[] = [], resultOnly = false, supervised = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retained-http-sdk-"))); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const base = restartConfig(root), sdkId = randomUUID();
  const config = { ...base, desktopJobs: supervised, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
    env: { ...account.env, CLAUDE_CONFIG_DIR: join(root, account.profile) } })) };
  const sdk = new ProviderAdapter(sdkId, failures), logger = { info() {}, warn() {}, error() {} };
  const runtime = new SdkRuntime(config, logger, sdk);
  if (supervised) {
    vi.spyOn(DesktopJobsRuntime.prototype, "handle").mockImplementation((input, sink) => runtime.handle(input, sink));
    vi.spyOn(DesktopJobsRuntime.prototype, "inspectNativeGenerations").mockImplementation(async request => [{
      generation: Number(request.bridgeSessionId.match(/:g(\d+)$/)![1]), state: request.sdkSessionId === sdkId ? "failed" : "cancelled", bindingMatches: true, checkpointMatches: true,
      cleanupVerified: true, ownerAlive: false, supervisorAlive: false, hostActionReservation: false, externalCleanupRequired: false,
      endedAt: "2026-11-10T13:00:00Z", endedBy: "session_update",
    }]);
    vi.spyOn(DesktopJobsRuntime.prototype, "prepareCheckpointRetry").mockImplementation((id, sdkId) => runtime.prepareCheckpointRetry(id, sdkId));
  }
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
  return { app, runtime, sdk, sdkId, record, request, headers, coldRetry, checkpointRetry, token, root, config, file };
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


function healthyRequest(f: Awaited<ReturnType<typeof fixture>>, count = 4): MessagesRequest {
  const completed: Message[] = [{ role: "user", content: "Completed work" }, { role: "assistant", content: "Acknowledged" }];
  f.app.store.update(f.record.bridgeSessionId, { retainedCheckpoint: undefined, retryableRequestKind: undefined,
    historyMessageHashes: historyMessageHashes(completed), requestMessageHashes: historyMessageHashes(completed.slice(0, 1)) });
  return { ...f.request, messages: [{ role: "user", content: "Compacted prefix" }, ...completed,
    ...Array.from({ length: count }, (_, index): Message => ({ role: "user", content: `[factory-cc-session:${f.token}] context ${index}` }))] };
}
function toolFree(request: MessagesRequest, mode: "empty" | "none"): MessagesRequest {
  return mode === "empty" ? { ...request, tools: [] } : { ...request, tool_choice: { type: "none" } };
}

const auxiliaryRoutes = (["empty", "none"] as const).flatMap(mode =>
  (["retry", "prefix", "single-tail", "multi-tail"] as const).map(route => ({ mode, route })));

describe("authenticated tool-free routing on the same workspace", () => {
  it.each(auxiliaryRoutes)("keeps $mode requests independent across $route matching", async ({ mode, route }) => {
    const f = await fixture(); f.config.desktopProfile = false;
    const headers = { ...f.headers, "x-bridge-cwd": f.record.factoryCwd! };
    const request = toolFree(healthyRequest(f, route === "multi-tail" ? 2 : 1), mode);
    if (route === "prefix") request.messages = request.messages.slice(1);
    f.app.store.update(f.record.bridgeSessionId, { nativePurpose: "interactive" });
    if (route === "retry") {
      vi.spyOn(f.runtime, "handle").mockRejectedValueOnce(new BridgeError(503, "desktop_job_timeout", "deferred", { retry_safe: true, phase: "admission" }));
      const deferred = await postMessages(f.app.url, "client", request, { ...headers, "x-bridge-session": f.record.bridgeSessionId });
      expect(deferred.status).toBe(503); expect(f.record.retryableRequestHash).toBeDefined();
    }
    const before = structuredClone(f.record);
    const response = await postMessages(f.app.url, "client", request, headers);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.session).not.toBe(f.record.bridgeSessionId);
    const auxiliary = f.app.store.require(response.session!);
    expect(auxiliary.nativePurpose).toBe("auxiliary"); expect(auxiliary.sdkSessionId).not.toBe(f.sdkId);
    expect(f.sdk.options[0]?.resume).toBeUndefined();
    expect(f.record).toEqual(before); expect(f.app.store.list()).toHaveLength(2);
  });

  it("can retry an established auxiliary admission without selecting the interactive owner", async () => {
    const f = await fixture(); f.config.desktopProfile = false;
    const headers = { ...f.headers, "x-bridge-cwd": f.record.factoryCwd! };
    const request = toolFree(healthyRequest(f, 1), "none"), before = structuredClone(f.record);
    vi.spyOn(f.runtime, "handle").mockRejectedValueOnce(new BridgeError(503, "desktop_job_timeout", "deferred", { retry_safe: true, phase: "admission" }));
    const deferred = await postMessages(f.app.url, "client", request, headers);
    expect(deferred.status).toBe(503); expect(deferred.session).toBeDefined();
    const response = await postMessages(f.app.url, "client", request, headers);
    expect(response.status).toBe(200); expect(response.session).toBe(deferred.session);
    expect(f.record).toEqual(before); expect(f.app.store.list()).toHaveLength(2);
  });
});

describe("healthy native continuity after compaction", () => {
  it.each([4, 7])("retains one native owner across two successive compacted tails with %s user messages", async count => {
    const f = await fixture(), request = healthyRequest(f, count);
    const first = await postMessages(f.app.url, "client", request, f.headers);
    expect(first.status).toBe(200); expect(first.session).toBe(f.record.bridgeSessionId);
    const next: MessagesRequest = { ...request, messages: [{ role: "user", content: "Another compacted prefix" },
      request.messages.at(-1)!, { role: "assistant", content: first.json.content as ContentBlock[] },
      { role: "user", content: "More context" }, { role: "user", content: `[factory-cc-session:${f.token}] Continue again` }] };
    const second = await postMessages(f.app.url, "client", next, f.headers);
    expect(second.status).toBe(200); expect(second.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId); expect(f.sdk.options).toHaveLength(1);
    expect(f.sdk.inputs).toHaveLength(2); expect(f.app.store.list()).toHaveLength(1);
  });
  it.each([429, 529])("preserves healthy rewritten-tail checkpoint after %s", async status => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T14:00:00Z"));
    const f = await fixture([status]), request = healthyRequest(f);
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(status);
    expect(f.record).toMatchObject({ state: "IDLE", sdkSessionId: f.sdkId, retryableRequestKind: "native-upstream" });
    vi.setSystemTime(new Date("2026-11-10T14:02:00Z"));
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(200);
    expect(f.sdk.options.map(option => option.resume)).toEqual([f.sdkId, f.sdkId]);
    expect(f.app.store.list()).toHaveLength(1);
  });
  it.each(["FAILED", "CANCELLED"] as const)("keeps a terminal %s legacy SDK with an empty catalog from cold-forking", async state => {
    const f = await fixture(); const request = healthyRequest(f);
    f.app.store.update(f.record.bridgeSessionId, { state, toolNames: [], retainedCheckpoint: undefined, retryableRequestKind: undefined });
    request.messages = [{ role: "user", content: `[factory-cc-session:${f.token}] Different compacted history` }];
    const before = structuredClone(f.record);
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(409);
    expect(f.app.store.list()).toHaveLength(1); expect(f.record).toEqual(before); expect(f.sdk.options).toHaveLength(0);
  });

  it("does not let a genuine auxiliary native record block the interactive owner", async () => {
    const f = await fixture(), request = healthyRequest(f);
    const auxiliary = f.app.store.create({ role: "orchestrator", model: "opus", nativePurpose: "auxiliary", toolNames: ["Script"] });
    f.app.store.update(auxiliary.bridgeSessionId, { state: "IDLE", sdkSessionId: randomUUID(), factorySessionId: FACTORY_SESSION,
      factoryCwd: f.record.factoryCwd, historyMessageHashes: ["aux-user", "aux-response"], contextHash: "aux-context" });
    const response = await postMessages(f.app.url, "client", request, f.headers);
    expect(response.status).toBe(200); expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId);
    expect(f.record.nativePurpose).toBe("interactive"); expect(auxiliary.nativePurpose).toBe("auxiliary");
  });

  it("records a fresh tools-none request as auxiliary even when a tool catalog is supplied", async () => {
    const f = await fixture(); healthyRequest(f);
    const response = await postMessages(f.app.url, "client", { ...f.request, tool_choice: { type: "none" },
      messages: [{ role: "user", content: `[factory-cc-session:${f.token}] Auxiliary summary` }] }, f.headers);
    expect(response.status).toBe(200);
    expect(f.app.store.require(response.session!).nativePurpose).toBe("auxiliary");
    const request = healthyRequest(f);
    const continuation = await postMessages(f.app.url, "client", request, f.headers);
    expect(continuation.status).toBe(200); expect(continuation.session).toBe(f.record.bridgeSessionId);
  });

  it.each(["missing-anchor", "assistant-work", "unproven-result"])("refuses healthy %s before allocating a cold branch", async kind => {
    const f = await fixture(), request = healthyRequest(f), before = structuredClone(f.record);
    if (kind === "missing-anchor") request.messages.splice(1, 2);
    if (kind === "assistant-work") request.messages.push({ role: "assistant", content: "Other work" }, { role: "user", content: "Continue" });
    if (kind === "unproven-result") request.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "done" }] });
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(409);
    expect(f.sdk.options).toHaveLength(0); expect(f.record).toEqual(before); expect(f.app.store.list()).toHaveLength(1);
  });
});

async function historicalSelectionFixture() {
  const f = await fixture([], true, true);
  const proof = { ...f.record.retainedCheckpoint!, sourceGeneration: 0, preparedAt: "2026-11-10T13:01:00Z" };
  f.app.store.update(f.record.bridgeSessionId, { nativeGeneration: 4, createdAt: "2026-11-10T12:00:00Z", retainedCheckpoint: proof,
    upstreamCheckpointRecoveries: [{ operationId: "restore-earlier-checkpoint", at: proof.preparedAt, recordUpdatedAt: "2026-11-10T13:00:00Z",
      nativeGeneration: 1, proof: structuredClone(proof), evidenceSha256: "b".repeat(64), before: { retryableRequestKind: "upstream" } }] });
  const histories = ["CANCELLED", "IDLE"].map((state, index) => {
    const sdkSessionId = randomUUID();
    const old = f.app.store.create({ role: f.record.role, model: f.record.model, claudeAccount: "team5", nativeGeneration: 0, toolNames: ["Script"] });
    const file = join(f.root, "team5", "projects", f.record.factoryCwd!.replace(/[^A-Za-z0-9]/g, "-"), sdkSessionId + ".jsonl");
    writeFileSync(file, [
      { sessionId: sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: `historical-${index}`, name: "mcp__droid__Script", input: {} }] } },
      { sessionId: sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `historical-${index}`, content: `old effect ${index}` }] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    f.app.store.update(old.bridgeSessionId, { state: state as "CANCELLED" | "IDLE", sdkSessionId,
      hostEnded: state === "IDLE" ? "interrupted" : undefined, factorySessionId: f.record.factorySessionId, factoryCwd: f.record.factoryCwd,
      contextHash: f.record.contextHash, createdAt: "2026-11-08T12:00:00Z", historyMessageHashes: ["older"] });
    return { old, file };
  });
  const leases = vi.mocked(DesktopJobsRuntime.prototype.inspectNativeGenerations);
  const defaultInspect = leases.getMockImplementation()!;
  leases.mockImplementation(async request => (await defaultInspect(request)).map(row => ({
    ...row, endedAt: request.sdkSessionId === f.sdkId ? "2026-11-10T13:00:00Z" : "2026-11-09T12:00:00Z",
  })));
  const identity = { bridgeSessionId: f.record.bridgeSessionId, sdkSessionId: f.sdkId, account: "team5",
    nativeGeneration: 4, expectedUpdatedAt: f.record.updatedAt };
  const body = { operationId: randomUUID(), factorySessionId: f.record.factorySessionId, factoryCwd: f.record.factoryCwd,
    selected: identity, sources: [] };
  const approval = { reference: "test-only-historical-selection", approvedAt: proof.preparedAt, selectedBridgeSessionId: f.record.bridgeSessionId,
    selectedSdkSessionId: f.sdkId, sourceBridgeSessionIds: [] };
  const send = async (data: unknown) => fetch(`${f.app.url}/internal/select-native-lineage`, { method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify(data) });
  const vendor = vendorRequest(f);
  vendor.messages.push({ role: "user", content: `[factory-cc-session:${f.token}] Confirm the restored checkpoint` });
  const request: MessagesRequest = { ...vendor, messages: [
    ...Array.from({ length: 18 }, (): Message => ({ role: "user", content: `[factory-cc-session:${f.token}]` })),
    ...Array.from({ length: 700 - vendor.messages.length }, (_, index): Message => ({
      role: index % 2 ? "assistant" : "user", content: `Older transcript message ${index}`,
    })), ...vendor.messages,
  ] };
  const preview = async () => {
    const response = await send({ ...body, dryRun: true });
    expect(response.status).toBe(200);
    return await response.json() as { proofSha256: string; eligible: boolean; requiredHistoricalDispositions: Array<Record<string, unknown>> };
  };
  const approved = async () => {
    const pending = await preview();
    return { ...body, approval, proofSha256: pending.proofSha256,
      historicalDispositions: pending.requiredHistoricalDispositions.map((item, index) => ({
        ...item, approvalReference: `test-only-historical-${index}`, approvedAt: proof.preparedAt,
      })) };
  };
  return { ...f, histories, request, leases, proof, body, approval, send, preview, approved };
}

describe("explicit historical-only selection for a restored native checkpoint", () => {
  it("holds the 718-message Factory shape until both archives are approved, then continues twice on the same SDK", async () => {
    const f = await historicalSelectionFixture();
    expect(f.request.messages).toHaveLength(718);
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).json.error).toMatchObject({ type: "native_checkpoint_selection_required" });
    expect(f.sdk.inputs).toHaveLength(0);
    const request = await f.approved();
    expect(request.historicalDispositions).toHaveLength(2);
    expect((await f.send({ ...request, historicalDispositions: request.historicalDispositions.slice(0, 1) })).status).toBe(409);
    expect(f.record.nativeLineageSelection).toBeUndefined();
    const old = f.histories.map(item => structuredClone(item.old));
    expect((await f.send(request)).status).toBe(200);
    expect((await (await f.send(request)).json())).toMatchObject({ alreadySelected: true });
    expect(f.record.nativeGeneration).toBe(5);
    f.sdk.attemptTools = true; f.sdk.hostActionOnInput = 1;
    const first = await postMessages(f.app.url, "client", f.request, f.headers);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.session).toBe(f.record.bridgeSessionId);
    expect(f.record.requestMessageHashes).toHaveLength(700);
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId);
    expect(f.sdk.inputs[0]!.message.content.some(block => block.type === "tool_result")).toBe(false);
    expect(f.sdk.denials).toHaveLength(2);
    expect(f.sdk.denials.every(result => (result as { behavior: string }).behavior === "deny")).toBe(true);
    expect(f.record.pendingLineageReconciliation).toBeUndefined();
    expect(f.record.retainedCheckpoint).toBeUndefined();
    expect(f.record.nativeLineageSelection?.reconciledAt).toBeDefined();
    f.sdk.attemptTools = false; f.sdk.hostActionOnInput = 0;
    const second = { ...f.request, messages: [
      { role: "user", content: `[factory-cc-session:${f.token}] Rewritten history` } as Message,
      f.request.messages.at(-1)!, { role: "assistant", content: first.json.content as ContentBlock[] } as Message,
      { role: "user", content: "Ordinary next turn" } as Message,
    ] };
    const next = await postMessages(f.app.url, "client", second, f.headers);
    expect(next.status, JSON.stringify(next.json)).toBe(200);
    expect(next.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.inputs).toHaveLength(2); expect(f.sdk.options).toHaveLength(1);
    expect(f.app.store.list()).toHaveLength(3); expect(f.histories.map(item => item.old)).toEqual(old);
    expect(f.coldRetry).not.toHaveBeenCalled();
  });

  it.each(["wrong-tail", "unknown-result", "changed-result", "unbound"])("blocks %s before sending any native reconciliation input", async kind => {
    const f = await historicalSelectionFixture();
    expect((await f.send(await f.approved())).status).toBe(200);
    const request = structuredClone(f.request);
    if (kind === "wrong-tail") request.messages[request.messages.length - 2] = { role: "assistant", content: "Unexpected assistant work" };
    if (kind === "unbound") {
      request.messages = request.messages.slice(18).map(message => ({ ...message, content: typeof message.content === "string"
        ? message.content.replaceAll(`[factory-cc-session:${f.token}]`, "")
        : message.content.map(block => block.type === "text" && typeof block.text === "string"
          ? { ...block, text: block.text.replaceAll(`[factory-cc-session:${f.token}]`, "") } : block) }));
    }
    if (kind === "unknown-result" || kind === "changed-result") {
      const result = (request.messages.at(-5)!.content as ContentBlock[])[0]!;
      if (result.type !== "tool_result") throw new Error("fixture_result_missing");
      if (kind === "unknown-result") result.tool_use_id = "unknown";
      else result.content = "Changed result";
    }
    expect((await postMessages(f.app.url, "client", request, f.headers)).status).toBe(kind === "unbound" ? 400 : 409);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.sdk.options).toHaveLength(0);
  });

  it("refuses a sibling introduced during the first historical lease check", async () => {
    const f = await historicalSelectionFixture();
    const inspect = f.leases.getMockImplementation()!;
    let added = false;
    f.leases.mockImplementation(async request => {
      if (!added) {
        added = true;
        const existing = f.histories[0]!.old;
        const extra = f.app.store.create({ role: existing.role, model: existing.model, claudeAccount: "team5", nativeGeneration: 0, toolNames: ["Script"] });
        f.app.store.update(extra.bridgeSessionId, { state: "CANCELLED", sdkSessionId: randomUUID(), factorySessionId: existing.factorySessionId,
          factoryCwd: existing.factoryCwd, contextHash: existing.contextHash, createdAt: "2026-11-07T12:00:00Z" });
      }
      return inspect(request);
    });
    const response = await f.send({ ...f.body, dryRun: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { reason: "scope_changed" } });
    expect(f.record.nativeLineageSelection).toBeUndefined();
  });

  it("refuses a new owner lease after the historical audit was selected", async () => {
    const f = await historicalSelectionFixture();
    expect((await f.send(await f.approved())).status).toBe(200);
    const inspect = f.leases.getMockImplementation()!;
    f.leases.mockImplementation(async request => (await inspect(request)).map(row =>
      request.sdkSessionId === f.sdkId ? { ...row, ownerAlive: true } : row));
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(409);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.sdk.options).toHaveLength(0);
  });

  it.each(["unconsumed", "unknown", "live", "newer", "wrong-account", "wrong-sdk", "unproven-owner", "ambiguous-owner", "new-owner-lease"])(
    "refuses historical-only selection with %s evidence", async kind => {
      const f = await historicalSelectionFixture();
      const history = f.histories[0]!.old;
      if (kind === "unconsumed") f.app.store.update(history.bridgeSessionId, { endedToolIds: ["not-settled"] });
      if (kind === "newer") f.app.store.update(history.bridgeSessionId, { createdAt: "2026-11-11T00:00:00Z" });
      if (kind === "wrong-account") f.app.store.update(history.bridgeSessionId, { claudeAccount: "team8" });
      if (kind === "wrong-sdk") f.app.store.update(history.bridgeSessionId, { sdkSessionId: f.sdkId });
      if (kind === "unproven-owner") f.app.store.update(f.record.bridgeSessionId, { upstreamCheckpointRecoveries: [] });
      if (kind === "ambiguous-owner") f.app.store.update(f.record.bridgeSessionId, {
        upstreamCheckpointRecoveries: [...f.record.upstreamCheckpointRecoveries!, ...f.record.upstreamCheckpointRecoveries!],
      });
      if (["unknown", "live", "new-owner-lease"].includes(kind)) {
        const inspect = f.leases.getMockImplementation()!;
        f.leases.mockImplementation(async request => (await inspect(request)).map(row => {
          if (kind === "new-owner-lease" && request.sdkSessionId === f.sdkId) return { ...row, generation: 1 };
          if (request.sdkSessionId !== history.sdkSessionId) return row;
          return kind === "unknown" ? { ...row, state: "unknown" } : { ...row, ownerAlive: true };
        }));
      }
      const response = await f.send({ ...f.body, dryRun: true });
      expect(response.status).toBe(409);
      expect(f.record.nativeLineageSelection).toBeUndefined();
      expect(f.sdk.inputs).toHaveLength(0);
    });
});

async function selectionFixture(failures: number[] = []) {
  const f = await fixture(failures, false, true);
  healthyRequest(f);
  const source = f.app.store.create({ role: f.record.role, model: f.record.model, claudeAccount: "team5", nativeGeneration: 0, toolNames: ["Script"] });
  const sourceSdk = randomUUID(), sourceFile = join(f.root, "team5", "projects", f.record.factoryCwd!.replace(/[^A-Za-z0-9]/g, "-"), sourceSdk + ".jsonl");
  writeFileSync(sourceFile, [
    { sessionId: sourceSdk, message: { role: "assistant", content: [{ type: "tool_use", id: "foreign-done", name: "mcp__droid__Script", input: {} }] } },
    { sessionId: sourceSdk, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "foreign-done", content: [{ type: "text", text: "foreign output" }] }] } },
  ].map(row => JSON.stringify(row)).join("\n"));
  f.app.store.update(source.bridgeSessionId, { state: "FAILED", sdkSessionId: sourceSdk, contextHash: f.record.contextHash,
    factorySessionId: f.record.factorySessionId, factoryCwd: f.record.factoryCwd, historyMessageHashes: ["foreign-history"],
    endedToolIds: ["foreign-done"], hostCompletionReceipts: [{ toolUseId: "foreign-done", toolName: "Script", input: {}, content: "foreign output", isError: false }] });
  const cancel = await fetch(`${f.app.url}/internal/cancel`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ sessionId: source.bridgeSessionId, preserveForLineageSelection: true }) });
  expect(cancel.status).toBe(200);
  const identity = (record: typeof f.record) => ({ bridgeSessionId: record.bridgeSessionId, sdkSessionId: record.sdkSessionId, account: record.claudeAccount,
    nativeGeneration: record.nativeGeneration, expectedUpdatedAt: record.updatedAt });
  const body = { operationId: randomUUID(), factorySessionId: f.record.factorySessionId, factoryCwd: f.record.factoryCwd,
    selected: identity(f.record), sources: [identity(source)] };
  const send = async (data: unknown) => fetch(`${f.app.url}/internal/select-native-lineage`, { method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify(data) });
  const preview = await send({ ...body, dryRun: true }); expect(preview.status).toBe(200);
  const proof = await preview.json() as { proofSha256: string };
  const selected = await send({ ...body, proofSha256: proof.proofSha256, approval: { reference: "test-only-explicit-approval", approvedAt: new Date().toISOString(),
    selectedBridgeSessionId: f.record.bridgeSessionId, selectedSdkSessionId: f.sdkId, sourceBridgeSessionIds: [source.bridgeSessionId] } });
  expect(selected.status).toBe(200);
  const request: MessagesRequest = { ...f.request, messages: [{ role: "user", content: `[factory-cc-session:${f.token}] Compacted foreign work` },
    { role: "assistant", content: [{ type: "tool_use", id: "foreign-done", name: "Script", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "foreign-done", content: "foreign output" },
      { type: "text", text: `[factory-cc-session:${f.token}] Reconcile the branches` }] }] };
  return { ...f, source, request };
}
describe("selected native lineage HTTP to SDK reconciliation", () => {
  it("denies new host and native actions, then permits the next normal compacted continuation on the original SDK", async () => {
    const f = await selectionFixture(); f.sdk.attemptTools = true; f.sdk.hostActionOnInput = 1;
    const response = await postMessages(f.app.url, "client", f.request, f.headers);
    expect(response.status, JSON.stringify(response.json)).toBe(200); expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.denials).toHaveLength(2);
    expect(f.sdk.denials.every(result => (result as { behavior: string }).behavior === "deny")).toBe(true);
    expect(f.sdk.inputs[0]!.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("foreign output") })]));
    expect(f.record.pendingLineageReconciliation).toBeUndefined();
    expect(f.record.nativeLineageSelection?.reconciledAt).toBeDefined();
    f.sdk.hostActionOnInput = 2;
    const second: MessagesRequest = { ...f.request, messages: [{ role: "user", content: `[factory-cc-session:${f.token}] Compacted again` },
      f.request.messages.at(-1)!, { role: "assistant", content: response.json.content as ContentBlock[] },
      { role: "user", content: "Context" }, { role: "user", content: `[factory-cc-session:${f.token}] Start next batch` }] };
    const next = await postMessages(f.app.url, "client", second, f.headers);
    expect(next.status).toBe(200);
    expect(next.json.stop_reason).toBe("tool_use");
    expect(next.json.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_use", name: "Script" })]));
    expect(f.sdk.options[0]?.resume).toBe(f.sdkId); expect(f.sdk.options).toHaveLength(1);
    expect(f.sdk.inputs).toHaveLength(2); expect(f.app.store.list()).toHaveLength(2);
    expect(f.source.hostCompletionReceipts).toHaveLength(1);
  });
  it("still latches and cleans explicit cancellation when evidence archival fails", async () => {
    const f = await fixture([], false, true), cancel = vi.spyOn(f.runtime, "cancel");
    vi.spyOn(f.app.store, "updateAtomic").mockImplementationOnce(() => { throw new Error("archive failed"); });
    const response = await fetch(`${f.app.url}/internal/cancel`, { method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: f.record.bridgeSessionId, preserveForLineageSelection: true }) });
    expect(response.status).toBe(500);
    expect(f.record).toMatchObject({ state: "CANCELLED", cancelRequested: true, cancellation: { source: "admin" } });
    expect(cancel).toHaveBeenCalledWith(f.record.bridgeSessionId, "admin-cancel");
    expect(f.record.lineageCancellation).toBeUndefined();
  });

  it("preserves the selected owner through SessionEnd, controller hydration and fresh SessionStart", async () => {
    const f = await selectionFixture();
    const first = await postMessages(f.app.url, "client", f.request, f.headers);
    expect(first.status).toBe(200);
    const ended = await fetch(`${f.app.url}/internal/host-events`, { method: "POST",
      headers: { authorization: "Bearer hook", "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), bindingToken: f.token,
        event: { hook_event_name: "SessionEnd", session_id: FACTORY_SESSION, cwd: f.record.factoryCwd, reason: "exit" } }) });
    expect(ended.status).toBe(200); expect(f.record.hostEnded).toBe("resumable");
    await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
    const sdk = new ProviderAdapter(f.sdkId, []), runtime = new SdkRuntime(f.config, { info() {}, warn() {}, error() {} }, sdk);
    vi.spyOn(DesktopJobsRuntime.prototype, "handle").mockImplementation((input, sink) => runtime.handle(input, sink));
    const app = createBridgeApp(f.config, { info() {}, warn() {}, error() {} }, "", runtime); apps.push(app); await listen(app, f.config);
    const token = await hostStart(app, f.root), owner = app.store.require(f.record.bridgeSessionId);
    const request: MessagesRequest = { ...f.request, messages: [{ role: "user", content: `[factory-cc-session:${token}] Fresh compacted context` },
      f.request.messages.at(-1)!, { role: "assistant", content: first.json.content as ContentBlock[] },
      { role: "user", content: "Restart context" }, { role: "user", content: `[factory-cc-session:${token}] Continue original lineage` }] };
    const second = await postMessages(app.url, "client", request, f.headers);
    expect(second.status, JSON.stringify(second.json)).toBe(200); expect(second.session).toBe(owner.bridgeSessionId);
    expect(owner.sdkSessionId).toBe(f.sdkId); expect(owner.nativeGeneration).toBe(9);
    expect(sdk.options[0]?.resume).toBe(f.sdkId); expect(app.store.list()).toHaveLength(2);
  });

  it("retains the pending reconciliation across a quota failure followed by normal host end", async () => {
    const f = await selectionFixture([529]);
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(529);
    const ended = await fetch(`${f.app.url}/internal/host-events`, { method: "POST",
      headers: { authorization: "Bearer hook", "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), bindingToken: f.token,
        event: { hook_event_name: "SessionEnd", session_id: FACTORY_SESSION, cwd: f.record.factoryCwd, reason: "exit" } }) });
    expect(ended.status).toBe(200);
    expect(f.record.hostEnded).toBe("resumable");
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.record.sdkSessionId).toBe(f.sdkId);
  });

  it.each(["empty", "none"] as const)("keeps an interactive owner through an explicit tool-free %s turn and subsequent compaction", async mode => {
    const f = await selectionFixture(); f.config.desktopProfile = false;
    const headers = { ...f.headers, "x-bridge-cwd": f.record.factoryCwd! };
    const first = await postMessages(f.app.url, "client", f.request, headers);
    expect(first.status).toBe(200);
    const noTools = toolFree({ ...f.request, messages: [...f.request.messages,
      { role: "assistant", content: first.json.content as ContentBlock[] },
      { role: "user", content: `[factory-cc-session:${f.token}] Explain without tools` }] }, mode);
    const second = await postMessages(f.app.url, "client", noTools, { ...headers, "x-bridge-session": f.record.bridgeSessionId });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(f.record.toolNames).toEqual(mode === "empty" ? [] : ["Script"]); expect(f.record.nativePurpose).toBe("interactive");
    const next: MessagesRequest = { ...f.request, messages: [{ role: "user", content: `[factory-cc-session:${f.token}] Rewritten summary` },
      noTools.messages.at(-1)!, { role: "assistant", content: second.json.content as ContentBlock[] },
      { role: "user", content: "Context" }, { role: "user", content: "Continue normally" }] };
    const third = await postMessages(f.app.url, "client", next, headers);
    expect(third.status, JSON.stringify(third.json)).toBe(200); expect(third.session).toBe(f.record.bridgeSessionId);
    expect(f.sdk.inputs).toHaveLength(3); expect(f.record.sdkSessionId).toBe(f.sdkId);
  });

  it.each(["stale-source", "corrupt-source"])("checks %s on an explicit tool-free continuation", async kind => {
    const f = await selectionFixture(); f.config.desktopProfile = false;
    const headers = { ...f.headers, "x-bridge-cwd": f.record.factoryCwd! };
    const first = await postMessages(f.app.url, "client", f.request, headers);
    expect(first.status).toBe(200);
    if (kind === "stale-source") f.app.store.update(f.source.bridgeSessionId, { notes: ["changed source record"] });
    else writeFileSync(join(f.root, "team5", "projects", f.record.factoryCwd!.replace(/[^A-Za-z0-9]/g, "-"), f.source.sdkSessionId + ".jsonl"), "corrupt");
    const request = toolFree({ ...f.request, messages: [...f.request.messages,
      { role: "assistant", content: first.json.content as ContentBlock[] },
      { role: "user", content: `[factory-cc-session:${f.token}] Explain without tools` }] }, "none");
    const before = structuredClone(f.record);
    const response = await postMessages(f.app.url, "client", request, { ...headers, "x-bridge-session": f.record.bridgeSessionId });
    expect(response.status).toBe(409); expect(f.sdk.inputs).toHaveLength(1); expect(f.record).toEqual(before);
    expect(response.json.error).toMatchObject({ type: kind === "stale-source" ? "native_lineage_selection_refused" : "completed_host_recovery_refused" });
  });

  it.each((["empty", "none"] as const).flatMap(mode => ["same-model", "changed-model"].map(kind => ({ mode, kind }))))(
    "refuses explicit pending $mode reconciliation with $kind", async ({ mode, kind }) => {
    const f = await selectionFixture(); f.config.desktopProfile = false;
    f.config.models!.push({ id: "other", model: "claude-sonnet-4-6", displayName: "Other" });
    const headers = { ...f.headers, "x-bridge-cwd": f.record.factoryCwd!, "x-bridge-session": f.record.bridgeSessionId };
    const request = toolFree({ ...f.request, model: kind === "changed-model" ? "other" : f.request.model }, mode);
    const before = structuredClone(f.record);
    const response = await postMessages(f.app.url, "client", request, headers);
    expect(response.status).toBe(409); expect(f.sdk.inputs).toHaveLength(0); expect(f.record).toEqual(before);
    expect(response.json.error).toMatchObject({ type: "lineage_reconciliation_context_changed" });
  });

  it.each(["model", "reasoning"])("preserves a legitimate %s change and the following selected-owner request", async change => {
    const f = await selectionFixture();
    f.config.models!.push({ id: "other", model: "claude-sonnet-4-6", displayName: "Other" });
    const first = await postMessages(f.app.url, "client", f.request, f.headers);
    expect(first.status).toBe(200);
    const originalAudit = structuredClone(f.record.nativeLineageSelection);
    const switched: MessagesRequest = { ...f.request, ...(change === "model" ? { model: "other" } : { output_config: { effort: "high" } }),
      messages: [...f.request.messages, { role: "assistant", content: first.json.content as ContentBlock[] },
        { role: "user", content: `[factory-cc-session:${f.token}] Change the ${change}` }] };
    const second = await postMessages(f.app.url, "client", switched, f.headers);
    expect(second.status, JSON.stringify(second.json)).toBe(200); expect(second.session).toBe(f.record.bridgeSessionId);
    expect(f.record.nativeLineageSelection).toEqual(originalAudit);
    const next: MessagesRequest = { ...switched, messages: [...switched.messages,
      { role: "assistant", content: second.json.content as ContentBlock[] }, { role: "user", content: `[factory-cc-session:${f.token}] Continue` }] };
    const third = await postMessages(f.app.url, "client", next, f.headers);
    expect(third.status, JSON.stringify(third.json)).toBe(200); expect(third.session).toBe(f.record.bridgeSessionId);
    expect(f.record.nativeLineageSelection).toEqual(originalAudit);
    expect(f.sdk.options.every(option => option.resume === f.sdkId)).toBe(true);
    expect(f.sdk.inputs).toHaveLength(3); expect(f.app.store.list()).toHaveLength(2);
  });

  it.each(["model", "reasoning"])("keeps pending reconciliation strict for a %s change", async change => {
    const f = await selectionFixture();
    f.config.models!.push({ id: "other", model: "claude-sonnet-4-6", displayName: "Other" });
    const request = { ...f.request, ...(change === "model" ? { model: "other" } : { output_config: { effort: "high" } }) };
    const response = await postMessages(f.app.url, "client", request, { ...f.headers, "x-bridge-session": f.record.bridgeSessionId });
    expect(response.status).toBe(409); expect(f.sdk.inputs).toHaveLength(0);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
  });

  it("preserves reconciliation on pre-prompt deferral and refuses a terminal 502 retry", async () => {
    const f = await selectionFixture([502]);
    vi.spyOn(f.runtime, "handle").mockRejectedValueOnce(new BridgeError(503, "desktop_job_timeout", "deferred", { retry_safe: true, phase: "admission" }));
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(503);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.sdk.inputs).toHaveLength(0);
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(502);
    expect(f.record.state).toBe("FAILED");
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.checkpointRetry).not.toHaveBeenCalled();
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(409);
    expect(f.sdk.inputs).toHaveLength(1);
  });

  it.each(["unknown", "changed", "duplicate", "missing"])("refuses %s cross-lineage results before a query", async kind => {
    const f = await selectionFixture();
    const blocks = f.request.messages.at(-1)!.content as ContentBlock[];
    if (kind === "unknown") blocks[0] = { ...blocks[0], tool_use_id: "unknown" };
    if (kind === "changed") blocks[0] = { ...blocks[0], content: "changed result" };
    if (kind === "duplicate") blocks.push({ ...blocks[0] });
    if (kind === "missing") { blocks[0] = { type: "tool_result", content: "missing identity" }; }
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(409);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.sdk.inputs).toHaveLength(0);
  });

  it.each([429, 529])("retains the hard reconciliation barrier across %s and same-SDK retry", async status => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T14:00:00Z"));
    const f = await selectionFixture([status]); f.sdk.attemptTools = true;
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(status);
    expect(f.record.pendingLineageReconciliation).toBeDefined();
    expect(f.record.retainedCheckpoint?.sdkSessionId).toBe(f.sdkId);
    vi.setSystemTime(new Date("2026-11-10T14:02:00Z"));
    expect((await postMessages(f.app.url, "client", f.request, f.headers)).status).toBe(200);
    expect(f.sdk.denials.every(result => (result as { behavior: string }).behavior === "deny")).toBe(true);
    expect(f.record.pendingLineageReconciliation).toBeUndefined();
    expect(f.sdk.options.map(option => option.resume)).toEqual([f.sdkId, f.sdkId]);
  });
});
