import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBroker } from "../../src/control/broker.js";
import { SessionStore } from "../../src/sessions/store.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { MessagesRequest, SessionState } from "../../src/types.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(patches: Partial<SessionRecord>[] = [{}], options: { desktopLifecycle?: boolean; restoreIdleDesktopBindings?: boolean } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "desktop-recovery-"))); directories.push(cwd);
  const directory = join(cwd, "private-state");
  const persisted = new SessionStore(directory, true, 16);
  const records = patches.map(patch => {
    const record = persisted.create({ role: "orchestrator", model: "claude-opus-5-5", toolNames: ["Execute"] });
    return persisted.update(record.bridgeSessionId, { factorySessionId: "existing-workstream", factoryCwd: cwd,
      state: "IDLE", cancelRequested: false, notes: [], pendingToolIds: [], ...patch });
  });
  // Reload from disk, like the newly deployed controller process.
  const store = new SessionStore(directory, true, 16);
  const runtime: BridgeRuntime = { kind: "sdk", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}),
    pendingHostCalls: vi.fn(() => []), endHostSession: vi.fn(async () => ({ resumable: false })) };
  const broker = new ControlBroker(runtime, store, 1000, { desktopLifecycle: true, restoreIdleDesktopBindings: true, ...options });
  const token = randomBytes(32).toString("hex");
  const event = (name = "UserPromptSubmit", extra: Record<string, unknown> = {}) => ({ hook_event_name: name,
    session_id: "existing-workstream", cwd, permission_mode: "spec", ...extra });
  const send = (name = "UserPromptSubmit", extra: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => broker.hostEvent({
    eventId: randomUUID(), event: event(name, extra), bindingToken: token, ...envelope,
  });
  return { cwd, store, broker, runtime, records, token, event, send };
}

describe("explicit idle Desktop binding recovery", () => {
  it("requires Desktop lifecycle and explicit recovery opt-in", async () => {
    const f = fixture([{}], { restoreIdleDesktopBindings: false });
    await expect(f.send()).rejects.toMatchObject({ code: "host_not_registered" });
    expect(() => new ControlBroker(f.runtime, f.store, 1000, { restoreIdleDesktopBindings: true })).toThrow(/Desktop lifecycle/);
  });

  it("restores the exact retained token only after an authenticated user-turn hook", async () => {
    const f = fixture([{ sdkSessionId: "safe-idle-checkpoint", usage: { input_tokens: 20, output_tokens: 5, estimated: false } }, { state: "FAILED" }]);
    const request: MessagesRequest = { model: "claude-opus-5-5", max_tokens: 16,
      messages: [{ role: "user", content: `[factory-cc-session:${f.token}] Continue` }] };
    expect(() => f.broker.prepareRequest(request, f.cwd)).toThrowError(expect.objectContaining({ code: "stale_host_binding" }));
    expect(await f.send()).toEqual({ ok: true, additionalContext: `[factory-cc-session:${f.token}]` });
    expect(f.broker.prepareRequest(request, f.cwd).binding).toBe(f.token);
    expect(f.broker.hostIdentity(f.token)).toEqual({ sessionId: "existing-workstream", cwd: f.cwd, desktopLifecycle: true, launchId: undefined });
    for (const record of f.records) {
      expect(f.broker.hasLiveHost(record.bridgeSessionId)).toBe(true);
      expect(f.broker.factoryPermissionMode(record.bridgeSessionId)).toBe("spec");
    }
    expect(f.broker.describe()).toMatchObject({ restoredDesktopBindings: 1, activeHostSessions: 1, boundNativeSessions: 2 });
    await f.send();
    expect(f.broker.describe().restoredDesktopBindings).toBe(1);
    expect(f.runtime.handle).not.toHaveBeenCalled();
    expect(f.runtime.cancel).not.toHaveBeenCalled();
  });

  it.each(["PreToolUse", "PostToolUse", "Notification", "SessionEnd", "Stop"])("does not recover from %s", async name => {
    const f = fixture();
    await expect(f.send(name)).rejects.toMatchObject({ code: "host_not_registered" });
    expect(f.broker.hostIdentity(f.token)).toBeUndefined();
  });

  it("does not widen SessionStart or accept unknown markers as authority", async () => {
    const f = fixture();
    await expect(f.send("SessionStart", {}, { desktopLifecycle: true })).rejects.toMatchObject({ code: "stale_host_event" });
    expect(f.broker.describe()).toMatchObject({ restoredDesktopBindings: 0, activeHostSessions: 0 });
  });

  it.each([undefined, "", "old-token", "A".repeat(64), 12])("refuses a malformed or absent retained token: %j", async bindingToken => {
    const f = fixture();
    await expect(f.send("UserPromptSubmit", {}, { bindingToken })).rejects.toMatchObject({ code: "host_not_registered" });
  });

  it("requires persisted records for the exact Factory session and canonical workspace", async () => {
    for (const patches of [[], [{ factorySessionId: "another-workstream" }], [{ factoryCwd: "/another/workspace" }]]) {
      const f = fixture(patches);
      await expect(f.send()).rejects.toMatchObject({ code: "host_not_registered" });
    }
    const f = fixture();
    const other = join(f.cwd, "other"); mkdirSync(other);
    await expect(f.send("UserPromptSubmit", { cwd: other })).rejects.toMatchObject({ code: "host_not_registered" });
    await expect(f.send("UserPromptSubmit", {}, { launchId: "wrapper-launch" })).rejects.toMatchObject({ code: "host_not_registered" });
  });

  it("accepts a still-valid alias for the same canonical directory", async () => {
    const f = fixture();
    const alias = join(f.cwd, "alias"); symlinkSync(f.cwd, alias);
    expect(await f.send("UserPromptSubmit", { cwd: alias })).toMatchObject({ ok: true });
    expect(f.broker.hostIdentity(f.token)?.cwd).toBe(f.cwd);
  });

  it.each(["NEW", "GENERATING", "RESUMING", "WAITING_DROID_TOOL", "CANCELLED"] as SessionState[])("rejects persisted %s work, including states normalized at reload", async state => {
    const f = fixture([{ state }]);
    await expect(f.send()).rejects.toMatchObject({ code: "host_not_registered" });
    expect(f.broker.hostIdentity(f.token)).toBeUndefined();
  });

  it.each([
    { pendingToolIds: ["pending"] },
    { endedToolIds: ["previously-pending"] },
    { cancelRequested: true },
    { hostEnded: "resumable" },
    { hostEnded: "terminal" },
    { hostEnded: "interrupted" },
    { state: "FAILED", sdkSessionId: "failed-native-checkpoint" },
    { sdkSessionId: "" },
    { sdkSessionId: null as unknown as string },
    { state: "FAILED", usage: { input_tokens: 1, output_tokens: 0, estimated: false } },
    { notes: ["request-timeout-interrupted"] },
  ] satisfies Partial<SessionRecord>[])("rejects any unsafe matching record: %j", async unsafe => {
    const f = fixture([{}, unsafe]);
    await expect(f.send()).rejects.toMatchObject({ code: "host_not_registered" });
    expect(f.broker.describe().restoredDesktopBindings).toBe(0);
  });

  it("rejects a conflicting workspace among records of the same Factory session", async () => {
    const f = fixture([{}, { factoryCwd: "/another/workspace" }]);
    await expect(f.send()).rejects.toMatchObject({ code: "host_not_registered" });
  });

  it("does not replace an existing binding or borrow another host's token", async () => {
    const f = fixture();
    const another = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", { session_id: "another-host" }), desktopLifecycle: true });
    await expect(f.send("UserPromptSubmit", {}, { bindingToken: another.bindingToken })).rejects.toMatchObject({ code: "host_not_registered" });
    const own = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart"), desktopLifecycle: true });
    await expect(f.send()).rejects.toMatchObject({ code: "stale_host_event" });
    expect(f.broker.hostIdentity(own.bindingToken as string)?.sessionId).toBe("existing-workstream");
    expect(f.broker.describe().restoredDesktopBindings).toBe(0);
  });

  it("does not resurrect a recovered host after its authenticated end", async () => {
    const f = fixture();
    await f.send();
    await f.send("SessionEnd");
    expect(await f.send()).not.toHaveProperty("additionalContext");
    expect(f.broker.hostIdentity(f.token)).toBeUndefined();
    expect(f.broker.describe().restoredDesktopBindings).toBe(1);
  });

  it("refuses in-memory callbacks and outstanding permission requests", async () => {
    const pending = fixture();
    vi.mocked(pending.runtime.pendingHostCalls!).mockReturnValue([{ toolUseId: "live-call", toolName: "Execute", input: { command: "fixture" } }]);
    await expect(pending.send()).rejects.toMatchObject({ code: "host_not_registered" });
    const approval = fixture();
    const abort = new AbortController();
    const response = approval.broker.requestApproval({ bridgeSessionId: approval.records[0]!.bridgeSessionId, toolName: "Execute", input: {}, signal: abort.signal });
    await expect(approval.send()).rejects.toMatchObject({ code: "host_not_registered" });
    abort.abort(); await response;
  });
});
