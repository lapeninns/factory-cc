import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBroker } from "../../src/control/broker.js";
import { SessionStore } from "../../src/sessions/store.js";
import { installFactoryHooks } from "../../src/control/factory-hooks.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { MessagesRequest } from "../../src/types.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(enabled = true, factoryNative = false) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "desktop-hook-binding-"))); directories.push(cwd);
  const store = new SessionStore(cwd, false, 16);
  const runtime: BridgeRuntime = { kind: "sdk", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}),
    endHostSession: vi.fn(async () => ({ resumable: true })) };
  const broker = new ControlBroker(runtime, store, 1000, { desktopLifecycle: enabled, factoryNative });
  const event = (name = "SessionStart", extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: "desktop-a", cwd, ...extra });
  const start = (extra: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => broker.hostEvent({ eventId: randomUUID(), event: event("SessionStart", extra), desktopLifecycle: true, ...envelope });
  return { cwd, broker, runtime, event, start };
}

describe("opt-in Desktop lifecycle binding", () => {
  it("rejects the explicit Desktop path unless the broker opted in", async () => {
    const f = fixture(false);
    await expect(f.start()).rejects.toMatchObject({ code: "desktop_lifecycle_disabled" });
    expect(f.broker.describe()).toMatchObject({ activeHostSessions: 0 });
  });

  it("creates an internal launch and returns only exact live identity snapshots", async () => {
    const f = fixture(); const first = await f.start(); const token = first.bindingToken as string;
    const identity = f.broker.hostIdentity(token);
    expect(identity).toEqual({ sessionId: "desktop-a", cwd: f.cwd, launchId: expect.any(String), desktopLifecycle: true });
    expect(identity).not.toHaveProperty("token");
    expect(f.broker.hostIdentity(undefined)).toBeUndefined();
    expect(f.broker.hostIdentity("unknown")).toBeUndefined();
    const same = await f.start();
    expect(same.bindingToken).toBe(token);
    await expect(f.start({}, { bindingToken: "wrong-generation" })).rejects.toMatchObject({ code: "stale_host_event" });
  });

  it("pins native role metadata to its authenticated lifecycle generation", async () => {
    const f = fixture(true, true), native = { role: "agent", workstreamId: "00000000-0000-0000-0000-000000000001" };
    const started = await f.start({ bridgeNativeWorkstream: native });
    expect(f.broker.hostIdentity(started.bindingToken as string)).toMatchObject({ nativeWorkstream: native });
    await expect(f.broker.hostEvent({ eventId: randomUUID(), bindingToken: started.bindingToken,
      event: f.event("UserPromptSubmit", { bridgeNativeWorkstream: { ...native, role: "orchestrator" } }) }))
      .rejects.toMatchObject({ code: "native_workstream_conflict" });
    expect(f.broker.hostIdentity(started.bindingToken as string)).toMatchObject({ nativeWorkstream: native });
    const legacy = fixture(); const legacyStart = await legacy.start({ bridgeNativeWorkstream: native });
    expect(legacy.broker.hostIdentity(legacyStart.bindingToken as string)).not.toHaveProperty("nativeWorkstream");
  });

  it("keeps receipt replay idempotent and rejects changed content", async () => {
    const f = fixture();
    const input = { eventId: "desktop-receipt", event: f.event(), desktopLifecycle: true };
    const first = await f.broker.hostEvent(input);
    expect(await f.broker.hostEvent(input)).toEqual(first);
    expect(() => f.broker.hostEvent({ ...input, desktopLifecycle: false })).toThrowError(expect.objectContaining({ code: "conflicting_host_event" }));
  });

  it("requires generation authority for later events and keeps workspace identity exact", async () => {
    const f = fixture(); const started = await f.start(); const token = started.bindingToken as string;
    const request: MessagesRequest = { model: "test", max_tokens: 10, messages: [{ role: "user", content: `${started.additionalContext} task` }] };
    expect(f.broker.prepareRequest(request, f.cwd).binding).toBe(token);
    expect(() => f.broker.prepareRequest(request, `${f.cwd}-other`)).toThrowError(expect.objectContaining({ code: "host_workspace_mismatch" }));
    for (const hook of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"]) {
      await expect(f.broker.hostEvent({ eventId: randomUUID(), event: f.event(hook) })).rejects.toMatchObject({ code: "stale_host_event" });
    }
    expect(await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("UserPromptSubmit"), bindingToken: token }))
      .toMatchObject({ ok: true, additionalContext: started.additionalContext });
  });

  it("does not let an ended generation end or claim its successor", async () => {
    const f = fixture(); const first = await f.start();
    await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionEnd"), bindingToken: first.bindingToken });
    expect(f.broker.hostIdentity(first.bindingToken as string)).toBeUndefined();
    const second = await f.start();
    expect(second.bindingToken).not.toBe(first.bindingToken);
    await expect(f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionEnd"), bindingToken: first.bindingToken })).rejects.toMatchObject({ code: "stale_host_event" });
    expect(f.broker.hostIdentity(second.bindingToken as string)?.sessionId).toBe("desktop-a");
  });

  it("requires the predecessor token for a Desktop compact handoff", async () => {
    const f = fixture(); const first = await f.start();
    const oldIdentity = f.broker.hostIdentity(first.bindingToken as string)!;
    const handoff = { session_id: "desktop-b", source: "compact", previous_session_id: "desktop-a" };
    await expect(f.start(handoff)).rejects.toMatchObject({ code: "stale_host_event" });
    const second = await f.start(handoff, { bindingToken: first.bindingToken });
    expect(f.broker.hostIdentity(first.bindingToken as string)).toBeUndefined();
    expect(f.broker.hostIdentity(second.bindingToken as string)).toMatchObject({ sessionId: "desktop-b", launchId: oldIdentity.launchId });
  });

  it("cannot substitute direct Desktop admission for an existing wrapper launch", async () => {
    const f = fixture(); const launch = f.broker.createLaunch({ cwd: f.cwd });
    await f.broker.hostEvent({ eventId: randomUUID(), event: f.event(), launchId: launch.launchId });
    await expect(f.start()).rejects.toMatchObject({ code: "conflicting_host_launch" });
    await expect(f.start({ session_id: "other" }, { launchId: launch.launchId })).rejects.toMatchObject({ code: "desktop_lifecycle_disabled" });
  });
});

describe("direct Desktop hook process", () => {
  it("requires the private opt-in and official environment file, then forwards exact generation", async () => {
    const f = fixture();
    const hooksPath = join(f.cwd, "hooks.json"), configPath = join(f.cwd, "private.json"), envFile = join(f.cwd, "session.env");
    const received: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk.toString();
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bindingToken: "a".repeat(64), additionalContext: `[factory-cc-session:${"a".repeat(64)}]` }));
    });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
    const options = { hooksPath, configPath, url: `http://127.0.0.1:${address.port}`, hookToken: "fixture-only-token", desktopLifecycle: true };
    installFactoryHooks(options);
    expect(readFileSync(hooksPath, "utf8")).toContain("--factory-cc-desktop-lifecycle");
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktopLifecycle).toBe(true);
    const invoke = async (event: Record<string, unknown>, binding?: string) => {
      const env = { ...process.env }; delete env.BRIDGE_FACTORY_LAUNCH_ID; delete env.BRIDGE_FACTORY_BINDING;
      if (binding !== undefined) env.BRIDGE_FACTORY_BINDING = binding;
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/factory-hook.ts"), "--factory-cc-hook-config", configPath, "--factory-cc-desktop-lifecycle"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
      const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => { child.once("error", reject); child.once("close", (code) => done({ code, stdout, stderr })); });
      child.stdin.end(JSON.stringify(event)); return result;
    };
    try {
      expect((await invoke(f.event())).code).toBe(1);
      expect(received).toHaveLength(0);
      expect((await invoke(f.event("SessionStart", { CLAUDE_ENV_FILE: envFile }))).code).toBe(0);
      expect(received[0]).toMatchObject({ desktopLifecycle: true, event: { session_id: "desktop-a" } });
      expect(received[0]).not.toHaveProperty("launchId");
      expect(readFileSync(envFile, "utf8")).toContain(`export BRIDGE_FACTORY_BINDING='${"a".repeat(64)}'`);
      expect((await invoke(f.event("SessionEnd"))).code).toBe(1);
      expect(received).toHaveLength(1);
      expect((await invoke(f.event("UserPromptSubmit"), "a".repeat(64))).code).toBe(0);
      expect(received[1]).toMatchObject({ bindingToken: "a".repeat(64) });
      expect(received[1]).not.toHaveProperty("desktopLifecycle");
      writeFileSync(configPath, JSON.stringify({ ...options, desktopLifecycle: false }));
      expect((await invoke(f.event("SessionStart", { CLAUDE_ENV_FILE: envFile }))).code).toBe(1);
      expect(received).toHaveLength(2);
    } finally {
      server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
