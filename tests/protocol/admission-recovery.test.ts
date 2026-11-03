import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assistantMessage } from "../../src/protocol/messages.js";
import { BridgeError } from "../../src/types.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { DesktopJobsRuntime } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime, RuntimeHostCall, RuntimeHostCompletion, RuntimeTurn } from "../../src/runtime/types.js";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
const roots: string[] = [];
const model = "admission-fixture";
const first = { role: "user", content: "Perform the fixture task." };
const request = { model, max_tokens: 32, messages: [first] };
let runtime: BridgeRuntime;

function answer(): RuntimeTurn {
  return { response: assistantMessage(model, [{ type: "text", text: "Finished" }], "end_turn"), pendingToolIds: [] };
}

function queued(): BridgeError {
  return new BridgeError(503, "desktop_job_timeout", "The scheduler deferred this request.", {
    retry_safe: true, phase: "admission", retry_after: 1,
  });
}

beforeEach(() => {
  runtime = {
    kind: "fake",
    handle: vi.fn(async () => answer()),
    cancel: vi.fn(async () => {}),
    deliverResults: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("verified admission deferral", () => {
  it("retries a first request in the same session without cancelling or cold importing", async () => {
    vi.mocked(runtime.handle).mockRejectedValueOnce(queued());
    const { app, token } = await startTestBridge(); apps.push(app);
    const deferred = await postMessages(app.url, token, request);
    expect(deferred.status).toBe(503);
    expect(deferred.json.error).toMatchObject({ type: "desktop_job_timeout", retry_safe: true });
    expect(app.store.require(deferred.session!)).toMatchObject({ state: "IDLE", retryableRequestKind: "admission", cancelRequested: false });
    expect(runtime.cancel).not.toHaveBeenCalled();

    const completed = await postMessages(app.url, token, request);
    expect(completed.status).toBe(200);
    expect(completed.session).toBe(deferred.session);
    expect(app.store.list()).toHaveLength(1);
    expect(vi.mocked(runtime.handle).mock.calls[1]![0].recovery).toBeUndefined();
    expect(app.store.require(completed.session!).retryableRequestHash).toBeUndefined();
  });

  it("preserves completed tool ownership and SDK identity while its continuation waits", async () => {
    const tool = { type: "tool_use" as const, id: "toolu_append", name: "Execute", input: { command: "fixture append" } };
    vi.mocked(runtime.handle).mockResolvedValueOnce({
      response: assistantMessage(model, [tool], "tool_use"), pendingToolIds: [tool.id], sdkSessionId: "sdk-fixture",
    }).mockRejectedValueOnce(queued()).mockResolvedValueOnce(answer());
    const { app, token } = await startTestBridge(); apps.push(app);
    const started = await postMessages(app.url, token, request);
    const continuation = { ...request, messages: [first, { role: "assistant", content: [tool] }, {
      role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "append completed once" }],
    }] };
    const deferred = await postMessages(app.url, token, continuation);
    expect(deferred.status).toBe(503);
    expect(app.store.require(started.session!)).toMatchObject({
      state: "WAITING_DROID_TOOL", pendingToolIds: [tool.id], sdkSessionId: "sdk-fixture", retryableRequestKind: "admission",
    });
    expect(runtime.cancel).not.toHaveBeenCalled();
    const completed = await postMessages(app.url, token, continuation);
    expect(completed.status).toBe(200);
    expect(completed.session).toBe(started.session);
    expect(vi.mocked(runtime.handle).mock.calls[2]![0]).toMatchObject({ session: { sdkSessionId: "sdk-fixture" } });
    expect(vi.mocked(runtime.handle).mock.calls[2]![0].recovery).toBeUndefined();
  });

  it("keeps an unconfirmed admission failure terminal instead of assuming retry safety", async () => {
    vi.mocked(runtime.handle).mockRejectedValueOnce(new BridgeError(503, "desktop_job_timeout", "Cleanup was not confirmed."));
    const { app, token } = await startTestBridge(); apps.push(app);
    const result = await postMessages(app.url, token, request);
    expect(result.status).toBe(503);
    expect(app.store.require(result.session!)).toMatchObject({ state: "FAILED" });
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it("sends accepted stream activity before a queued model produces any output", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      sink?.activity?.();
      await waiting;
      return answer();
    });
    const { app, token } = await startTestBridge(); apps.push(app);
    const response = await fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    const reader = response.body!.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain("event: message_start");
    finish();
    let tail = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      tail += new TextDecoder().decode(chunk.value);
    }
    expect(tail).toContain("Finished");
    expect(tail).toContain("event: message_stop");
  });

  it("exposes a resumable admission error after streaming has already started", async () => {
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      sink?.activity?.();
      throw queued();
    });
    const { app, token } = await startTestBridge(); apps.push(app);
    const response = await fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    expect(events.find(event => event.type === "error").error).toMatchObject({
      type: "desktop_job_timeout", resumable: true, retry_mode: "same_request",
      session_id: response.headers.get("x-bridge-session"), session_state: "IDLE",
    });
  });

  it("keeps an authenticated host receipt when the following model request is rejected", async () => {
    const tool = { type: "tool_use" as const, id: "toolu_recorded", name: "Execute", input: { command: "fixture append" } };
    runtime.pendingHostCalls = vi.fn(() => [{ toolUseId: tool.id, toolName: tool.name, input: tool.input }]);
    runtime.validateHostToolCompletion = vi.fn();
    runtime.recordHostToolCompletion = vi.fn(async () => "accepted" as const);
    vi.mocked(runtime.handle).mockResolvedValueOnce({ response: assistantMessage(model, [tool], "tool_use"), pendingToolIds: [tool.id] });
    const { app, token } = await startTestBridge({
      desktopLifecycle: true, sdkCwd: process.cwd(), persistSessions: true,
      models: [{ id: model, model, displayName: "Admission fixture" }],
    });
    apps.push(app);
    const hostEvent = async (event: Record<string, unknown>, bindingToken?: string) => {
      const response = await fetch(`${app.url}/internal/host-events`, {
        method: "POST", headers: { authorization: "Bearer hook-token", "content-type": "application/json" },
        body: JSON.stringify({ eventId: randomUUID(), event, bindingToken, ...(bindingToken ? {} : { desktopLifecycle: true }) }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ bindingToken: string; additionalContext: string }>;
    };
    const host = { session_id: "receipt-host", cwd: process.cwd() };
    const registered = await hostEvent({ ...host, hook_event_name: "SessionStart" });
    const started = await postMessages(app.url, token, { ...request, messages: [{ role: "user", content: `${registered.additionalContext} Perform the fixture task.` }] });
    expect(started.status).toBe(200);
    await hostEvent({ ...host, hook_event_name: "PostToolUse", tool_name: tool.name, tool_use_id: tool.id,
      tool_input: tool.input, tool_response: "append completed once" }, registered.bindingToken);
    expect(runtime.recordHostToolCompletion).toHaveBeenCalledTimes(1);
    const receipt = app.store.require(started.session!).hostCompletionReceipts![0];
    expect(receipt).toMatchObject({ toolUseId: tool.id, content: "append completed once" });

    const rejected = await postMessages(app.url, token, { ...request, model: "unconfigured" });
    expect(rejected.status).toBe(400);
    expect(app.store.require(started.session!)).toMatchObject({
      state: "WAITING_DROID_TOOL", pendingToolIds: [tool.id], hostCompletionReceipts: [receipt],
    });
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("keeps three Workstreams progressing through a rejected transcript continuation", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "three-workstream-recovery-"))); roots.push(root);
    const folders = Object.fromEntries(["A", "B", "C"].map(name => {
      const folder = join(root, name); mkdirSync(folder); return [name, folder];
    }));
    const pending = new Map<string, RuntimeHostCall[]>();
    const recorded = new Map<string, RuntimeHostCompletion>();
    const counts = new Map<string, number>();
    let releaseB!: () => void;
    const bReady = new Promise<void>(done => { releaseB = done; });
    const workerTool = { type: "tool_use" as const, id: "worker-wait-A", name: "fixture-pool___factory_worker_wait", input: { id: "worker-A" } };
    const executeTool = { type: "tool_use" as const, id: "append-B", name: "Execute", input: { command: "append fixture receipt" } };
    const inner: BridgeRuntime = {
      kind: "fake", cancel: vi.fn(async () => { releaseB(); }), deliverResults: vi.fn(async () => []), close: vi.fn(async () => {}),
      pendingHostCalls: id => pending.get(id) ?? [],
      validateHostToolCompletion: (id, completion) => {
        expect(pending.get(id)).toContainEqual({ toolUseId: completion.toolUseId, toolName: completion.toolName, input: completion.input });
      },
      recordHostToolCompletion: vi.fn(async (_id, completion) => { recorded.set(completion.toolUseId, completion); return "accepted" as const; }),
      handle: vi.fn(async input => {
        const name = input.factorySession!.sessionId;
        const count = (counts.get(name) ?? 0) + 1; counts.set(name, count);
        if (name === "A" && count === 1) {
          pending.set(input.session.bridgeSessionId, [{ toolUseId: workerTool.id, toolName: workerTool.name, input: workerTool.input }]);
          return { response: assistantMessage(model, [workerTool], "tool_use"), pendingToolIds: [workerTool.id] };
        }
        if (name === "B" && count === 1) {
          await bReady;
          pending.set(input.session.bridgeSessionId, [{ toolUseId: executeTool.id, toolName: executeTool.name, input: executeTool.input }]);
          return { response: assistantMessage(model, [executeTool], "tool_use"), pendingToolIds: [executeTool.id] };
        }
        if (name === "B") {
          expect(input.session.hostCompletionReceipts).toHaveLength(1);
          expect(recorded.has(executeTool.id)).toBe(true);
        }
        pending.delete(input.session.bridgeSessionId);
        return { response: assistantMessage(model, [{ type: "text", text: `${name} progressed` }], "end_turn"), pendingToolIds: [] };
      }),
    };
    const nativeState = join(root, "native-state");
    const supervised = new DesktopJobsRuntime(inner, {
      pythonExecutable: "/usr/bin/python3", runtimePackagePath: resolve("native-runtime"), stateRoot: nativeState,
      workerMcpPrefix: "fixture-pool___", admissionTimeoutMs: 10_000,
      getBinding: input => ({ ...input.factorySession!, subscriptionProfile: "team1", workspacePolicy: "controller-host" }),
    });
    const config = loadConfig({ mode: "mock", port: 0, dataDir: join(root, "bridge"), sdkCwd: root,
      clientToken: "fixture-client", adminToken: "fixture-admin", hookToken: "fixture-hook", desktopLifecycle: true,
      models: [{ id: model, model, displayName: "Three Workstream fixture" }] });
    const app = createBridgeApp(config, createLogger(config.logDir), join(config.sandboxDir, "canary"), supervised);
    await listen(app, config); apps.push(app);
    const headers = (name: string) => ({ "x-bridge-cwd": folders[name]!, "x-bridge-role": "orchestrator" });
    const hostEvent = async (name: string, event: Record<string, unknown>, bindingToken?: string) => {
      const response = await fetch(`${app.url}/internal/host-events`, {
        method: "POST", headers: { authorization: "Bearer fixture-hook", "content-type": "application/json" },
        body: JSON.stringify({ eventId: randomUUID(), bindingToken, ...(bindingToken ? {} : { desktopLifecycle: true }),
          event: { session_id: name, cwd: folders[name], ...event } }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ bindingToken: string; additionalContext: string }>;
    };
    const hosts = Object.fromEntries(await Promise.all(["A", "B", "C"].map(async name =>
      [name, await hostEvent(name, { hook_event_name: "SessionStart" })])));
    const body = (name: string) => ({ ...request, messages: [{ role: "user", content: `${hosts[name]!.additionalContext} Begin ${name}.` }] });
    const a = await postMessages(app.url, config.clientToken, body("A"), headers("A"));
    expect(a.status).toBe(200);
    const bOpening = postMessages(app.url, config.clientToken, body("B"), headers("B"));
    await vi.waitFor(() => expect(counts.get("B")).toBe(1));
    const cResponse = await fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { ...headers("C"), authorization: `Bearer ${config.clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body("C"), stream: true }),
    });
    const reader = cResponse.body!.getReader();
    const queuedBytes = await reader.read();
    expect(new TextDecoder().decode(queuedBytes.value)).toContain("event: message_start");
    releaseB();
    const b = await bOpening;
    expect(b.status).toBe(200);
    let cText = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; cText += new TextDecoder().decode(chunk.value); }
    expect(cText).toContain("C progressed");
    const jobs = () => readdirSync(join(nativeState, "jobs")).filter(file => file.endsWith(".json"))
      .map(file => JSON.parse(readFileSync(join(nativeState, "jobs", file), "utf8")));
    expect(jobs().find(job => job.factorySessionId === "B").hostActionReservation).toBe(true);
    const sideEffect = join(folders.B!, "receipt.txt");
    appendFileSync(sideEffect, "once\n");
    const resultText = `Read transcript ${hosts.C!.additionalContext}`;
    await hostEvent("B", { hook_event_name: "PostToolUse", tool_name: executeTool.name, tool_use_id: executeTool.id,
      tool_input: executeTool.input, tool_response: resultText }, hosts.B!.bindingToken);
    expect(jobs().find(job => job.factorySessionId === "B").hostActionReservation).toBe(false);
    expect(app.store.require(b.session!).hostCompletionReceipts).toHaveLength(1);
    const invalid = await postMessages(app.url, config.clientToken, { ...body("B"), messages: [{
      role: "user", content: `${hosts.B!.additionalContext}${hosts.C!.additionalContext} conflicting host context`,
    }] }, headers("B"));
    expect(invalid.status).toBe(409);
    expect(app.store.require(b.session!).state).toBe("WAITING_DROID_TOOL");
    const bDone = await postMessages(app.url, config.clientToken, { ...body("B"), messages: [
      ...body("B").messages, { role: "assistant", content: [executeTool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: executeTool.id, content: resultText }] },
    ] }, headers("B"));
    expect(bDone.status).toBe(200);
    expect(bDone.session).toBe(b.session);
    expect(app.store.require(b.session!).hostCompletionReceipts).toEqual([]);
    const aDone = await postMessages(app.url, config.clientToken, { ...body("A"), messages: [
      ...body("A").messages, { role: "assistant", content: [workerTool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: workerTool.id, content: "Worker completed" }] },
    ] }, headers("A"));
    expect(aDone.status).toBe(200);
    expect(inner.recordHostToolCompletion).toHaveBeenCalledTimes(1);
    expect(readFileSync(sideEffect, "utf8")).toBe("once\n");
    expect(app.store.list().map(session => session.state)).toEqual(["IDLE", "IDLE", "IDLE"]);
  }, 15_000);
});
