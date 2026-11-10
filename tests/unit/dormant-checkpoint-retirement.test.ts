import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectConsumedHostCheckpoint, inspectCompletedHostCheckpoint } from "../../src/control/completed-host-recovery.js";
import { retireDormantCheckpoint, type DormantRetirementContext } from "../../src/control/dormant-checkpoint-retirement.js";
import { readUpstreamFailureEvidence, restoreUpstreamCheckpoint, verifyRetainedHostCheckpoint, type UpstreamRecoveryContext } from "../../src/control/upstream-recovery.js";
import { inspectRecoverySiblings, verifyRecoverySessionInactive } from "../../src/control/native-recovery.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { DesktopJobsRuntime, type NativeGenerationEvidence } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import { recordingRuntime, restartConfig } from "../helpers/native-restart.js";

const roots: string[] = [], apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(persist = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dormant-retirement-"))); roots.push(root);
  const cwd = join(root, "workspace"), configDir = join(root, "account"); mkdirSync(cwd);
  const sdk = randomUUID(), factory = randomUUID();
  const directory = join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(directory, { recursive: true });
  const file = join(directory, sdk + ".jsonl");
  writeFileSync(file, JSON.stringify({ sessionId: sdk, message: { role: "user", content: [{ type: "text", text: "historical completed work" }] } }) + "\n");
  const store = new SessionStore(join(root, "sessions"), persist, 8);
  const old = store.create({ role: "orchestrator", model: "opus", claudeAccount: "team5", nativeGeneration: 1, toolNames: [] });
  store.update(old.bridgeSessionId, { state: "IDLE", factorySessionId: factory, factoryCwd: cwd, sdkSessionId: sdk, historyMessageHashes: ["old-history"],
    accountCooldowns: { team5: "2026-11-10T14:00:00Z" } });
  old.createdAt = "2026-11-08T08:44:00Z"; old.updatedAt = "2026-11-10T10:30:58.305Z";
  const target = store.create({ role: "orchestrator", model: "opus", claudeAccount: "team5", nativeGeneration: 1, toolNames: [] });
  store.update(target.bridgeSessionId, { state: "IDLE", factorySessionId: factory, factoryCwd: cwd, historyMessageHashes: ["different-history"],
    retryableRequestKind: "upstream", retryableRequestHash: "a".repeat(64) });
  target.createdAt = "2026-11-10T10:30:58.886Z"; target.updatedAt = "2026-11-10T11:47:01.835Z";
  const lease: NativeGenerationEvidence = { generation: 0, state: "cancelled", bindingMatches: true, checkpointMatches: true,
    cleanupVerified: true, externalCleanupRequired: false, hostActionReservation: false, ownerAlive: false, supervisorAlive: false,
    endedBy: "session_update", endedAt: "2026-11-09T00:15:36Z" };
  const account = { profile: "team5" as const, expectedEmail: "fixture@example.invalid", env: { CLAUDE_CONFIG_DIR: configDir }, weight: 1 };
  const runtime: BridgeRuntime = { kind: "fake", handle: vi.fn(), cancel: vi.fn(), deliverResults: vi.fn() };
  const context: DormantRetirementContext = { store, runtime, accounts: ["team5"], workspacePolicy: "factory-native", busy: () => false,
    inspect: vi.fn(async () => [lease]), retiredCheckpoint: record => inspectCompletedHostCheckpoint([account], record, []),
    now: () => new Date("2026-11-10T12:30:00Z") };
  const body = { operationId: randomUUID(), bridgeSessionId: old.bridgeSessionId, factorySessionId: factory, sdkSessionId: sdk,
    account: "team5", factoryCwd: cwd, nativeGeneration: 1, expectedUpdatedAt: old.updatedAt,
    targetBridgeSessionId: target.bridgeSessionId, targetExpectedUpdatedAt: target.updatedAt, confirmNonResumable: true,
    checkpointSha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    evidenceSha256: createHash("sha256").update(JSON.stringify([lease])).digest("hex") };
  if (persist) {
    const persistence = store as unknown as { flush(record: SessionRecord): void };
    persistence.flush(old); persistence.flush(target);
  }
  return { root, cwd, file, configDir, store, old, target, lease, context, body };
}
async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (value: unknown) => value) as { code?: string; extra?: { reason?: string } } | undefined;
  return error?.extra?.reason ?? error?.code ?? "accepted";
}

describe("explicit dormant checkpoint retirement", () => {
  it("audits and retires only the exact old record, preserving history, generation, SDK and cooldown", async () => {
    const f = fixture(), before = structuredClone(f.old), target = structuredClone(f.target), bytes = readFileSync(f.file);
    expect(() => verifyRecoverySessionInactive(f.context, f.target)).toThrow();
    expect(await retireDormantCheckpoint(f.context, { ...f.body, dryRun: true })).toMatchObject({ eligible: true, retired: false });
    expect(f.old).toEqual(before);
    expect(await retireDormantCheckpoint(f.context, f.body)).toMatchObject({ retired: true });
    expect(f.old).toMatchObject({ state: "CANCELLED", hostEnded: "interrupted", cancelRequested: true,
      sdkSessionId: before.sdkSessionId, nativeGeneration: before.nativeGeneration, historyMessageHashes: before.historyMessageHashes,
      accountCooldowns: before.accountCooldowns, dormantCheckpointRetirement: { before, targetBridgeSessionId: f.target.bridgeSessionId } });
    expect(f.target).toEqual(target); expect(readFileSync(f.file)).toEqual(bytes);
    expect(() => verifyRecoverySessionInactive(f.context, f.target)).not.toThrow();
    await expect(inspectRecoverySiblings(f.context, f.body.factorySessionId, [structuredClone(f.old)], f.target.bridgeSessionId)).resolves.toBeUndefined();
    expect(await retireDormantCheckpoint(f.context, f.body)).toMatchObject({ alreadyRetired: true });
    expect(f.context.runtime.cancel).not.toHaveBeenCalled();
  });

  it("makes concurrent identical retirement requests idempotent", async () => {
    const f = fixture();
    const results = await Promise.all([retireDormantCheckpoint(f.context, f.body), retireDormantCheckpoint(f.context, f.body)]);
    expect(results.filter(result => result.retired === true)).toHaveLength(1);
    expect(results.filter(result => result.alreadyRetired === true)).toHaveLength(1);
    expect(f.old.dormantCheckpointRetirement?.operationId).toBe(f.body.operationId);
  });

  it("detects a live record mutation while validating a cloned retired sibling", async () => {
    const f = fixture(); await retireDormantCheckpoint(f.context, f.body);
    const snapshot = structuredClone(f.old);
    f.context.inspect = async () => { f.old.notes.push("concurrent write"); return [f.lease]; };
    expect(await reason(inspectRecoverySiblings(f.context, f.body.factorySessionId, [snapshot], f.target.bridgeSessionId))).toBe("retirement_proof_changed");
  });

  it.each(["version", "account", "generation", "sdk"])("refuses unrestored target %s drift", async changed => {
    const f = fixture(); await retireDormantCheckpoint(f.context, f.body);
    if (changed === "version") f.target.updatedAt = "2026-11-10T12:31:00Z";
    if (changed === "account") f.target.claudeAccount = "team6";
    if (changed === "generation") f.target.nativeGeneration = 2;
    if (changed === "sdk") f.target.sdkSessionId = randomUUID();
    expect(await reason(inspectRecoverySiblings(f.context, f.body.factorySessionId, [f.old], f.target.bridgeSessionId))).toBe("retirement_proof_unavailable");
  });

  it("keeps the target binding through real restoration and later host-end proof, while rejecting retargeting", async () => {
    const f = fixture(); await retireDormantCheckpoint(f.context, f.body);
    const sdk = randomUUID(), logDir = join(f.root, "logs"); mkdirSync(logDir);
    writeFileSync(join(dirname(f.file), sdk + ".jsonl"), JSON.stringify({ sessionId: sdk, message: { role: "user", content: [] } }) + "\n");
    const targetLease = { ...f.lease, state: "failed", endedAt: "2026-11-10T11:47:01.700Z" };
    writeFileSync(join(logDir, "bridge.jsonl"), [
      { at: "2026-11-10T11:47:01.500Z", event: "sdk_session_failed", data: { sessionId: f.target.bridgeSessionId,
        sdkSessionId: sdk, nativeGeneration: 0, code: "rate_limit_error", status: 429, retryFromHistory: true } },
      { at: "2026-11-10T11:47:01.600Z", event: "claude_account_cooling", data: { sessionId: f.target.bridgeSessionId, account: "team5", seconds: 100 } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const accounts = [{ profile: "team5" as const, expectedEmail: "fixture@example.invalid", env: { CLAUDE_CONFIG_DIR: f.configDir }, weight: 1 }];
    const context: UpstreamRecoveryContext = { ...f.context, checkpoint: f.context.retiredCheckpoint,
      consumedCheckpoint: (record, receipts) => inspectConsumedHostCheckpoint(accounts, record, receipts),
      evidence: (record, checkpoint, generation) => readUpstreamFailureEvidence(logDir, record, checkpoint, generation, f.store.list()),
      inspect: async request => request.bridgeSessionId.startsWith(f.old.bridgeSessionId) ? [f.lease] : [targetLease], restoreCooldown: vi.fn() };
    const body = { operationId: randomUUID(), bridgeSessionId: f.target.bridgeSessionId, factorySessionId: f.body.factorySessionId,
      account: "team5", sdkSessionId: sdk, nativeGeneration: 1, expectedUpdatedAt: f.target.updatedAt };
    const dry = await restoreUpstreamCheckpoint(context, { ...body, dryRun: true });
    expect(await restoreUpstreamCheckpoint(context, { ...body, checkpointSha256: dry.checkpointSha256, evidenceSha256: dry.evidenceSha256 })).toMatchObject({ recovered: true });
    expect(await verifyRetainedHostCheckpoint(context, f.target)).toBe(true);
    f.store.update(f.target.bridgeSessionId, { nativeGeneration: 2, historyMessageHashes: ["ordinary", "later-progress"],
      retainedCheckpoint: { ...f.target.retainedCheckpoint!, sourceGeneration: 1 } });
    targetLease.generation = 1;
    expect(await verifyRetainedHostCheckpoint(context, f.target)).toBe(true);
    const good = structuredClone(f.target);
    for (const change of ["sdk", "account", "rollback", "duplicate-anchor"] as const) {
      Object.assign(f.target, structuredClone(good));
      if (change === "sdk") f.target.sdkSessionId = randomUUID();
      if (change === "account") f.target.claudeAccount = "team6";
      if (change === "rollback") f.target.nativeGeneration = 0;
      if (change === "duplicate-anchor") f.target.upstreamCheckpointRecoveries!.push(structuredClone(f.target.upstreamCheckpointRecoveries![0]!));
      expect(await reason(inspectRecoverySiblings(context, f.body.factorySessionId, [f.old], f.target.bridgeSessionId))).toBe("retirement_proof_unavailable");
    }
  });

  it("does not let normal cancellation or an unrelated target substitute for the retirement audit", async () => {
    const f = fixture();
    f.old.state = "CANCELLED"; f.old.cancelRequested = true;
    expect(await reason(inspectRecoverySiblings(f.context, f.body.factorySessionId, [f.old], f.target.bridgeSessionId))).toBe("sibling_lease_evidence_unproven");
    f.old.state = "IDLE"; f.old.cancelRequested = false;
    await retireDormantCheckpoint(f.context, f.body);
    expect(await reason(inspectRecoverySiblings(f.context, f.body.factorySessionId, [f.old], "different-target"))).toBe("retirement_proof_unavailable");
  });

  it.each([
    { confirmNonResumable: false }, { sdkSessionId: "wrong-sdk" }, { account: "team6" }, { factoryCwd: "/different" },
    { nativeGeneration: 2 }, { expectedUpdatedAt: "2026-11-10T10:30:59Z" }, { targetExpectedUpdatedAt: "2026-11-10T11:47:02Z" },
    { checkpointSha256: "0".repeat(64) }, { evidenceSha256: "0".repeat(64) }, { arbitraryPath: "/tmp/file" },
  ])("refuses changed request identity %j", async patch => {
    const f = fixture(), before = structuredClone(f.old);
    expect(await reason(retireDormantCheckpoint(f.context, { ...f.body, ...patch }))).not.toBe("accepted");
    expect(f.old).toEqual(before);
  });

  it.each([
    { pendingToolIds: ["unresolved"] }, { endedToolIds: ["unresolved"] }, { cancelRequested: true },
    { hostEnded: "resumable" }, { state: "GENERATING" }, { pendingHostRecovery: { operationId: "pending" } },
    { hostCompletionReceipts: [{ toolUseId: "done", toolName: "Script", input: {}, content: "done" }] },
  ] as Partial<SessionRecord>[])("refuses unresolved or changed old state %j", async patch => {
    const f = fixture(); Object.assign(f.old, patch);
    const before = structuredClone(f.old);
    expect(await reason(retireDormantCheckpoint(f.context, f.body))).not.toBe("accepted");
    expect(f.old).toEqual(before);
  });

  it.each(["busy", "protected", "owned", "callback"])("refuses %s runtime work", async kind => {
    const f = fixture();
    if (kind === "busy") f.context.busy = () => true;
    if (kind === "protected") f.context.runtime.protectedSessionIds = () => [f.old.bridgeSessionId];
    if (kind === "owned") f.context.runtime.ownsNativeSession = () => true;
    if (kind === "callback") f.context.runtime.pendingHostCalls = () => [{ toolUseId: "pending", toolName: "Script", input: {} }];
    expect(await reason(retireDormantCheckpoint(f.context, f.body))).toBe("session_active");
    expect(f.old.state).toBe("IDLE");
  });

  it.each(["current-generation", "newer-generation", "mismatched-sdk", "binding", "owner", "cleanup", "reservation", "active-lease", "missing"])(
    "refuses unproven %s lineage", async kind => {
      const f = fixture();
      if (kind === "current-generation") f.lease.generation = 1;
      if (kind === "newer-generation") f.lease.generation = 2;
      if (kind === "mismatched-sdk") f.lease.checkpointMatches = false;
      if (kind === "binding") f.lease.bindingMatches = false;
      if (kind === "owner") f.lease.ownerAlive = true;
      if (kind === "cleanup") f.lease.cleanupVerified = false;
      if (kind === "reservation") f.lease.hostActionReservation = true;
      if (kind === "active-lease") f.lease.state = "running";
      if (kind === "missing") f.context.inspect = async () => [];
      expect(await reason(retireDormantCheckpoint(f.context, { ...f.body, evidenceSha256: undefined, dryRun: true }))).not.toBe("accepted");
      expect(f.old.state).toBe("IDLE");
    });

  it.each(["old-record", "target", "checkpoint", "lease"])("refuses %s changes across awaits", async change => {
    const f = fixture(); let calls = 0;
    f.context.inspect = async () => {
      calls++;
      if (calls === 1) {
        if (change === "old-record") f.old.notes.push("concurrent modification");
        if (change === "target") f.target.notes.push("target changed");
        if (change === "checkpoint") appendFileSync(f.file, JSON.stringify({ message: { role: "user", content: [] } }) + "\n");
      } else if (change === "lease") f.lease.endedAt = "2026-11-09T00:15:37Z";
      return [structuredClone(f.lease)];
    };
    expect(await reason(retireDormantCheckpoint(f.context, { ...f.body, evidenceSha256: undefined, dryRun: true }))).not.toBe("accepted");
    expect(f.old.state).toBe("IDLE");
  });

  it("rolls back a persistence failure and keeps a single complete audit after retry", async () => {
    const f = fixture(true), before = structuredClone(f.old);
    const persistence = f.store as unknown as { flush(record: SessionRecord): void };
    vi.spyOn(persistence, "flush").mockImplementationOnce(() => { throw new Error("synthetic flush failure"); });
    await expect(retireDormantCheckpoint(f.context, f.body)).rejects.toThrow("synthetic flush failure");
    expect(f.old).toEqual(before);
    await retireDormantCheckpoint(f.context, f.body);
    expect(f.old.dormantCheckpointRetirement?.before).toEqual(before);
    expect(await reason(retireDormantCheckpoint(f.context, { ...f.body, operationId: "different" }))).toBe("operation_identity_mismatch");
  });

  it.each(["record", "checkpoint", "lease"])("rechecks archived %s proof when recovering the intended target", async change => {
    const f = fixture(); await retireDormantCheckpoint(f.context, f.body);
    if (change === "record") f.old.historyMessageHashes = ["changed"];
    if (change === "checkpoint") appendFileSync(f.file, JSON.stringify({ message: { role: "user", content: [] } }) + "\n");
    if (change === "lease") f.lease.ownerAlive = true;
    expect(await reason(inspectRecoverySiblings(f.context, f.body.factorySessionId, [structuredClone(f.old)], f.target.bridgeSessionId))).not.toBe("accepted");
  });

  it.each(["snapshot", "compact"])("preserves committed retirement after %s fails and retries without a duplicate audit", async phase => {
    const f = fixture(true);
    if (phase === "compact") {
      const internals = f.store as unknown as { writes: number; compact(): void };
      internals.writes = 255;
      vi.spyOn(internals, "compact").mockImplementationOnce(() => { throw new Error("post-append compact failure"); });
    } else vi.spyOn(f.store, "snapshot").mockImplementationOnce(() => { throw new Error("post-append snapshot failure"); });
    await expect(retireDormantCheckpoint(f.context, f.body)).rejects.toThrow("post-append");
    expect(f.old.state).toBe("CANCELLED");
    const loaded = new SessionStore(join(f.root, "sessions"), true, 8);
    expect(loaded.require(f.old.bridgeSessionId)).toEqual(f.old);
    f.context.store = loaded;
    expect(await retireDormantCheckpoint(f.context, f.body)).toMatchObject({ alreadyRetired: true });
    expect(loaded.require(f.old.bridgeSessionId).notes.filter(note => note.startsWith("dormant-checkpoint-retired:"))).toHaveLength(1);
  });

  it("exposes the operation only through the administrator route", async () => {
    const f = fixture(), base = restartConfig(f.root);
    vi.spyOn(DesktopJobsRuntime.prototype, "inspectNativeGenerations").mockResolvedValue([f.lease]);
    const config = { ...base, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
      env: { ...account.env, CLAUDE_CONFIG_DIR: f.configDir } })) };
    const app = createBridgeApp(config, { info() {}, warn() {}, error() {} }, "", recordingRuntime()); apps.push(app); await listen(app, config);
    const old = app.store.create({ role: "orchestrator", model: "opus", toolNames: [] }), target = app.store.create({ role: "orchestrator", model: "opus", toolNames: [] });
    app.store.update(old.bridgeSessionId, { ...structuredClone(f.old), bridgeSessionId: old.bridgeSessionId }); old.updatedAt = f.old.updatedAt;
    app.store.update(target.bridgeSessionId, { ...structuredClone(f.target), bridgeSessionId: target.bridgeSessionId }); target.updatedAt = f.target.updatedAt;
    const body = { ...f.body, bridgeSessionId: old.bridgeSessionId, targetBridgeSessionId: target.bridgeSessionId };
    const post = (token: string, dryRun: boolean) => fetch(`${app.url}/internal/dormant-checkpoint-retirement`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, dryRun }) });
    expect((await post("client", true)).status).toBe(401);
    expect(await (await post("admin", true)).json()).toMatchObject({ eligible: true });
    expect(await (await post("admin", false)).json()).toMatchObject({ retired: true });
    expect(old.state).toBe("CANCELLED"); expect(target.state).toBe("IDLE");
  });
});
