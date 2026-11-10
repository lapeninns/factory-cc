import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCompletedHostCheckpoint } from "../../src/control/completed-host-recovery.js";
import { persistedCooldowns, readUpstreamFailureEvidence, restoreUpstreamCheckpoint, verifyRetainedHostCheckpoint, type UpstreamRecoveryContext } from "../../src/control/upstream-recovery.js";
import { DesktopJobsRuntime, type NativeGenerationEvidence } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { recordingRuntime, restartConfig } from "../helpers/native-restart.js";

const roots: string[] = [];
const apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const failedAt = "2026-11-10T10:39:14.903Z", coolingAt = "2026-11-10T10:39:15.045Z", updatedAt = "2026-11-10T10:39:15.320Z";
const coolingUntil = "2026-11-10T13:10:01.045Z";

function fixture(patch: Partial<SessionRecord> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "upstream-recovery-")));
  roots.push(root);
  const cwd = join(root, "workspace"), configDir = join(root, "account"), logDir = join(root, "logs");
  mkdirSync(cwd); mkdirSync(logDir);
  const sdkSessionId = randomUUID(), factorySessionId = randomUUID();
  const project = join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const file = join(project, sdkSessionId + ".jsonl");
  writeFileSync(file, JSON.stringify({ sessionId: sdkSessionId, message: { role: "user", content: [{ type: "text", text: "Earlier completed work" }] } }) + "\n");
  const store = new SessionStore(join(root, "state"), false, 16);
  const record = store.create({ role: "orchestrator", model: "opus", toolNames: ["Script"], nativeGeneration: 5, claudeAccount: "team5" });
  store.update(record.bridgeSessionId, { state: "IDLE", factorySessionId, factoryCwd: cwd, historyMessageHashes: ["one", "two"],
    retryableRequestKind: "upstream", retryableRequestHash: "1".repeat(64), completedHostRecoveries: [{ operationId: "prior-recovery", at: "2026-11-10T08:00:00Z",
      recordUpdatedAt: "2026-11-10T02:00:00Z", sdkSessionId, fromGeneration: 2, toGeneration: 3, cancellationSource: "unknown-operator-attested",
      checkpointSha256: "0".repeat(64), receiptsSha256: "2".repeat(64), leaseEndedAt: "2026-11-10T02:00:01Z",
      original: { cancelRequested: true, endedToolIds: ["old-call"], notes: [] }, receipts: [], reconciledAt: "2026-11-10T08:00:10Z" }], ...patch });
  record.updatedAt = updatedAt;
  const failure = { at: failedAt, event: "sdk_session_failed", data: { sessionId: record.bridgeSessionId, sdkSessionId, nativeGeneration: 4,
    code: "rate_limit_error", status: 429, retryFromHistory: true, phase: "prompted" } };
  const cooling = { at: coolingAt, event: "claude_account_cooling", data: { sessionId: record.bridgeSessionId, account: "team5", seconds: 9046, usageLimit: true } };
  const logFile = join(logDir, "bridge.jsonl"); writeFileSync(logFile, [failure, cooling].map(row => JSON.stringify(row)).join("\n") + "\n");
  const lease: NativeGenerationEvidence = { generation: 4, state: "failed", bindingMatches: true, checkpointMatches: true,
    cleanupVerified: true, externalCleanupRequired: false, hostActionReservation: false, ownerAlive: false, supervisorAlive: false,
    endedBy: "session_update", endedAt: "2026-11-10T10:39:15.285Z" };
  const account = { profile: "team5" as const, expectedEmail: "fixture@example.invalid", env: { CLAUDE_CONFIG_DIR: configDir }, weight: 1 };
  const runtime: BridgeRuntime = { kind: "fake", handle: vi.fn(), cancel: vi.fn(), deliverResults: vi.fn() };
  const context: UpstreamRecoveryContext = { store, runtime, accounts: ["team5"], workspacePolicy: "factory-native", busy: () => false,
    inspect: vi.fn(async () => [lease]), checkpoint: row => inspectCompletedHostCheckpoint([account], row, []),
    evidence: (row, sdk, generation) => readUpstreamFailureEvidence(logDir, row, sdk, generation, store.list()),
    restoreCooldown: vi.fn(), now: () => new Date("2026-11-10T12:00:00Z") };
  const body = { operationId: randomUUID(), bridgeSessionId: record.bridgeSessionId, factorySessionId, account: "team5", sdkSessionId,
    nativeGeneration: 5, expectedUpdatedAt: updatedAt, checkpointSha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    evidenceSha256: context.evidence(record, sdkSessionId, 4).sha256 };
  return { root, record, store, context, body, lease, file, logFile, logDir, failure, cooling };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (value: unknown) => value) as { code?: string; extra?: { reason?: string } } | undefined;
  return error?.extra?.reason ?? error?.code ?? "accepted";
}

describe("operator restoration after a clean upstream retry", () => {
  it("exposes guarded dry-run and apply through the administrator HTTP route", async () => {
    const f = fixture(), base = restartConfig(f.root);
    vi.spyOn(DesktopJobsRuntime.prototype, "inspectNativeGenerations").mockResolvedValue([f.lease]);
    const config = { ...base, logDir: f.logDir, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
      env: { ...account.env, CLAUDE_CONFIG_DIR: join(f.root, "account") } })) };
    const app = createBridgeApp(config, { info() {}, warn() {}, error() {} }, "", recordingRuntime()); apps.push(app); await listen(app, config);
    const record = app.store.create({ role: "orchestrator", model: "opus", toolNames: [] });
    app.store.update(record.bridgeSessionId, { ...structuredClone(f.record), bridgeSessionId: record.bridgeSessionId });
    record.updatedAt = updatedAt;
    writeFileSync(f.logFile, [f.failure, f.cooling].map(row => JSON.stringify({ ...row, data: { ...row.data, sessionId: record.bridgeSessionId } })).join("\n") + "\n");
    const { checkpointSha256: _checkpoint, evidenceSha256: _evidence, ...identity } = f.body;
    const body = { ...identity, bridgeSessionId: record.bridgeSessionId, dryRun: true };
    const post = (payload: object, token: string) => fetch(`${app.url}/internal/upstream-checkpoint-recovery`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect((await post(body, "client")).status).toBe(401);
    const response = await post(body, "admin"), dry = await response.json() as Record<string, unknown>;
    expect({ status: response.status, ...dry }).toMatchObject({ status: 200, eligible: true, coolingUntil });
    expect(record.sdkSessionId).toBeUndefined();
    const applied = await post({ ...body, dryRun: false, checkpointSha256: dry.checkpointSha256, evidenceSha256: dry.evidenceSha256 }, "admin");
    expect(await applied.json()).toMatchObject({ recovered: true, nativeGeneration: 5 });
    expect(record.sdkSessionId).toBe(f.body.sdkSessionId);
  });

  it("restores the exact retained SDK reference at unused g5 and preserves cooldown and audit", async () => {
    const f = fixture(), before = structuredClone(f.record), bytes = readFileSync(f.file);
    const { checkpointSha256: _checkpoint, evidenceSha256: _evidence, ...draft } = f.body;
    expect(await restoreUpstreamCheckpoint(f.context, { ...draft, dryRun: true })).toMatchObject({ eligible: true, recovered: false,
      checkpointSha256: f.body.checkpointSha256, evidenceSha256: f.body.evidenceSha256, coolingUntil });
    expect(f.record).toEqual(before);
    expect(await restoreUpstreamCheckpoint(f.context, f.body)).toMatchObject({ recovered: true, nativeGeneration: 5, coolingUntil });
    expect(f.record).toMatchObject({ sdkSessionId: f.body.sdkSessionId, claudeAccount: "team5", nativeGeneration: 5,
      retryableRequestKind: "native-upstream", retainedCheckpoint: { sourceGeneration: 4, checkpointSha256: f.body.checkpointSha256, account: "team5", coolingUntil },
      accountCooldowns: { team5: coolingUntil }, upstreamCheckpointRecoveries: [{ before: { retryableRequestKind: "upstream" }, evidenceSha256: f.body.evidenceSha256 }] });
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(f.context.restoreCooldown).toHaveBeenCalledWith("team5", coolingUntil);
    expect(await restoreUpstreamCheckpoint(f.context, f.body)).toMatchObject({ alreadyRecovered: true });
    f.record.cancelRequested = true;
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("recovery_no_longer_active");
  });

  it.each([
    [{ cancelRequested: true }, "unresolved_or_ended_session"],
    [{ hostEnded: "interrupted" }, "unresolved_or_ended_session"],
    [{ endedToolIds: ["unresolved"] }, "unresolved_or_ended_session"],
    [{ sdkSessionId: "already-restored" }, "not_clean_upstream_retry"],
    [{ retryableRequestKind: "admission" }, "not_clean_upstream_retry"],
    [{ completedHostRecoveries: [] }, "checkpoint_audit_missing"],
  ] as Array<[Partial<SessionRecord>, string]>)("refuses unsupported record %j", async (patch, expected) => {
    const f = fixture(patch), before = structuredClone(f.record);
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe(expected);
    expect(f.record).toEqual(before);
  });

  it("rejects changed identity, current generation and expected version", async () => {
    const f = fixture();
    for (const [patch, expected] of [
      [{ account: "team1" }, "account_mismatch"], [{ sdkSessionId: randomUUID() }, "checkpoint_audit_missing"],
      [{ nativeGeneration: 6 }, "generation_mismatch"], [{ expectedUpdatedAt: "2000-01-01T00:00:00Z" }, "record_changed"],
      [{ checkpointSha256: "0".repeat(64) }, "checkpoint_digest_mismatch"], [{ evidenceSha256: "0".repeat(64) }, "upstream_evidence_changed"],
    ] as Array<[Record<string, unknown>, string]>) expect(await reason(restoreUpstreamCheckpoint(f.context, { ...f.body, ...patch }))).toBe(expected);
  });

  it("requires source g4 and refuses any g5 lease, unsettled owner or duplicate SDK lineage", async () => {
    for (const patch of [{ generation: 5 }, { ownerAlive: true }, { cleanupVerified: false }, { state: "idle" }, { checkpointMatches: false }]) {
      const f = fixture(); Object.assign(f.lease, patch);
      expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).not.toBe("accepted");
    }
    const f = fixture();
    const sibling = f.store.create({ role: "orchestrator", model: "opus", toolNames: [] });
    f.store.update(sibling.bridgeSessionId, { state: "FAILED", sdkSessionId: f.body.sdkSessionId });
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("duplicate_checkpoint_lineage");
  });

  it("uses the latest failure and never substitutes an older matching quota event", async () => {
    const f = fixture();
    appendFileSync(f.logFile, JSON.stringify({ ...f.failure, at: coolingAt, data: { ...f.failure.data, nativeGeneration: 5, code: "other_failure" } }) + "\n");
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("upstream_failure_unproven");
  });

  it("requires trusted cooling and well-formed logs", async () => {
    const f = fixture(); writeFileSync(f.logFile, JSON.stringify(f.failure) + "\n");
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("upstream_cooldown_unproven");
    writeFileSync(f.logFile, "{broken\n");
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("log_evidence_unavailable");
    rmSync(f.logFile); symlinkSync(f.file, f.logFile);
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toBe("log_evidence_unavailable");
  });

  it("uses the greatest observed account deadline across logs and persisted records", () => {
    const f = fixture();
    appendFileSync(f.logFile, JSON.stringify({ ...f.cooling, at: "2026-11-10T11:00:00Z", data: { ...f.cooling.data, seconds: 60 } }) + "\n");
    expect(persistedCooldowns(f.logDir, ["team5"], [f.record])).toEqual({ team5: coolingUntil });
    f.record.accountCooldowns = { team5: "2026-11-10T14:00:00Z" };
    expect(persistedCooldowns(f.logDir, ["team5"], [f.record])).toEqual({ team5: "2026-11-10T14:00:00Z" });
  });

  it.each(["record", "checkpoint", "log"])("refuses %s changes across lease inspection", async changed => {
    const f = fixture();
    f.context.inspect = async () => {
      if (changed === "record") f.store.update(f.record.bridgeSessionId, { notes: ["concurrent change"] });
      if (changed === "checkpoint") appendFileSync(f.file, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "later" }] } }) + "\n");
      if (changed === "log") appendFileSync(f.logFile, JSON.stringify({ ...f.cooling, at: "2026-11-10T11:00:00Z", data: { ...f.cooling.data, seconds: 20_000 } }) + "\n");
      return [f.lease];
    };
    expect(await reason(restoreUpstreamCheckpoint(f.context, f.body))).toMatch(/changed/);
    expect(f.record.sdkSessionId).toBeUndefined();
  });

  it("refuses partial native tool pairing without editing the checkpoint", async () => {
    const f = fixture();
    appendFileSync(f.file, JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "unresolved", name: "mcp__droid__Script", input: {} }] } }) + "\n");
    const { checkpointSha256: _hash, ...body } = f.body;
    expect(await reason(restoreUpstreamCheckpoint(f.context, { ...body, dryRun: true }))).toBe("checkpoint_has_pending_tools");
  });

  it("allows host-end fallback only for exact retained-checkpoint proof", async () => {
    const f = fixture(); await restoreUpstreamCheckpoint(f.context, f.body);
    expect(await verifyRetainedHostCheckpoint(f.context, f.record)).toBe(true);
    const plain = { ...f.record, retainedCheckpoint: undefined };
    expect(await verifyRetainedHostCheckpoint(f.context, plain)).toBe(false);
    expect(await verifyRetainedHostCheckpoint(f.context, { ...f.record, cancelRequested: true })).toBe(false);
    expect(await verifyRetainedHostCheckpoint(f.context, { ...f.record, sdkSessionId: randomUUID() })).toBe(false);
    f.context.checkpoint = () => "0".repeat(64);
    expect(await verifyRetainedHostCheckpoint(f.context, f.record)).toBe(false);
  });
});
