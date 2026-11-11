import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";
import { BridgeError } from "../../src/types.js";
import { continuation, firstTurn, hostStart, restartConfig } from "../helpers/native-restart.js";
import { postMessages } from "../helpers/server.js";
import { hostResultDigest, mcpResultContent } from "../../src/runtime/host-recovery.js";
import { COMPACTION_SUMMARY, SAME_SESSION_COMPACTION_SUMMARY } from "../../src/workspace.js";

const roots: string[] = [], apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-upstream-retry-"))); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const sdkSessionId = randomUUID();
  const base = restartConfig(root);
  const config = { ...base, desktopJobs: false, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
    env: { ...account.env, CLAUDE_CONFIG_DIR: join(root, account.profile) } })) };
  const observed: Array<{ account?: string; sdk?: string; recovery?: string; generation?: number }> = [];
  const handle = vi.fn(async (input: RuntimeRequest): Promise<RuntimeTurn> => {
    observed.push({ account: input.session.claudeAccount, sdk: input.session.sdkSessionId, recovery: input.recovery, generation: input.session.nativeGeneration });
    return { response: { id: randomUUID(), type: "message" as const, role: "assistant" as const, model: "opus", content: [{ type: "text" as const, text: "Planned." }],
      stop_reason: "end_turn" as const, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, pendingToolIds: [], sdkSessionId };
  });
  const runtime: BridgeRuntime & { handle: typeof handle; prepareCheckpointRetry: ReturnType<typeof vi.fn>; prepareColdRetry: ReturnType<typeof vi.fn> } = {
    kind: "fake", handle, cancel: vi.fn(async () => undefined), deliverResults: async () => [],
    prepareCheckpointRetry: vi.fn(async () => undefined), prepareColdRetry: vi.fn(async () => undefined),
    endHostSession: async () => ({ resumable: true }), ownsNativeSession: () => false,
  };
  const logger = { info() {}, warn() {}, error() {} };
  const app = createBridgeApp(config, logger, "", runtime); apps.push(app); await listen(app, config);
  const token = await hostStart(app, root);
  const first = await postMessages(app.url, "client", firstTurn(token));
  const record = app.store.require(first.session!);
  const directory = join(root, record.claudeAccount!, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(directory, { recursive: true });
  const file = join(directory, sdkSessionId + ".jsonl");
  writeFileSync(file, JSON.stringify({ sessionId: sdkSessionId, message: { role: "user", content: [{ type: "text", text: "retained history" }] } }) + "\n");
  const next = continuation(token, token, "Continue the next task");
  return { root, app, runtime, record, token, next, sdkSessionId, observed, file, config, logger };
}

describe("established native upstream retry", () => {
  async function compactedRetryFixture(status = 529, generation = 6) {
    const f = await fixture();
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(status, status === 429 ? "rate_limit_error" : "overloaded_error", "limit",
      { retry_from_history: true, ...(status === 429 ? { retry_after: 120 } : {}) }));
    expect((await postMessages(f.app.url, "client", f.next)).status).toBe(status);
    f.app.store.update(f.record.bridgeSessionId, { nativeGeneration: generation,
      retainedCheckpoint: { ...f.record.retainedCheckpoint!, sourceGeneration: generation - 2 } });
    const ended = await fetch(`${f.app.url}/internal/host-events`, { method: "POST",
      headers: { authorization: "Bearer hook", "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), bindingToken: f.token,
        event: { hook_event_name: "SessionEnd", session_id: f.record.factorySessionId, cwd: join(f.root, "workspace"), reason: "exit" } }) });
    expect(ended.status).toBe(200);
    await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
    const restartedConfig = { ...f.config, port: 0 };
    const app = createBridgeApp(restartedConfig, f.logger, "", f.runtime); apps.push(app); await listen(app, restartedConfig);
    const token = await hostStart(app, f.root);
    const record = app.store.require(f.record.bridgeSessionId);
    expect(record).toMatchObject({ nativeGeneration: generation + 1, sdkSessionId: f.sdkSessionId, hostEnded: "resumable" });
    const request = { ...firstTurn(token), messages: [
      { role: "user", content: `${COMPACTION_SUMMARY}\nRewritten prefix` },
      ...firstTurn(f.token).messages,
      { role: "assistant", content: [{ type: "text", text: "Planned." }] },
      { role: "user", content: "Previous failed quota request" },
      { role: "user", content: "Orderly shutdown context" },
      { role: "user", content: "Fresh host context" },
      { role: "user", content: `[factory-cc-session:${token}] Continue the workstream` },
    ] };
    expect(f.record.requestMessageHashes?.at(-1)).not.toBe(f.record.historyMessageHashes?.at(-2));
    return { ...f, app, record, request };
  }

  it.each([6, 2])("resumes the exact checkpoint after Quit, restart and fresh generation following g%s", async generation => {
    const f = await compactedRetryFixture(529, generation);
    const response = await postMessages(f.app.url, "client", f.request);
    expect(response.status).toBe(200); expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.observed.at(-1)).toEqual({ account: f.record.claudeAccount, sdk: f.sdkSessionId, generation: generation + 1, recovery: undefined });
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it("selects a WS5-shaped resumed checkpoint with an exact proven result before the new text", async () => {
    const f = await compactedRetryFixture(529, 2);
    const content = [{ type: "text" as const, text: "Script completed" }, { type: "text" as const, text: "output" }];
    const resultId = "consumed-script";
    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: resultId, name: "mcp__droid__Script", input: {} }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content: mcpResultContent(JSON.stringify(content)) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.app.store.update(f.record.bridgeSessionId, { retainedCheckpoint: { ...f.record.retainedCheckpoint!,
      checkpointSha256: createHash("sha256").update(readFileSync(f.file)).digest("hex"), settledToolIds: [resultId],
      settledToolResults: [{ toolUseId: resultId, resultSha256: hostResultDigest(JSON.stringify(content), false) }] } });
    const request = { ...f.request, messages: [...f.request.messages.slice(0, 3),
      { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content }] }, f.request.messages.at(-1)!] };
    const response = await postMessages(f.app.url, "client", request);
    expect(response.status).toBe(200);
    expect(response.session).toBe(f.record.bridgeSessionId);
    expect(f.observed.at(-1)).toEqual({ account: f.record.claudeAccount, sdk: f.sdkSessionId, generation: 3, recovery: undefined });
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it.each(["checkpoint", "receipt", "cancel", "explicit-id", "tool-result"])("refuses compacted retained retry when %s is unsafe", async unsafe => {
    const f = await compactedRetryFixture();
    if (unsafe === "checkpoint") writeFileSync(f.file, JSON.stringify({ sessionId: f.sdkSessionId, message: { role: "user", content: [] } }) + "\n");
    if (unsafe === "receipt") f.app.store.update(f.record.bridgeSessionId, { hostCompletionReceipts: [{ toolUseId: "unknown", toolName: "Read", input: {}, content: "done" }] });
    if (unsafe === "cancel") f.app.store.update(f.record.bridgeSessionId, { cancelRequested: true });
    const request = unsafe === "tool-result" ? { ...f.request, messages: [...f.request.messages,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "done" }] }] } : f.request;
    const before = structuredClone(f.record), count = f.runtime.handle.mock.calls.length;
    const response = await postMessages(f.app.url, "client", request, unsafe === "explicit-id" ? { "x-bridge-session": "wrong-id" } : {});
    expect(response.status).toBe(409);
    expect(f.record).toEqual(before);
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.runtime.handle).toHaveBeenCalledTimes(count);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it.each(["none", "missing-id", "null-id", "numeric-id"])("refuses %s through the normal HTTP path without selecting the retained checkpoint", async invalid => {
    const f = await compactedRetryFixture(), before = structuredClone(f.record), count = f.runtime.handle.mock.calls.length;
    const request = invalid === "none" ? { ...f.request, tool_choice: { type: "none" } } : { ...f.request,
      messages: [...f.request.messages, { role: "user", content: [{ type: "tool_result", content: "done",
        ...(invalid === "missing-id" ? {} : { tool_use_id: invalid === "null-id" ? null : 42 }) }] }] };
    const response = await postMessages(f.app.url, "client", request);
    expect(response.status).toBe(409);
    expect(f.record).toEqual(before);
    expect(f.app.store.list()).toHaveLength(1);
    expect(f.runtime.handle).toHaveBeenCalledTimes(count);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it("enforces the original account cooldown before a compacted retained retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T13:00:00Z"));
    const f = await compactedRetryFixture(429), calls = f.runtime.handle.mock.calls.length;
    expect((await postMessages(f.app.url, "client", f.request)).status).toBe(429);
    expect(f.runtime.handle).toHaveBeenCalledTimes(calls);
    expect(f.record.sdkSessionId).toBe(f.sdkSessionId);
    vi.setSystemTime(new Date("2026-11-10T13:03:00Z"));
    expect((await postMessages(f.app.url, "client", f.request)).status).toBe(200);
    expect(f.observed.at(-1)?.recovery).toBeUndefined();
  });

  it.each(["legacy", "retained", "cooling"])("fences the same Factory scope's %s checkpoint when changed history no longer correlates", async kind => {
    const f = await fixture();
    if (kind === "legacy") f.app.store.update(f.record.bridgeSessionId, { sdkSessionId: undefined, retryableRequestKind: "upstream", retryableRequestHash: "1".repeat(64) });
    else {
      f.runtime.handle.mockRejectedValueOnce(new BridgeError(kind === "cooling" ? 429 : 529,
        kind === "cooling" ? "rate_limit_error" : "overloaded_error", "limit", { retry_from_history: true, retry_after: 120 }));
      await postMessages(f.app.url, "client", f.next);
    }
    const calls = f.runtime.handle.mock.calls.length, before = f.app.store.list().length;
    const cooldowns = structuredClone(f.record.accountCooldowns);
    for (const messages of [
      [{ role: "user", content: `[factory-cc-session:${f.token}] Different history` }],
      [{ role: "user", content: `${COMPACTION_SUMMARY}\nA compacted transcript without the prior tail.` },
        { role: "assistant", content: "Compacted." }, { role: "user", content: `[factory-cc-session:${f.token}] Continue` }],
    ]) {
      const reply = await postMessages(f.app.url, "client", { model: "opus", max_tokens: 20, messages });
      expect(reply.status).toBe(409);
      expect(reply.json.error).toMatchObject({ type: "native_checkpoint_selection_required" });
      expect(f.app.store.list()).toHaveLength(before);
      expect(f.runtime.handle).toHaveBeenCalledTimes(calls);
      expect(f.record.accountCooldowns).toEqual(cooldowns);
    }
    const otherId = randomUUID();
    const response = await fetch(`${f.app.url}/internal/host-events`, { method: "POST", headers: { authorization: "Bearer hook", "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), desktopLifecycle: true, event: { hook_event_name: "SessionStart", session_id: otherId,
        cwd: join(f.root, "workspace"), bridgeNativeWorkstream: { role: "agent", workstreamId: randomUUID() } } }) });
    const other = await response.json() as { bindingToken: string };
    expect(response.status).toBe(200);
    expect((await postMessages(f.app.url, "client", firstTurn(other.bindingToken))).status).toBe(200);
    expect(f.app.store.list()).toHaveLength(before + 1);
  });

  it("refuses a legacy established retry whose SDK reference needs operator restoration", async () => {
    const f = await fixture();
    f.app.store.update(f.record.bridgeSessionId, { sdkSessionId: undefined, retryableRequestKind: "upstream", retryableRequestHash: "1".repeat(64) });
    const response = await postMessages(f.app.url, "client", f.next, { "x-bridge-session": f.record.bridgeSessionId });
    expect(response.status).toBe(409);
    expect(response.json.error).toMatchObject({ type: "native_checkpoint_restoration_required" });
    expect(f.runtime.handle).toHaveBeenCalledTimes(1);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it("retires only host actions whose native results are present after a clean quota error", async () => {
    const f = await fixture();
    const receipt = { toolUseId: "settled-action", toolName: "Read", input: { path: "fixture" }, content: "read completed" };
    f.app.store.update(f.record.bridgeSessionId, { state: "WAITING_DROID_TOOL", pendingToolIds: [receipt.toolUseId] });
    f.app.store.recordHostCompletion(f.record.bridgeSessionId, receipt);
    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: receipt.toolUseId, name: "mcp__droid__Read", input: receipt.input }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.toolUseId, content: mcpResultContent(receipt.content) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(529, "overloaded_error", "limit", { retry_from_history: true }));
    const failed = await postMessages(f.app.url, "client", f.next, { "x-bridge-session": f.record.bridgeSessionId });
    expect(failed.status).toBe(529);
    expect(f.record).toMatchObject({ sdkSessionId: f.sdkSessionId, pendingToolIds: [], hostCompletionReceipts: [],
      retainedCheckpoint: { settledToolIds: [receipt.toolUseId] } });
  });

  it("carries proven consumed results through consecutive quota failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    const f = await fixture();
    const receipt = { toolUseId: "settled-twice", toolName: "Script", input: { script: "read fixture" }, content: "done" };
    f.app.store.update(f.record.bridgeSessionId, { state: "WAITING_DROID_TOOL", pendingToolIds: [receipt.toolUseId] });
    f.app.store.recordHostCompletion(f.record.bridgeSessionId, receipt);
    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: receipt.toolUseId, name: "mcp__droid__Script", input: receipt.input }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.toolUseId, content: mcpResultContent(receipt.content) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      f.runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "limit", { retry_from_history: true, retry_after: 60 }));
      const response = await postMessages(f.app.url, "client", f.next, { "x-bridge-session": f.record.bridgeSessionId });
      expect(response.status).toBe(429);
      expect(f.record.retainedCheckpoint?.settledToolResults).toEqual([{ toolUseId: receipt.toolUseId, resultSha256: hostResultDigest(receipt.content, false) }]);
      expect(f.record.hostCompletionReceipts).toEqual([]);
      expect(f.record.nativeGeneration).toBe(attempt + 1);
      vi.setSystemTime(new Date(`2026-11-10T10:0${attempt + 1}:30Z`));
    }
    expect((await postMessages(f.app.url, "client", f.next)).status).toBe(200);
    expect(f.record.retainedCheckpoint).toBeUndefined();
  });

  it("derives missing legacy result hashes from the unchanged retained checkpoint", async () => {
    const f = await fixture();
    const result = { toolUseId: "legacy-settled", content: "done" };
    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: result.toolUseId, name: "mcp__droid__Script", input: {} }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: result.toolUseId, content: mcpResultContent(result.content) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(529, "overloaded_error", "limit", { retry_from_history: true }));
    await postMessages(f.app.url, "client", f.next);
    f.record.retainedCheckpoint!.settledToolIds = [result.toolUseId];
    delete f.record.retainedCheckpoint!.settledToolResults;
    const calls = f.runtime.handle.mock.calls.length;
    f.runtime.handle.mockImplementationOnce(async input => {
      expect(input.session.retainedCheckpoint?.settledToolResults).toEqual([{ toolUseId: result.toolUseId, resultSha256: hostResultDigest(result.content, false) }]);
      return { response: { id: randomUUID(), type: "message", role: "assistant", model: "opus", content: [{ type: "text", text: "Continued" }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, pendingToolIds: [], sdkSessionId: f.sdkSessionId };
    });
    expect((await postMessages(f.app.url, "client", f.next)).status).toBe(200);
    expect(f.runtime.handle).toHaveBeenCalledTimes(calls + 1);
  });

  it("preserves a paired failed host result during ordinary checkpoint retry", async () => {
    const f = await fixture();
    const receipt = { toolUseId: "failed-host", toolName: "Script", input: {}, content: "command failed", isError: true };
    f.app.store.update(f.record.bridgeSessionId, { state: "WAITING_DROID_TOOL", pendingToolIds: [receipt.toolUseId] });
    f.app.store.recordHostCompletion(f.record.bridgeSessionId, receipt);
    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: receipt.toolUseId, name: "mcp__droid__Script", input: {} }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.toolUseId, content: mcpResultContent(receipt.content), is_error: true }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(529, "overloaded_error", "limit", { retry_from_history: true }));
    expect((await postMessages(f.app.url, "client", f.next)).status).toBe(529);
    expect(f.record.retainedCheckpoint?.settledToolResults).toEqual([{ toolUseId: receipt.toolUseId, resultSha256: hostResultDigest(receipt.content, true) }]);
  });

  it("keeps the same checkpoint when a clean upstream failure follows an authenticated compacted tool result", async () => {
    const f = await fixture();
    const cwd = join(f.root, "workspace");
    const tool = { type: "tool_use" as const, id: "compacted-read", name: "Read", input: { path: "one.txt" } };
    const content = "read once";
    f.runtime.pendingHostCalls = () => [{ toolUseId: tool.id, toolName: tool.name, input: tool.input }];
    f.runtime.recordHostToolCompletion = async () => "accepted";
    f.runtime.handle.mockResolvedValueOnce({ response: assistantMessage("opus", [tool], "tool_use"),
      pendingToolIds: [tool.id], sdkSessionId: f.sdkSessionId });
    expect((await postMessages(f.app.url, "client", f.next)).status).toBe(200);
    const hook = await fetch(`${f.app.url}/internal/host-events`, { method: "POST",
      headers: { authorization: "Bearer hook", "content-type": "application/json" },
      body: JSON.stringify({ eventId: randomUUID(), bindingToken: f.token, event: { hook_event_name: "PostToolUse",
        session_id: f.record.factorySessionId, cwd, tool_name: tool.name, tool_input: tool.input, tool_response: content } }) });
    expect(hook.status).toBe(200);
    const { additionalContext } = await hook.json() as { additionalContext?: string };
    expect(additionalContext).toMatch(/^\[factory-cc-continuation:[a-f0-9]{64}\]$/);

    writeFileSync(f.file, [
      { sessionId: f.sdkSessionId, message: { role: "assistant", content: [{ ...tool, name: "mcp__droid__Read" }] } },
      { sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: mcpResultContent(content) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(529, "overloaded_error", "limit", { retry_from_history: true }));
    const failed = await postMessages(f.app.url, "client", { ...firstTurn(f.token), messages: [
      { role: "user", content: [
        { type: "text", text: `${SAME_SESSION_COMPACTION_SUMMARY}\nRewritten prefix` },
        { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n${cwd}\n\n</system-reminder>` },
      ] },
      { role: "assistant", content: [tool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content }] },
      { role: "user", content: additionalContext },
    ] });
    expect(failed.status, failed.raw).toBe(529);
    expect(failed.json.error).toMatchObject({ checkpoint_retained: true, retry_mode: "native_checkpoint", retry_from_history: false,
      factory_binding_refresh_required: true, message: expect.stringContaining("send a fresh message from the existing Factory Workstream") });
    expect(f.record).toMatchObject({ state: "IDLE", sdkSessionId: f.sdkSessionId, nativeGeneration: 1, retryableRequestKind: "native-upstream" });
    expect(f.record.retainedCheckpoint?.settledToolResults).toEqual([{ toolUseId: tool.id, resultSha256: hostResultDigest(content, false) }]);
    expect(f.runtime.prepareCheckpointRetry).toHaveBeenCalledWith(f.record.bridgeSessionId, f.sdkSessionId);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
    expect(f.runtime.cancel).not.toHaveBeenCalled();
  });

  it.each([429, 529])("retains checkpoint and account after %s, then resumes without cold import", async status => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    const f = await fixture(), account = f.record.claudeAccount;
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(status, status === 429 ? "rate_limit_error" : "overloaded_error", "synthetic limit", {
      retry_from_history: true, ...(status === 429 ? { retry_after: 120 } : {}) }));
    const failed = await postMessages(f.app.url, "client", f.next);
    expect(failed.status).toBe(status);
    expect(failed.json.error).toMatchObject({ checkpoint_retained: true, retry_mode: "native_checkpoint", retry_from_history: false });
    expect(f.record).toMatchObject({ state: "IDLE", sdkSessionId: f.sdkSessionId, claudeAccount: account, nativeGeneration: 1,
      retryableRequestKind: "native-upstream", retainedCheckpoint: { sdkSessionId: f.sdkSessionId, account, sourceGeneration: 0 } });
    expect(f.runtime.prepareCheckpointRetry).toHaveBeenCalledWith(f.record.bridgeSessionId, f.sdkSessionId);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
    if (status === 429) {
      const deferred = await postMessages(f.app.url, "client", f.next);
      expect(deferred.status).toBe(429); expect(f.runtime.handle).toHaveBeenCalledTimes(2);
      expect(f.record.accountCooldowns?.[account!]).toBe("2026-11-10T10:02:00.000Z");
      vi.setSystemTime(new Date("2026-11-10T10:03:00Z"));
    }
    const resumed = await postMessages(f.app.url, "client", f.next);
    expect(resumed.status).toBe(200); expect(resumed.session).toBe(f.record.bridgeSessionId);
    expect(f.observed.at(-1)).toEqual({ account, sdk: f.sdkSessionId, generation: 1, recovery: undefined });
    expect(f.record.retainedCheckpoint).toBeUndefined();
  });

  it.each(["cleanup", "checkpoint"])("keeps the original reference and fails closed when %s proof is unavailable", async missing => {
    const f = await fixture();
    if (missing === "cleanup") f.runtime.prepareCheckpointRetry.mockRejectedValueOnce(new Error("cleanup unavailable"));
    else rmSync(f.file);
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "limit", { retry_from_history: true, retry_after: 120 }));
    const failed = await postMessages(f.app.url, "client", f.next);
    expect(failed.status).toBe(503);
    expect(f.record).toMatchObject({ sdkSessionId: f.sdkSessionId, state: "FAILED", checkpointRetryBlocked: true });
    const retry = await postMessages(f.app.url, "client", f.next);
    expect(retry.status).toBe(409); expect(f.runtime.handle).toHaveBeenCalledTimes(2);
    expect(f.runtime.prepareColdRetry).not.toHaveBeenCalled();
  });

  it("restores cooldown floors from persisted sessions after an application restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    const f = await fixture();
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "limit", { retry_from_history: true, retry_after: 120 }));
    await postMessages(f.app.url, "client", f.next);
    await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
    const restarted = createBridgeApp(f.config, f.logger, "", f.runtime); apps.push(restarted); await listen(restarted, f.config);
    const status = restarted.runtimeStatus() as { controllerPool: { accounts: Array<{ id: string; coolingUntil?: string }> } };
    expect(status.controllerPool.accounts.find(account => account.id === f.record.claudeAccount)?.coolingUntil).toBe("2026-11-10T10:02:00.000Z");
    expect(restarted.store.require(f.record.bridgeSessionId).sdkSessionId).toBe(f.sdkSessionId);
  });

  it("rechecks the retained checkpoint before a later warm prompt", async () => {
    const f = await fixture();
    f.runtime.handle.mockRejectedValueOnce(new BridgeError(529, "overloaded_error", "limit", { retry_from_history: true }));
    await postMessages(f.app.url, "client", f.next);
    writeFileSync(f.file, JSON.stringify({ sessionId: f.sdkSessionId, message: { role: "user", content: [{ type: "text", text: "changed checkpoint" }] } }) + "\n");
    const retry = await postMessages(f.app.url, "client", f.next);
    expect(retry.status).toBe(409);
    expect(retry.json.error).toMatchObject({ type: "native_checkpoint_proof_changed" });
    expect(f.runtime.handle).toHaveBeenCalledTimes(2);
    expect(f.record.sdkSessionId).toBe(f.sdkSessionId);
  });
});
