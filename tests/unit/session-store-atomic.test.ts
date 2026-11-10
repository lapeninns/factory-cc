import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/sessions/store.js";
import { restoreUpstreamCheckpoint, type UpstreamRecoveryContext } from "../../src/control/upstream-recovery.js";
import { receiptDigest } from "../../src/control/completed-host-recovery.js";

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

const directories: string[] = [];
afterEach(() => {
  fault.phase = "";
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "atomic-recovery-")); directories.push(directory);
  const store = new SessionStore(directory, true, 4);
  const receipt = { toolUseId: "completed", toolName: "Script", input: { script: "read" }, content: "done", isError: false };
  const record = store.create({ role: "orchestrator", model: "opus", toolNames: ["Script"], nativeGeneration: 1, claudeAccount: "team5" });
  store.update(record.bridgeSessionId, { state: "IDLE", factorySessionId: "factory", factoryCwd: "/fixture", historyMessageHashes: ["one"],
    retryableRequestKind: "upstream", retryableRequestHash: "a".repeat(64), hostCompletionReceipts: [receipt] });
  const context: UpstreamRecoveryContext = { store, accounts: ["team5"], workspacePolicy: "factory-native", busy: () => false,
    runtime: { kind: "fake", handle: vi.fn(), cancel: vi.fn(), deliverResults: vi.fn() }, checkpoint: () => "b".repeat(64),
    consumedCheckpoint: () => ({ checkpointSha256: "b".repeat(64), settledToolResults: [{ toolUseId: receipt.toolUseId, resultSha256: "c".repeat(64) }] }),
    evidence: () => ({ sha256: "d".repeat(64), failedAt: "2026-01-01T00:00:00Z", coolingUntil: "2027-01-01T00:00:00Z" }),
    inspect: async () => [{ generation: 0, state: "failed", bindingMatches: true, checkpointMatches: true, cleanupVerified: true,
      externalCleanupRequired: false, hostActionReservation: false, ownerAlive: false, supervisorAlive: false,
      endedBy: "session_update", endedAt: "2026-01-01T00:00:01Z" }], restoreCooldown: vi.fn() };
  const body = { operationId: "atomic-operation", bridgeSessionId: record.bridgeSessionId, factorySessionId: "factory", account: "team5", sdkSessionId: "checkpoint",
    nativeGeneration: 1, expectedUpdatedAt: record.updatedAt, checkpointSha256: "b".repeat(64), evidenceSha256: "d".repeat(64), receiptsSha256: receiptDigest([receipt]) };
  return { directory, store, record, receipt, context, body, journal: join(directory, "sessions.jsonl") };
}

describe("atomic recovery journal publication", () => {
  it.each(["partial-temp", "rename", "cleanup"] as const)("keeps restoration and reload consistent after %s failure", async phase => {
    const f = fixture(), before = structuredClone(f.record), journalBefore = readFileSync(f.journal);
    fault.phase = phase;
    await expect(restoreUpstreamCheckpoint(f.context, f.body)).rejects.toThrow(/injected/);
    if (phase === "cleanup") {
      expect(f.record.hostCompletionReceipts).toEqual([]);
      expect(f.record.upstreamCheckpointRecoveries).toHaveLength(1);
    } else {
      expect(f.record).toEqual(before);
      expect(readFileSync(f.journal)).toEqual(journalBefore);
    }
    const reloaded = new SessionStore(f.directory, true, 4);
    expect(reloaded.require(f.record.bridgeSessionId)).toEqual(f.record);
    f.context.store = reloaded;
    expect(await restoreUpstreamCheckpoint(f.context, f.body)).toMatchObject(phase === "cleanup" ? { alreadyRecovered: true } : { recovered: true });
    const final = reloaded.require(f.record.bridgeSessionId);
    expect(final.hostCompletionReceipts).toEqual([]);
    expect(final.upstreamCheckpointRecoveries).toHaveLength(1);
    expect(final.upstreamCheckpointRecoveries![0]!.before.hostCompletionReceipts).toEqual([f.receipt]);
    expect(new SessionStore(f.directory, true, 4).require(f.record.bridgeSessionId)).toEqual(final);
  });

  it("preserves an existing unterminated tail and separates the new complete record", () => {
    const f = fixture(), original = readFileSync(f.journal);
    const tail = Buffer.from(JSON.stringify({ ...f.record, notes: ["existing unterminated record"] }));
    writeFileSync(f.journal, Buffer.concat([original, tail]));
    f.store.updateAtomic(f.record.bridgeSessionId, { notes: ["new atomic record"] });
    const published = readFileSync(f.journal);
    expect(published.subarray(0, original.length + tail.length)).toEqual(Buffer.concat([original, tail]));
    expect(published[original.length + tail.length]).toBe(0x0a);
    expect(published.at(-1)).toBe(0x0a);
    expect(new SessionStore(f.directory, true, 4).require(f.record.bridgeSessionId)).toEqual(f.record);
  });
});
