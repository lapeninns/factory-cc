import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCompletedHostCheckpoint, receiptDigest, recoverCompletedHostCheckpoint, type CompletedHostRecoveryContext } from "../../src/control/completed-host-recovery.js";
import type { NativeGenerationEvidence } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime, RuntimeHostCompletion } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { continuation, hostStart, recordingRuntime, restartConfig } from "../helpers/native-restart.js";
import { postMessages } from "../helpers/server.js";

const roots: string[] = [];
const apps: BridgeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(patch: Partial<SessionRecord> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "completed-host-recovery-")));
  roots.push(root);
  const cwd = join(root, "workspace"), configDir = join(root, "account"), sdkSessionId = randomUUID(), factorySessionId = randomUUID();
  mkdirSync(cwd);
  const checkpointDir = join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(checkpointDir, { recursive: true });
  const checkpointFile = join(checkpointDir, sdkSessionId + ".jsonl");
  const receipt: RuntimeHostCompletion = { toolUseId: "completed-write", toolName: "Script", input: { script: "write the owned document" }, content: "Document version 7 was written", isError: false, terminal: false };
  const checkpoint = [
    { sessionId: sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: receipt.toolUseId, name: "mcp__droid__Script", input: receipt.input }] } },
    { sessionId: sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.toolUseId, content: "Transport cancelled", is_error: true }] } },
  ];
  writeFileSync(checkpointFile, checkpoint.map(row => JSON.stringify(row)).join("\n") + "\n");
  const store = new SessionStore(join(root, "store"), false, 16);
  const record = store.create({ role: "orchestrator", model: "opus", toolNames: ["Script"], nativeGeneration: 0, claudeAccount: "team5" });
  store.update(record.bridgeSessionId, { factorySessionId, factoryCwd: cwd, sdkSessionId,
    historyMessageHashes: ["user", "assistant"], pendingToolIds: [receipt.toolUseId], notes: ["original history"] });
  store.recordHostCompletion(record.bridgeSessionId, receipt);
  store.update(record.bridgeSessionId, { cancelRequested: true });
  store.setState(record.bridgeSessionId, "CANCELLED");
  store.update(record.bridgeSessionId, patch);
  const evidence: NativeGenerationEvidence = { generation: 0, state: "cancelled", externalCleanupRequired: false, hostActionReservation: false,
    ownerAlive: false, supervisorAlive: false, cleanupVerified: true, checkpointMatches: true, bindingMatches: true,
    endedAt: "2026-11-10T02:19:53.000Z", endedBy: "session_update" };
  const account = { profile: "team5" as const, expectedEmail: "fixture@example.invalid", env: { CLAUDE_CONFIG_DIR: configDir }, weight: 1 };
  const runtime: BridgeRuntime = { kind: "fake", handle: vi.fn(), cancel: vi.fn(), deliverResults: vi.fn() };
  const ctx: CompletedHostRecoveryContext = { store, runtime, accounts: ["team5"], workspacePolicy: "factory-native", busy: () => false,
    inspect: vi.fn(async () => [evidence]), checkpoint: (row, receipts) => inspectCompletedHostCheckpoint([account], row, receipts), now: () => new Date("2026-11-10T05:00:00.000Z") };
  const body = { operationId: randomUUID(), bridgeSessionId: record.bridgeSessionId, factorySessionId, sdkSessionId, nativeGeneration: 0,
    expectedUpdatedAt: record.updatedAt, acknowledgeHistoricalDisconnect: true, checkpointSha256: createHash("sha256").update(readFileSync(checkpointFile)).digest("hex"),
    receiptsSha256: receiptDigest(record.hostCompletionReceipts ?? []) };
  return { root, cwd, store, record, receipt, checkpoint, checkpointFile, ctx, evidence, body };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (value: unknown) => value) as { code?: string; extra?: { reason?: string } } | undefined;
  return error?.extra?.reason ?? error?.code ?? "accepted";
}

describe("completed host checkpoint recovery", () => {
  it("uses the authenticated HTTP route and real settled native lease evidence", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "completed-recovery-http-")));
    roots.push(root);
    const helper = pathToFileURL(join(process.cwd(), "tests/helpers/native-restart.ts")).href;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(helper)}); process.stdout.write("\\n" + JSON.stringify(await m.runFirstController(process.argv[1])) + "\\n");`, root],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    const first = JSON.parse(output.trim().split("\n").at(-1)!) as { bridgeSessionId: string; account: string; token: string };
    const base = restartConfig(root);
    const configDir = join(root, "configured-account");
    const config = { ...base, subscriptionAccounts: base.subscriptionAccounts!.map(account => ({ ...account,
      env: { ...account.env, CLAUDE_CONFIG_DIR: configDir } })) };
    const runtime = recordingRuntime(), handle = runtime.handle;
    runtime.handle = async input => ({ ...await handle(input), reconciledHostOperationId: input.session.pendingHostRecovery?.operationId });
    const app = createBridgeApp(config, { info() {}, warn() {}, error() {} }, "", runtime);
    apps.push(app);
    await listen(app, config);
    const record = app.store.require(first.bridgeSessionId);
    const receipt = { toolUseId: "completed-write", toolName: "Script", input: { script: "write once" }, content: "written", isError: false, terminal: false };
    app.store.update(record.bridgeSessionId, { pendingToolIds: [receipt.toolUseId] });
    app.store.recordHostCompletion(record.bridgeSessionId, receipt);
    app.store.update(record.bridgeSessionId, { state: "CANCELLED", cancelRequested: true, hostEnded: undefined });
    const directory = join(configDir, "projects", record.factoryCwd!.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, record.sdkSessionId! + ".jsonl"), [
      { sessionId: record.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: receipt.toolUseId, name: "mcp__droid__Script", input: receipt.input }] } },
      { sessionId: record.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.toolUseId, content: "cancelled", is_error: true }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const body = { operationId: randomUUID(), bridgeSessionId: record.bridgeSessionId, factorySessionId: record.factorySessionId,
      sdkSessionId: record.sdkSessionId, nativeGeneration: record.nativeGeneration, expectedUpdatedAt: record.updatedAt,
      acknowledgeHistoricalDisconnect: true, dryRun: true };
    const post = (payload: object, token: string) => fetch(`${app.url}/internal/completed-host-recovery`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect((await post(body, "client")).status).toBe(401);
    const response = await post(body, "admin");
    const dry = await response.json() as Record<string, unknown>;
    expect({ status: response.status, ...dry }).toMatchObject({ status: 200, eligible: true, receiptCount: 1 });
    expect(record.state).toBe("CANCELLED");
    const applied = await post({ ...body, dryRun: false, checkpointSha256: dry.checkpointSha256, receiptsSha256: dry.receiptsSha256 }, "admin");
    expect(await applied.json()).toMatchObject({ recovered: true, nativeGeneration: 1 });
    expect(record.state).toBe("IDLE");
    const token = await hostStart(app, root);
    const resumed = await postMessages(app.url, "client", continuation(first.token, token, "Reconcile the completed action"));
    expect(resumed.status).toBe(200);
    expect(record.pendingHostRecovery).toBeUndefined();
    expect(record.completedHostRecoveries?.[0]?.reconciledAt).toEqual(expect.any(String));
  }, 60_000);

  it("provides evidence hashes in a read-only dry run and retains cancellation history on apply", async () => {
    const f = fixture();
    const before = structuredClone(f.record), bytes = readFileSync(f.checkpointFile);
    const { checkpointSha256: _checkpoint, receiptsSha256: _receipts, ...withoutHashes } = f.body;
    expect(await recoverCompletedHostCheckpoint(f.ctx, { ...withoutHashes, dryRun: true })).toMatchObject({ eligible: true, recovered: false,
      checkpointSha256: f.body.checkpointSha256, receiptsSha256: f.body.receiptsSha256, receiptCount: 1, nextGeneration: 1 });
    expect(f.record).toEqual(before);
    expect(await recoverCompletedHostCheckpoint(f.ctx, f.body)).toMatchObject({ recovered: true, nativeGeneration: 1 });
    expect(f.record).toMatchObject({ state: "IDLE", cancelRequested: false, endedToolIds: [], hostCompletionReceipts: [], sdkSessionId: f.body.sdkSessionId,
      pendingHostRecovery: { operationId: f.body.operationId }, completedHostRecoveries: [{ cancellationSource: "unknown-operator-attested",
        original: { cancelRequested: true, endedToolIds: [f.receipt.toolUseId], notes: ["original history"] }, receipts: [f.receipt] }] });
    expect(readFileSync(f.checkpointFile)).toEqual(bytes);
    expect(f.record.completedHostRecoveries?.[0]).not.toHaveProperty("cancelledAt");
    expect(f.ctx.runtime.handle).not.toHaveBeenCalled();
    expect(f.ctx.runtime.cancel).not.toHaveBeenCalled();
    expect(await recoverCompletedHostCheckpoint(f.ctx, f.body)).toMatchObject({ alreadyRecovered: true });
    f.store.update(f.record.bridgeSessionId, { state: "CANCELLED", cancelRequested: true });
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("recovery_no_longer_active");
  });

  it("requires historical attestation and always rejects recorded admin or host cancellations", async () => {
    const legacy = fixture();
    expect(await reason(recoverCompletedHostCheckpoint(legacy.ctx, { ...legacy.body, acknowledgeHistoricalDisconnect: false }))).toBe("disconnect_not_authorized");
    for (const source of ["admin", "host"] as const) {
      const f = fixture({ cancellation: { at: "2026-11-10T02:19:52Z", source } });
      expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("disconnect_not_authorized");
    }
    const known = fixture({ cancellation: { at: "2026-11-10T02:19:52Z", source: "client-disconnect" } });
    expect(await recoverCompletedHostCheckpoint(known.ctx, { ...known.body, acknowledgeHistoricalDisconnect: false })).toMatchObject({ recovered: true });
    expect(known.record.completedHostRecoveries?.[0]?.cancellationSource).toBe("client-disconnect");
    expect(known.record.completedHostRecoveries?.[0]).toMatchObject({ recordUpdatedAt: known.body.expectedUpdatedAt,
      cancelledAt: "2026-11-10T02:19:52Z", original: { cancellation: { at: "2026-11-10T02:19:52Z", source: "client-disconnect" } } });
  });

  it.each([
    [{ state: "WAITING_DROID_TOOL" }, "not_cancelled"],
    [{ cancelRequested: false }, "not_cancelled"],
    [{ pendingToolIds: ["unknown"] }, "receipt_set_incomplete"],
    [{ endedToolIds: [] }, "unresolved_tools"],
    [{ endedToolIds: ["completed-write", "missing"] }, "receipt_set_incomplete"],
    [{ hostCompletionReceipts: [] }, "receipt_set_incomplete"],
    [{ hostEnded: "interrupted" }, "session_ended"],
    [{ historyMessageHashes: [] }, "no_completed_turn"],
    [{ claudeAccount: "team9" }, "account_mismatch"],
  ] as Array<[Partial<SessionRecord>, string]>)("refuses incomplete state %j", async (patch, expected) => {
    const f = fixture(patch), before = structuredClone(f.record);
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe(expected);
    expect(f.record).toEqual(before);
  });

  it.each(["isError", "terminal"] as const)("refuses a receipt marked %s", async key => {
    const f = fixture();
    f.record.hostCompletionReceipts![0]![key] = true;
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("receipt_not_successful");
  });

  it("refuses malformed receipt blocks before preparing recovery context", async () => {
    const f = fixture();
    f.record.hostCompletionReceipts![0]!.content = [null] as unknown as RuntimeHostCompletion["content"];
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("receipt_not_successful");
  });

  it("does not collapse multiple original actions with identical names and arguments", async () => {
    const f = fixture();
    f.record.endedToolIds!.push("other-write");
    f.record.hostCompletionReceipts!.push({ ...f.receipt, toolUseId: "other-write" });
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("receipt_action_ambiguous");
  });

  it("refuses an oversized restoration context before changing the cancelled record", async () => {
    const f = fixture();
    f.record.hostCompletionReceipts![0]!.content = "large receipt".repeat(10_000);
    const before = structuredClone(f.record);
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("recovery_context_too_large");
    expect(f.record).toEqual(before);
  });

  it("checks every explicit identity and both evidence hashes", async () => {
    for (const [patch, expected] of [
      [{ factorySessionId: randomUUID() }, "factory_session_mismatch"],
      [{ sdkSessionId: randomUUID() }, "checkpoint_mismatch"],
      [{ nativeGeneration: 1 }, "generation_mismatch"],
      [{ expectedUpdatedAt: "2000-01-01T00:00:00Z" }, "cancellation_changed"],
      [{ checkpointSha256: "0".repeat(64) }, "checkpoint_digest_mismatch"],
      [{ receiptsSha256: "0".repeat(64) }, "receipt_digest_mismatch"],
    ] as Array<[Record<string, unknown>, string]>) {
      const f = fixture();
      expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...f.body, ...patch }))).toBe(expected);
    }
    const f = fixture();
    for (const patch of [{ checkpointPath: "/tmp/foreign" }, { operationId: "../escape" }, { nativeGeneration: -1 }, { checkpointSha256: undefined }]) {
      expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...f.body, ...patch }))).toBe("invalid_control_request");
    }
  });

  it.each([
    [{ ownerAlive: true }, "lease_owner_alive"],
    [{ supervisorAlive: true }, "lease_owner_alive"],
    [{ cleanupVerified: false }, "lease_cleanup_unproven"],
    [{ hostActionReservation: true }, "lease_cleanup_unproven"],
    [{ checkpointMatches: false }, "lease_checkpoint_mismatch"],
    [{ bindingMatches: false }, "lease_evidence_missing"],
    [{ endedBy: "phase_release" }, "lease_not_closed"],
  ] as Array<[Partial<NativeGenerationEvidence>, string]>)("requires settled exact native ownership %j", async (patch, expected) => {
    const f = fixture();
    Object.assign(f.evidence, patch);
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe(expected);
  });

  it("refuses a live callback, newer completed sibling and a concurrent state change", async () => {
    const active = fixture();
    active.ctx.runtime.pendingHostCalls = () => [active.receipt];
    expect(await reason(recoverCompletedHostCheckpoint(active.ctx, active.body))).toBe("session_active");
    const later = fixture();
    const sibling = later.store.create({ role: "orchestrator", model: "opus", toolNames: [] });
    later.store.update(sibling.bridgeSessionId, { state: "FAILED", factorySessionId: later.body.factorySessionId,
      createdAt: "2099-01-01T00:00:00Z", historyMessageHashes: ["later completed work"] });
    expect(await reason(recoverCompletedHostCheckpoint(later.ctx, later.body))).toBe("later_work_exists");
    const changing = fixture();
    changing.ctx.inspect = async () => {
      changing.store.update(changing.record.bridgeSessionId, { notes: ["changed while waiting"] });
      return [changing.evidence];
    };
    expect(await reason(recoverCompletedHostCheckpoint(changing.ctx, changing.body))).toMatch(/changed/);
  });

  it("refuses a checkpoint that grows during asynchronous lease inspection", async () => {
    const f = fixture();
    f.ctx.inspect = async () => {
      appendFileSync(f.checkpointFile, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "later" }] } }) + "\n");
      return [f.evidence];
    };
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("changed_during_recovery");
    expect(f.record.state).toBe("CANCELLED");
  });

  it("accepts repeated identical native snapshots but refuses conflicting reuse of their tool IDs", async () => {
    const f = fixture();
    appendFileSync(f.checkpointFile, readFileSync(f.checkpointFile));
    const { checkpointSha256: _hash, ...body } = f.body;
    expect(await recoverCompletedHostCheckpoint(f.ctx, { ...body, dryRun: true })).toMatchObject({ eligible: true });
    appendFileSync(f.checkpointFile, JSON.stringify({ sessionId: f.body.sdkSessionId, message: { role: "user", content: [{
      type: "tool_result", tool_use_id: f.receipt.toolUseId, content: "different result", is_error: true }] } }) + "\n");
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...body, dryRun: true }))).toBe("checkpoint_conflicting_result");
  });

  it("refuses later checkpoint tools outside the exact reconciled action set", async () => {
    const f = fixture();
    appendFileSync(f.checkpointFile, [
      { sessionId: f.body.sdkSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "later-unrecorded", name: "mcp__droid__Script", input: {} }] } },
      { sessionId: f.body.sdkSessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "later-unrecorded", content: "done" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const { checkpointSha256: _hash, ...body } = f.body;
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...body, dryRun: true }))).toBe("checkpoint_has_later_tools");
  });

  it("refuses tool results that have no matching native tool call", async () => {
    const f = fixture();
    appendFileSync(f.checkpointFile, JSON.stringify({ sessionId: f.body.sdkSessionId, message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "unknown-call", content: "unmatched" }] } }) + "\n");
    const { checkpointSha256: _hash, ...body } = f.body;
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...body, dryRun: true }))).toBe("checkpoint_has_unmatched_results");
  });

  it.each(["wrong-input", "wrong-tool", "unsettled", "wrong-session", "malformed"])("refuses unproven native checkpoint contents: %s", async kind => {
    const f = fixture();
    const rows = structuredClone(f.checkpoint);
    if (kind === "wrong-input") (rows[0]!.message.content[0] as { input?: unknown }).input = { script: "different operation" };
    if (kind === "wrong-tool") (rows[0]!.message.content[0] as { name?: string }).name = "mcp__droid__Other";
    if (kind === "unsettled") rows.pop();
    if (kind === "wrong-session") rows[0]!.sessionId = randomUUID();
    writeFileSync(f.checkpointFile, kind === "malformed" ? "{partial" : rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const { checkpointSha256: _hash, ...body } = f.body;
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, { ...body, dryRun: true }))).toMatch(/^checkpoint_/);
  });

  it("refuses symbolic links instead of reading an operator-selected checkpoint", async () => {
    const f = fixture(), bytes = readFileSync(f.checkpointFile), other = join(f.root, "other.jsonl");
    writeFileSync(other, bytes);
    rmSync(f.checkpointFile);
    symlinkSync(other, f.checkpointFile);
    expect(await reason(recoverCompletedHostCheckpoint(f.ctx, f.body))).toBe("checkpoint_file_unproven");
  });
});
