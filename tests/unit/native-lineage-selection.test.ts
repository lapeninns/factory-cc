import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRecoverySiblings, verifyRecoverySessionInactive } from "../../src/control/native-recovery.js";
import { inspectLineageCheckpoint } from "../../src/control/completed-host-recovery.js";
import { lineageCancellationSnapshot, selectNativeLineage, selectedLineageSources, verifySelectedLineage, type NativeLineageSelectionContext } from "../../src/control/native-lineage-selection.js";
import type { NativeGenerationEvidence } from "../../src/runtime/desktop-jobs.js";
import { hostResultDigest, lineageReconciliationContext } from "../../src/runtime/host-recovery.js";
import { SessionStore } from "../../src/sessions/store.js";
import type { SessionRecord } from "../../src/sessions/state.js";

const fault = vi.hoisted(() => ({ phase: "" as "" | "partial-temp" | "rename" | "cleanup" }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const journalTemporary = (path: unknown) => typeof path === "string" && /sessions\.jsonl\.[^/]+\.tmp$/.test(path);
  return { ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.phase === "partial-temp" && journalTemporary(args[0])) {
        fault.phase = "";
        const bytes = Buffer.from(args[1] as string | Uint8Array);
        actual.writeFileSync(args[0], bytes.subarray(0, bytes.length - 1), args[2]);
        throw Object.assign(new Error("injected partial temporary write"), { code: "ENOSPC" });
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fault.phase === "rename" && journalTemporary(args[0])) {
        fault.phase = "";
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      }
      return actual.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fault.phase === "cleanup" && journalTemporary(args[0])) {
        fault.phase = "";
        throw Object.assign(new Error("injected cleanup failure after rename"), { code: "EIO" });
      }
      return actual.rmSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => { fault.phase = ""; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
function fixture(persist = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-selection-"))); roots.push(root);
  const cwd = join(root, "workspace"), configDir = join(root, "account"); mkdirSync(cwd);
  const directory = join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(directory, { recursive: true });
  const store = new SessionStore(join(root, "sessions"), persist, 16), factory = randomUUID();
  const records = Array.from({ length: 3 }, (_, index) => {
    const record = store.create({ role: "orchestrator", model: "opus", claudeAccount: "team5", nativeGeneration: index ? 0 : 7, toolNames: ["Script"] });
    const sdk = randomUUID();
    store.update(record.bridgeSessionId, { state: "IDLE", sdkSessionId: sdk, factorySessionId: factory, factoryCwd: cwd,
      contextHash: "context", historyMessageHashes: ["user", "assistant"], requestMessageHashes: ["user"] });
    writeFileSync(join(directory, sdk + ".jsonl"), index === 2 ? [
      { sessionId: sdk, message: { role: "assistant", content: [{ type: "tool_use", id: "done", name: "mcp__droid__Script", input: { command: "fetch" } }] } },
      { sessionId: sdk, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "done", content: [{ type: "text", text: "fetched" }] }] } },
    ].map(row => JSON.stringify(row)).join("\n") : JSON.stringify({ sessionId: sdk, message: { role: "user", content: [] } }));
    if (index) {
      if (index === 2) store.update(record.bridgeSessionId, { state: "FAILED", endedToolIds: ["done"],
        hostCompletionReceipts: [{ toolUseId: "done", toolName: "Script", input: { command: "fetch" }, content: "fetched", isError: false }] });
      store.updateAtomic(record.bridgeSessionId, { lineageCancellation: lineageCancellationSnapshot(record) });
      store.update(record.bridgeSessionId, { state: "CANCELLED", cancelRequested: true, cancellation: { source: "admin", at: new Date().toISOString() } });
    }
    return record;
  });
  const owner = records[0]!;
  const account = { profile: "team5" as const, expectedEmail: "fixture@example.invalid", env: { CLAUDE_CONFIG_DIR: configDir }, weight: 1 };
  const lease: NativeGenerationEvidence = { generation: 0, state: "cancelled", bindingMatches: true, checkpointMatches: true,
    cleanupVerified: true, ownerAlive: false, supervisorAlive: false, hostActionReservation: false, externalCleanupRequired: false,
    endedAt: new Date().toISOString(), endedBy: "session_update" };
  const context: NativeLineageSelectionContext = { store, runtime: { kind: "fake", handle: vi.fn(), cancel: vi.fn(), deliverResults: vi.fn() },
    workspacePolicy: "factory-native", accounts: ["team5"], busy: () => false,
    lineageCheckpoint: record => inspectLineageCheckpoint([account], record), inspect: async request => [{ ...lease,
      generation: Number(request.bridgeSessionId.match(/:g(\d+)$/)![1]) }] };
  const identity = (record: SessionRecord) => ({ bridgeSessionId: record.bridgeSessionId, sdkSessionId: record.sdkSessionId!, account: "team5",
    nativeGeneration: record.nativeGeneration!, expectedUpdatedAt: record.updatedAt });
  const body = { operationId: randomUUID(), factorySessionId: factory, factoryCwd: cwd, selected: identity(owner), sources: records.slice(1).map(identity) };
  const approval = { reference: "test-only-explicit-user-approval", approvedAt: new Date().toISOString(), selectedBridgeSessionId: owner.bridgeSessionId,
    selectedSdkSessionId: owner.sdkSessionId!, sourceBridgeSessionIds: records.slice(1).map(record => record.bridgeSessionId) };
  return { root, directory, store, records, owner, context, body, approval, lease };
}
async function apply(f: ReturnType<typeof fixture>) {
  const dry = await selectNativeLineage(f.context, { ...f.body, dryRun: true });
  const body = { ...f.body, proofSha256: dry.proofSha256, approval: f.approval };
  return { result: await selectNativeLineage(f.context, body), body };
}
async function reason(work: Promise<unknown>) { return work.then(() => "accepted", error => error.extra?.reason ?? error.code); }

describe("explicit native lineage selection", () => {
  it("publishes one owner audit with every complete foreign outcome and preserved source records", async () => {
    const f = fixture(true), sources = structuredClone(f.records.slice(1));
    const { result, body } = await apply(f);
    expect(result.selected).toBe(true);
    expect(f.owner.pendingLineageReconciliation).toBe(f.body.operationId);
    expect(f.owner.nativeGeneration).toBe(8);
    expect(f.records.slice(1)).toEqual(sources);
    const audit = f.owner.nativeLineageSelection!;
    const outcome = audit.sources.flatMap(source => source.checkpoint.outcomes);
    expect(outcome).toEqual([{ toolUseId: "done", toolName: "mcp__droid__Script", input: { command: "fetch" }, content: [{ type: "text", text: "fetched" }], isError: false }]);
    expect(audit.sources.flatMap(source => source.checkpoint.settledToolResults)).toEqual([{ toolUseId: "done", resultSha256: hostResultDigest("fetched", false) }]);
    expect(lineageReconciliationContext(audit)).toContain("fetched");
    expect(selectedLineageSources(f.store.list(), f.owner).size).toBe(2);
    await expect(verifySelectedLineage(f.context, f.owner)).resolves.toBeUndefined();
    expect((await selectNativeLineage(f.context, body)).alreadySelected).toBe(true);
    const loaded = new SessionStore(join(f.root, "sessions"), true, 16);
    expect(loaded.require(f.owner.bridgeSessionId)).toEqual(f.owner);
    expect(f.context.runtime.cancel).not.toHaveBeenCalled();
  });

  it.each(["omitted", "version", "sdk", "approval", "busy", "owner", "pending", "snapshot", "context"])("refuses %s without mutation", async kind => {
    const f = fixture(), body = { ...f.body, approval: f.approval, proofSha256: "a".repeat(64) };
    if (kind === "omitted") body.sources = body.sources.slice(1);
    if (kind === "version") body.sources[0]!.expectedUpdatedAt = "2000-01-01T00:00:00Z";
    if (kind === "sdk") body.sources[0]!.sdkSessionId = randomUUID();
    if (kind === "approval") body.approval = { ...f.approval, selectedSdkSessionId: randomUUID() };
    if (kind === "busy") f.context.busy = () => true;
    if (kind === "owner") f.context.inspect = async () => [{ ...f.lease, ownerAlive: true }];
    if (kind === "pending") f.records[1]!.pendingToolIds = ["unknown"];
    if (kind === "snapshot") delete f.records[1]!.lineageCancellation;
    if (kind === "context") f.records[1]!.contextHash = "other";
    const before = structuredClone(f.store.list());
    expect(await reason(selectNativeLineage(f.context, body))).not.toBe("accepted");
    expect(f.store.list()).toEqual(before);
  });

  it("fences a newly created branch during asynchronous proof inspection", async () => {
    const f = fixture(); let called = false;
    const original = f.context.inspect;
    f.context.inspect = async request => {
      if (!called) { called = true; const source = f.store.create({ role: "orchestrator", model: "opus", toolNames: ["Script"] });
        f.store.update(source.bridgeSessionId, { factorySessionId: f.body.factorySessionId, factoryCwd: f.body.factoryCwd, sdkSessionId: randomUUID() }); }
      return original(request);
    };
    expect(await reason(selectNativeLineage(f.context, { ...f.body, dryRun: true }))).not.toBe("accepted");
    expect(f.owner.nativeLineageSelection).toBeUndefined();
  });

  it("coalesces concurrent identical apply requests into one publication", async () => {
    const f = fixture(), dry = await selectNativeLineage(f.context, { ...f.body, dryRun: true });
    const body = { ...f.body, approval: f.approval, proofSha256: dry.proofSha256 };
    const results = await Promise.all([selectNativeLineage(f.context, body), selectNativeLineage(f.context, body)]);
    expect(results.filter(result => result.selected)).toHaveLength(1);
    expect(results.filter(result => result.alreadySelected)).toHaveLength(1);
    expect(f.owner.nativeGeneration).toBe(8);
  });

  it.each(["file", "cancel", "generation"])("refuses a %s change while proving the operation", async kind => {
    const f = fixture(), original = f.context.inspect; let once = false;
    f.context.inspect = async request => {
      if (!once) {
        once = true;
        if (kind === "file") writeFileSync(join(f.directory, f.owner.sdkSessionId + ".jsonl"), "changed");
        if (kind === "cancel") f.owner.cancelRequested = true;
        if (kind === "generation") f.owner.nativeGeneration!++;
      }
      return original(request);
    };
    expect(await reason(selectNativeLineage(f.context, { ...f.body, dryRun: true }))).not.toBe("accepted");
    expect(f.owner.nativeLineageSelection).toBeUndefined();
  });

  it("revalidates the owner audit when consuming sibling exceptions", async () => {
    const f = fixture(); await apply(f);
    expect(() => verifyRecoverySessionInactive(f.context, f.owner)).not.toThrow();
    await expect(inspectRecoverySiblings(f.context, f.body.factorySessionId, f.records.slice(1), f.owner.bridgeSessionId)).resolves.toBeUndefined();
    writeFileSync(join(f.directory, f.records[1]!.sdkSessionId + ".jsonl"), "corrupt");
    await expect(inspectRecoverySiblings(f.context, f.body.factorySessionId, f.records.slice(1), f.owner.bridgeSessionId)).rejects.toThrow();
  });

  it("archives unused non-SDK failure records only with matching terminal lease evidence", async () => {
    const f = fixture();
    const failed = f.store.create({ role: "orchestrator", model: "opus", claudeAccount: "team5", nativeGeneration: 0, toolNames: ["Script"] });
    f.store.update(failed.bridgeSessionId, { state: "FAILED", factorySessionId: f.body.factorySessionId, factoryCwd: f.body.factoryCwd,
      contextHash: f.owner.contextHash });
    const original = f.context.inspect;
    f.context.inspect = async request => request.bridgeSessionId.startsWith(failed.bridgeSessionId) ? [] : original(request);
    expect(await reason(selectNativeLineage(f.context, { ...f.body, dryRun: true }))).toBe("lease_unsettled");
    f.context.inspect = original;
    await apply(f);
    expect(f.owner.nativeLineageSelection?.inactive.map(proof => proof.record.bridgeSessionId)).toEqual([failed.bridgeSessionId]);
    expect(selectedLineageSources(f.store.list(), f.owner).has(failed.bridgeSessionId)).toBe(true);
  });

  it("records older empty native branches but rejects unreconciled historical actions", async () => {
    const f = fixture(), sdk = randomUUID();
    const old = f.store.create({ role: "orchestrator", model: "opus", claudeAccount: "team5", nativeGeneration: 0, toolNames: ["Script"] });
    f.store.update(old.bridgeSessionId, { state: "FAILED", sdkSessionId: sdk, factorySessionId: f.body.factorySessionId,
      factoryCwd: f.body.factoryCwd, contextHash: f.owner.contextHash, createdAt: "2020-01-01T00:00:00Z" });
    const file = join(f.directory, sdk + ".jsonl");
    writeFileSync(file, JSON.stringify({ sessionId: sdk, message: { role: "user", content: [] } }));
    const inspect = f.context.inspect;
    f.context.inspect = async request => request.bridgeSessionId.startsWith(old.bridgeSessionId)
      ? [{ ...f.lease, endedAt: "2020-01-02T00:00:00Z" }] : inspect(request);
    const preview = await selectNativeLineage(f.context, { ...f.body, dryRun: true });
    expect(preview.historicalBridgeSessionIds).toEqual([old.bridgeSessionId]);
    writeFileSync(file, [
      { sessionId: sdk, message: { role: "assistant", content: [{ type: "tool_use", id: "old-action", name: "Bash", input: { command: "old-effect" } }] } },
      { sessionId: sdk, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "old-action", content: "done" }] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const unapproved = await selectNativeLineage(f.context, { ...f.body, dryRun: true });
    expect(unapproved).toMatchObject({ eligible: false, requiresHistoricalDisposition: true });
    expect(await reason(selectNativeLineage(f.context, { ...f.body, approval: f.approval, proofSha256: unapproved.proofSha256 })))
      .toBe("historical_outcome_unreconciled");
    const historicalDispositions = (unapproved.requiredHistoricalDispositions as Array<Record<string, unknown>>)
      .map(item => ({ ...item, approvalReference: "separate-history-baseline-approval", approvedAt: new Date().toISOString() }));
    const approved = { ...f.body, approval: f.approval, proofSha256: unapproved.proofSha256, historicalDispositions };
    for (const patch of [
      { checkpointSha256: "0".repeat(64) }, { outcomesSha256: "0".repeat(64) }, { sdkSessionId: randomUUID() },
      { selected: { ...f.body.selected, expectedUpdatedAt: "2000-01-01T00:00:00Z" } },
      { approvalReference: f.approval.reference },
    ]) {
      expect(await reason(selectNativeLineage(f.context, { ...approved,
        historicalDispositions: [{ ...historicalDispositions[0], ...patch }] }))).not.toBe("accepted");
    }
    expect(await reason(selectNativeLineage(f.context, { ...approved,
      historicalDispositions: [...historicalDispositions, { ...historicalDispositions[0], bridgeSessionId: randomUUID() }] }))).not.toBe("accepted");
    expect((await selectNativeLineage(f.context, approved)).selected).toBe(true);
    expect(f.owner.nativeLineageSelection?.historical[0]?.disposition?.approvalReference).toBe("separate-history-baseline-approval");
    expect(lineageReconciliationContext(f.owner.nativeLineageSelection!)).toContain("Archived historical effects remain in the workspace");
    expect((await selectNativeLineage(f.context, approved)).alreadySelected).toBe(true);
    expect(await reason(selectNativeLineage(f.context, { ...approved, historicalDispositions: [] }))).toBe("operation_identity_changed");
  });

  it("refuses complete foreign outcomes above the distinct 128KiB cap", async () => {
    const f = fixture(), source = f.records[1]!, sdk = source.sdkSessionId!;
    writeFileSync(join(f.directory, sdk + ".jsonl"), [
      { sessionId: sdk, message: { role: "assistant", content: [{ type: "tool_use", id: "large", name: "Bash", input: {} }] } },
      { sessionId: sdk, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "large", content: "x".repeat(128 * 1024) }] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    expect(await reason(selectNativeLineage(f.context, { ...f.body, dryRun: true }))).toBe("reconciliation_context_too_large");
    expect(f.owner.nativeLineageSelection).toBeUndefined();
  });

  it("keeps cancellation stronger than idempotency and rejects changed archived branches", async () => {
    const f = fixture(); const { body } = await apply(f);
    f.records[1]!.notes.push("changed");
    expect(() => selectedLineageSources(f.store.list(), f.owner)).toThrow();
    f.owner.cancelRequested = true;
    expect(await reason(selectNativeLineage(f.context, body))).toBe("operation_identity_changed");
  });

  it.each(["partial-temp", "rename", "cleanup"] as const)("keeps selection atomic and idempotent after %s failure", async phase => {
    const f = fixture(true), dry = await selectNativeLineage(f.context, { ...f.body, dryRun: true });
    const body = { ...f.body, approval: f.approval, proofSha256: dry.proofSha256 };
    const before = structuredClone(f.owner), sourceBefore = structuredClone(f.records.slice(1));
    fault.phase = phase;
    await expect(selectNativeLineage(f.context, body)).rejects.toThrow(/injected/);
    if (phase === "cleanup") expect(f.owner.pendingLineageReconciliation).toBe(f.body.operationId);
    else expect(f.owner).toEqual(before);
    const loaded = new SessionStore(join(f.root, "sessions"), true, 16);
    expect(loaded.require(f.owner.bridgeSessionId)).toEqual(f.owner);
    f.context.store = loaded;
    const repeated = await selectNativeLineage(f.context, body);
    expect(phase === "cleanup" ? repeated.alreadySelected : repeated.selected).toBe(true);
    expect(loaded.require(f.owner.bridgeSessionId).nativeLineageSelection?.sources.map(source => source.record)).toEqual(sourceBefore.sort((a, b) => a.bridgeSessionId.localeCompare(b.bridgeSessionId)));
    expect(loaded.require(f.owner.bridgeSessionId).nativeGeneration).toBe(8);
  });
});
