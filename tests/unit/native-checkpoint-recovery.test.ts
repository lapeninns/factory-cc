import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBroker } from "../../src/control/broker.js";
import { recoverNativeCheckpoint, type NativeCheckpointRecoveryContext } from "../../src/control/native-recovery.js";
import type { BridgeApp } from "../../src/http/app.js";
import type { NativeGenerationEvidence } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import { postMessages } from "../helpers/server.js";
import { CHECKPOINT, FACTORY_SESSION, continuation, hostStart, recordingRuntime, recover, startController } from "../helpers/native-restart.js";

const roots: string[] = [], apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "native-restart-"))); roots.push(root); return root; }

/** Run the first controller in its own Node process, so its lease owner identity really exits. */
function firstController(root: string): { bridgeSessionId: string; token: string; account?: string } {
  const helper = pathToFileURL(join(process.cwd(), "tests/helpers/native-restart.ts")).href;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const m = await import(${JSON.stringify(helper)}); process.stdout.write("\\n" + JSON.stringify(await m.runFirstController(process.argv[1])) + "\\n");`, root],
  { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}
function leases(root: string): Array<Record<string, unknown>> {
  return readdirSync(join(root, "leases", "jobs")).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(root, "leases", "jobs", name), "utf8")) as Record<string, unknown>)
    .sort((left, right) => String(left.bridgeSessionId).localeCompare(String(right.bridgeSessionId)));
}
async function secondController(root: string) {
  const runtime = recordingRuntime();
  const app = await startController(root, runtime); apps.push(app);
  return { app, runtime };
}

describe("native Workstream continuation after an orderly controller restart", () => {
  it("resumes the retained checkpoint under a new durable lease generation", async () => {
    const root = directory();
    const first = firstController(root);
    expect(leases(root)).toMatchObject([{ bridgeSessionId: `${first.bridgeSessionId}:g0`, state: "cancelled", sessionId: CHECKPOINT }]);
    const before = leases(root)[0];
    const { app, runtime } = await secondController(root);
    expect(app.store.require(first.bridgeSessionId)).toMatchObject({ state: "IDLE", nativeGeneration: 0, sdkSessionId: CHECKPOINT });

    const token = await hostStart(app, root);
    expect(app.store.require(first.bridgeSessionId).nativeGeneration).toBe(1);
    const resumed = await postMessages(app.url, "client", continuation(first.token, token));
    expect(resumed.status).toBe(200);
    expect(resumed.session).toBe(first.bridgeSessionId);
    expect(runtime.turns).toEqual([{ bridgeSessionId: first.bridgeSessionId, sdkSessionId: CHECKPOINT, nativeGeneration: 1,
      claudeAccount: first.account, recovery: undefined, messages: 3 }]);
    expect(app.store.list()).toHaveLength(1);
    expect(leases(root)).toMatchObject([before, { bridgeSessionId: `${first.bridgeSessionId}:g1`, state: "idle", sessionId: CHECKPOINT,
      subscriptionProfile: first.account }]);

    // A second fresh start in the same process keeps the generation it already holds.
    const again = await hostStart(app, root);
    expect(again).toBe(token);
    expect(app.store.require(first.bridgeSessionId).nativeGeneration).toBe(1);
  }, 60_000);

  it("refuses an inherited generation without running, failing or cold-importing", async () => {
    const root = directory();
    const first = firstController(root);
    const { app, runtime } = await secondController(root);
    const token = await hostStart(app, root);
    // Reproduce the defect: the continuation keeps the previous controller's generation.
    app.store.update(first.bridgeSessionId, { nativeGeneration: 0 });
    const inherited = await postMessages(app.url, "client", continuation(first.token, token));
    expect(inherited.status).toBe(409);
    expect(inherited.json).toMatchObject({ error: { type: "native_generation_refused", reason: "lease_binding_mismatch", checkpoint_retained: true } });
    expect(runtime.turns).toEqual([]);
    expect(app.store.list()).toHaveLength(1);
    expect(app.store.require(first.bridgeSessionId)).toMatchObject({ state: "IDLE", sdkSessionId: CHECKPOINT, nativeGeneration: 0,
      notes: expect.arrayContaining(["native-generation-refused:lease_binding_mismatch"]) });
    expect(leases(root)).toHaveLength(1);

    // The refused attempt left no process-local identity behind, so a correctly
    // advanced generation continues the same checkpoint.
    app.store.update(first.bridgeSessionId, { nativeGeneration: 2 });
    expect(await postMessages(app.url, "client", continuation(first.token, token))).toMatchObject({ status: 200, session: first.bridgeSessionId });
    expect(runtime.turns).toEqual([expect.objectContaining({ sdkSessionId: CHECKPOINT, nativeGeneration: 2, recovery: undefined })]);
  }, 60_000);

  it("recovers the already-failed pre-prompt continuation once, through the operator operation", async () => {
    const root = directory();
    const first = firstController(root);
    // The pre-fix controller: the inherited g0 was refused, the record failed,
    // and a cold import created a sibling that never completed a turn.
    const failedStore = new SessionStore(join(root, "bridge", "data", "sessions"), true, 16);
    failedStore.setState(first.bridgeSessionId, "FAILED");
    const sibling = failedStore.create({ role: "unknown", model: "opus", claudeAccount: first.account, nativeGeneration: 0, toolNames: ["Read"] });
    failedStore.update(sibling.bridgeSessionId, { factorySessionId: FACTORY_SESSION, factoryCwd: join(root, "workspace") });
    failedStore.setState(sibling.bridgeSessionId, "FAILED");
    const { app, runtime } = await secondController(root);
    const token = await hostStart(app, root);
    const failed = structuredClone(app.store.require(first.bridgeSessionId));
    expect(failed).toMatchObject({ state: "FAILED", nativeGeneration: 0 });

    const identity = { bridgeSessionId: first.bridgeSessionId, factorySessionId: FACTORY_SESSION, sdkSessionId: CHECKPOINT, nativeGeneration: 0 };
    for (const [patch, reason] of [[{ factorySessionId: randomUUID() }, "factory_session_mismatch"], [{ sdkSessionId: randomUUID() }, "checkpoint_mismatch"],
      [{ nativeGeneration: 1 }, "generation_mismatch"]] as const) {
      expect(await recover(app, { ...identity, ...patch })).toMatchObject({ status: 409, json: { error: { type: "native_recovery_refused", reason } } });
    }
    expect(await recover(app, { ...identity, dryRun: true })).toEqual({ status: 200, json: { ok: true, eligible: true, recovered: false,
      bridgeSessionId: first.bridgeSessionId, nativeGeneration: 0, nextGeneration: 1 } });
    expect(app.store.require(first.bridgeSessionId)).toEqual(failed);
    expect(await recover(app, identity)).toEqual({ status: 200, json: { ok: true, recovered: true, bridgeSessionId: first.bridgeSessionId, nativeGeneration: 1 } });
    const recovered = app.store.require(first.bridgeSessionId);
    expect(recovered).toMatchObject({ state: "IDLE", nativeGeneration: 1, sdkSessionId: CHECKPOINT,
      notes: [...failed.notes, "native-checkpoint-recovered:g0->g1"],
      checkpointRecoveries: [{ sdkSessionId: CHECKPOINT, fromGeneration: 0, toGeneration: 1, failedAt: failed.updatedAt }] });
    expect(app.store.require(sibling.bridgeSessionId).state).toBe("FAILED");
    expect(await recover(app, identity)).toMatchObject({ status: 200, json: { recovered: false, alreadyRecovered: true, nativeGeneration: 1 } });

    const resumed = await postMessages(app.url, "client", continuation(first.token, token));
    expect(resumed).toMatchObject({ status: 200, session: first.bridgeSessionId });
    expect(runtime.turns).toEqual([expect.objectContaining({ sdkSessionId: CHECKPOINT, nativeGeneration: 1, recovery: undefined })]);
    // A repeated call after later successful work changes nothing.
    const later = structuredClone(app.store.require(first.bridgeSessionId));
    expect(await recover(app, identity)).toMatchObject({ status: 200, json: { alreadyRecovered: true } });
    expect(app.store.require(first.bridgeSessionId)).toEqual(later);
    expect(leases(root).map(lease => [String(lease.bridgeSessionId).split(":").at(-1), lease.state])).toEqual([["g0", "cancelled"], ["g1", "idle"]]);
  }, 60_000);
});

function fakeRuntime(owned: string[] = []): BridgeRuntime & { ownsNativeSession(id: string): boolean } {
  return { kind: "fake", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}), pendingHostCalls: vi.fn(() => []),
    ownsNativeSession: (id: string) => owned.includes(id) };
}

describe("generation advance on a fresh authenticated Desktop start", () => {
  function fixture(patches: Partial<SessionRecord>[], runtime: BridgeRuntime = fakeRuntime()) {
    const cwd = directory();
    const store = new SessionStore(join(cwd, "state"), false, 16);
    const records = patches.map(patch => {
      const record = store.create({ role: "orchestrator", model: "opus", toolNames: ["Read"], nativeGeneration: 3 });
      return store.update(record.bridgeSessionId, { factorySessionId: "factory-one", factoryCwd: cwd, state: "IDLE",
        sdkSessionId: CHECKPOINT, claudeAccount: "team4", ...patch });
    });
    const broker = new ControlBroker(runtime, store, 1000, { desktopLifecycle: true, factoryNative: true });
    const start = (session = "factory-one") => broker.hostEvent({ eventId: randomUUID(), desktopLifecycle: true,
      event: { hook_event_name: "SessionStart", session_id: session, cwd } });
    const generation = (index = 0) => store.require(records[index]!.bridgeSessionId).nativeGeneration;
    return { cwd, store, broker, records, start, generation, runtime };
  }

  it("advances only resumable records of the same Factory session and workspace, keeping account and checkpoint", async () => {
    const f = fixture([{}, { state: "FAILED" }, { hostEnded: "interrupted" }, { cancelRequested: true }, { state: "WAITING_DROID_TOOL", pendingToolIds: ["call"] },
      { factorySessionId: "factory-two" }, { factoryCwd: "/another/workspace" }, { nativeGeneration: undefined }, { nativeGeneration: 1_000_000 }, { hostEnded: "resumable" }]);
    await f.start();
    expect(f.records.map((_, index) => f.generation(index))).toEqual([4, 3, 3, 3, 3, 3, 3, undefined, 1_000_000, 4]);
    expect(f.store.require(f.records[0]!.bridgeSessionId)).toMatchObject({ sdkSessionId: CHECKPOINT, claudeAccount: "team4", state: "IDLE" });
    await f.start("factory-two");
    expect(f.generation(5)).toBe(4);
  });

  it("keeps generations this process holds or that remain live, and needs the lease supervisor", async () => {
    const owned = fixture([{}]);
    (owned.runtime as ReturnType<typeof fakeRuntime>).ownsNativeSession = () => true;
    await owned.start();
    expect(owned.generation()).toBe(3);
    for (const patch of [{ isSessionUsable: () => true }, { protectedSessionIds: () => ["*"] }, { pendingHostCalls: () => [{ toolUseId: "t", toolName: "Read", input: {} }] }]) {
      const f = fixture([{}]);
      Object.assign(f.runtime, patch);
      if ("protectedSessionIds" in patch) f.runtime.protectedSessionIds = () => [f.records[0]!.bridgeSessionId];
      await f.start();
      expect(f.generation()).toBe(3);
    }
    const unsupervised = fixture([{}], { kind: "fake", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}) });
    await unsupervised.start();
    expect(unsupervised.generation()).toBe(3);
  });

  it("does not advance for an already-registered live host or a non-Desktop start", async () => {
    const f = fixture([{}]);
    const first = await f.start();
    expect(f.generation()).toBe(4);
    const token = randomBytes(32).toString("hex");
    await expect(f.broker.hostEvent({ eventId: randomUUID(), desktopLifecycle: true, bindingToken: token,
      event: { hook_event_name: "SessionStart", session_id: "factory-one", cwd: f.cwd } })).rejects.toMatchObject({ code: "stale_host_event" });
    expect(await f.broker.hostEvent({ eventId: randomUUID(), desktopLifecycle: true, bindingToken: first.bindingToken,
      event: { hook_event_name: "SessionStart", session_id: "factory-one", cwd: f.cwd } })).toMatchObject({ bindingToken: first.bindingToken });
    expect(f.generation()).toBe(4);
  });
});

describe("operator native checkpoint recovery predicates", () => {
  const ended = "2026-11-09T23:32:27.256640+00:00";
  function lease(patch: Partial<NativeGenerationEvidence> = {}): NativeGenerationEvidence {
    return { generation: 0, state: "cancelled", externalCleanupRequired: false, hostActionReservation: false, ownerAlive: false,
      supervisorAlive: false, cleanupVerified: true, checkpointMatches: true, bindingMatches: true, endedAt: ended, endedBy: "session_update", ...patch };
  }
  function fixture(patch: Partial<SessionRecord> = {}, evidence: NativeGenerationEvidence[] = [lease()], context: Partial<NativeCheckpointRecoveryContext> = {}) {
    const cwd = directory();
    const store = new SessionStore(join(cwd, "state"), false, 16);
    const record = store.create({ role: "orchestrator", model: "opus", toolNames: ["Read"], nativeGeneration: 0, claudeAccount: "team5" });
    store.update(record.bridgeSessionId, { factorySessionId: FACTORY_SESSION, factoryCwd: cwd, sdkSessionId: CHECKPOINT,
      historyMessageHashes: ["user", "assistant"], notes: ["factory-session-ended"] });
    store.setState(record.bridgeSessionId, "FAILED");
    store.update(record.bridgeSessionId, patch);
    // The store stamps its own write time; pin the failure time after the lease closed.
    store.require(record.bridgeSessionId).updatedAt = "2026-11-09T23:38:39.584Z";
    const inspect = vi.fn(async () => evidence);
    const runtime = fakeRuntime();
    const ctx: NativeCheckpointRecoveryContext = { store, runtime, accounts: ["team1", "team5"], workspacePolicy: "factory-native",
      busy: () => false, inspect, now: () => new Date("2026-11-10T08:00:00.000Z"), ...context };
    const body = { bridgeSessionId: record.bridgeSessionId, factorySessionId: FACTORY_SESSION, sdkSessionId: CHECKPOINT, nativeGeneration: 0 };
    return { store, record, inspect, ctx, body, cwd };
  }
  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(() => undefined, (value: unknown) => value) as { code?: string; extra?: { reason?: string } } | undefined;
    return error?.code === "native_recovery_refused" ? error.extra?.reason : error?.code ?? "accepted";
  }

  it("recovers with explicit identity, inspects the exact lease binding, and is idempotent", async () => {
    const f = fixture();
    expect(await recoverNativeCheckpoint(f.ctx, f.body)).toEqual({ ok: true, recovered: true, bridgeSessionId: f.record.bridgeSessionId, nativeGeneration: 1 });
    expect(f.inspect).toHaveBeenCalledWith({ factorySessionId: FACTORY_SESSION, bridgeSessionId: `${f.record.bridgeSessionId}:g0`, cwd: f.cwd,
      subscriptionProfile: "team5", workspacePolicy: "factory-native", sdkSessionId: CHECKPOINT });
    expect(f.store.require(f.record.bridgeSessionId)).toMatchObject({ state: "IDLE", nativeGeneration: 1, checkpointRecoveries: [{
      at: "2026-11-10T08:00:00.000Z", sdkSessionId: CHECKPOINT, fromGeneration: 0, toGeneration: 1, failedAt: "2026-11-09T23:38:39.584Z", leaseEndedAt: ended }] });
    f.inspect.mockClear();
    expect(await recoverNativeCheckpoint(f.ctx, f.body)).toMatchObject({ alreadyRecovered: true, nativeGeneration: 1 });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(await refusal(recoverNativeCheckpoint(f.ctx, { ...f.body, factorySessionId: randomUUID() }))).toBe("factory_session_mismatch");
  });

  it.each([
    [{ state: "IDLE" }, "not_failed"],
    [{ state: "CANCELLED" }, "not_failed"],
    [{ cancelRequested: true }, "session_ended"],
    [{ hostEnded: "terminal" }, "session_ended"],
    [{ pendingToolIds: ["call"] }, "unresolved_tools"],
    [{ endedToolIds: ["call"] }, "unresolved_tools"],
    [{ notes: ["bridge-restarted-during-generation"] }, "interrupted_generation"],
    [{ historyMessageHashes: undefined }, "no_completed_turn"],
    [{ claudeAccount: "team9" }, "account_mismatch"],
    [{ provider: "cursor" }, "unsupported_provider"],
    [{ factoryCwd: undefined }, "workspace_unknown"],
  ] as Array<[Partial<SessionRecord>, string]>)("refuses unsafe record %j as %s without inspecting leases", async (patch, reason) => {
    const f = fixture(patch);
    const before = structuredClone(f.store.require(f.record.bridgeSessionId));
    expect(await refusal(recoverNativeCheckpoint(f.ctx, f.body))).toBe(reason);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.store.require(f.record.bridgeSessionId)).toEqual(before);
  });

  it.each([
    [[], "lease_evidence_missing"],
    [[lease({ bindingMatches: false })], "lease_evidence_missing"],
    [[lease(), lease({ generation: 1, state: "cancelled" })], "newer_generation_exists"],
    [[lease({ state: "failed", endedBy: "phase_release" })], "lease_not_closed"],
    [[lease({ endedBy: "phase_release" })], "lease_not_closed"],
    [[lease({ state: "unknown", externalCleanupRequired: true })], "lease_not_closed"],
    [[lease({ cleanupVerified: false })], "lease_cleanup_unproven"],
    [[lease({ hostActionReservation: true })], "lease_cleanup_unproven"],
    [[lease({ ownerAlive: true })], "lease_owner_alive"],
    [[lease({ checkpointMatches: false })], "lease_checkpoint_mismatch"],
    [[lease({ checkpointMatches: null })], "lease_checkpoint_mismatch"],
    [[lease({ endedAt: "2026-11-09T23:40:00.000Z" })], "failure_precedes_lease_end"],
    [[lease({ endedAt: null })], "failure_precedes_lease_end"],
    [[lease(), lease({ bindingMatches: false, state: "unknown" })], "predecessor_unresolved"],
  ] as Array<[NativeGenerationEvidence[], string]>)("refuses lease evidence %j as %s", async (evidence, reason) => {
    const f = fixture({}, evidence);
    const before = structuredClone(f.store.require(f.record.bridgeSessionId));
    expect(await refusal(recoverNativeCheckpoint(f.ctx, f.body))).toBe(reason);
    expect(f.store.require(f.record.bridgeSessionId)).toEqual(before);
  });

  it("refuses active or uncertain sessions and newer or live work in the same Factory session", async () => {
    expect(await refusal(recoverNativeCheckpoint(fixture({}, [lease()], { busy: () => true }).ctx, fixture().body))).toBe("session_not_found");
    const busy = fixture();
    busy.ctx.busy = id => id === busy.record.bridgeSessionId;
    expect(await refusal(recoverNativeCheckpoint(busy.ctx, busy.body))).toBe("session_active");
    const owned = fixture();
    (owned.ctx.runtime as ReturnType<typeof fakeRuntime>).ownsNativeSession = () => true;
    expect(await refusal(recoverNativeCheckpoint(owned.ctx, owned.body))).toBe("session_active");

    const later = fixture();
    const newer = later.store.create({ role: "orchestrator", model: "opus", toolNames: ["Read"] });
    later.store.update(newer.bridgeSessionId, { factorySessionId: FACTORY_SESSION, createdAt: "2099-01-01T00:00:00.000Z",
      historyMessageHashes: ["completed"], state: "FAILED" });
    expect(await refusal(recoverNativeCheckpoint(later.ctx, later.body))).toBe("later_work_exists");
    const live = fixture();
    const older = live.store.create({ role: "orchestrator", model: "opus", toolNames: ["Read"] });
    live.store.update(older.bridgeSessionId, { factorySessionId: FACTORY_SESSION, createdAt: "2000-01-01T00:00:00.000Z",
      historyMessageHashes: ["completed"], state: "IDLE" });
    expect(await refusal(recoverNativeCheckpoint(live.ctx, live.body))).toBe("later_work_exists");
    live.ctx.busy = id => id === older.bridgeSessionId;
    expect(await refusal(recoverNativeCheckpoint(live.ctx, live.body))).toBe("sibling_active");

    const failedImport = fixture();
    const imported = failedImport.store.create({ role: "orchestrator", model: "opus", toolNames: ["Read"] });
    failedImport.store.update(imported.bridgeSessionId, { factorySessionId: FACTORY_SESSION, createdAt: "2099-01-01T00:00:00.000Z", state: "FAILED" });
    expect(await refusal(recoverNativeCheckpoint(failedImport.ctx, failedImport.body))).toBe("accepted");
  });

  it("does not apply a recovery when the record changes while leases are inspected, and supports dry runs", async () => {
    const f = fixture();
    f.inspect.mockImplementationOnce(async () => {
      f.store.update(f.record.bridgeSessionId, { notes: [...f.store.require(f.record.bridgeSessionId).notes, "concurrent"] });
      return [lease()];
    });
    expect(await refusal(recoverNativeCheckpoint(f.ctx, f.body))).toBe("changed_during_recovery");
    const dry = fixture();
    const before = structuredClone(dry.store.require(dry.record.bridgeSessionId));
    expect(await recoverNativeCheckpoint(dry.ctx, { ...dry.body, dryRun: true })).toMatchObject({ eligible: true, recovered: false, nextGeneration: 1 });
    expect(dry.store.require(dry.record.bridgeSessionId)).toEqual(before);
    for (const body of [{ ...dry.body, extra: true }, { ...dry.body, nativeGeneration: -1 }, { ...dry.body, nativeGeneration: "0" },
      { ...dry.body, sdkSessionId: "../escape" }, { ...dry.body, dryRun: "yes" }, { ...dry.body, bridgeSessionId: undefined }]) {
      expect(await refusal(recoverNativeCheckpoint(dry.ctx, body))).toBe("invalid_control_request");
    }
  });
});
