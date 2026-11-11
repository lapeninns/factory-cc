import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAccountCandidates, nativeAssignedAccount } from "../../src/runtime/native-account-admission.js";
import { ClaudePool } from "../../src/upstream/claude-pool.js";
import type { SessionRecord } from "../../src/sessions/state.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
const members = ["team1", "team2", "team3"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-account-admission-")); directories.push(root);
  mkdirSync(join(root, "jobs"), { mode: 0o700 });
  const write = (name: string, value: unknown) => writeFileSync(join(root, "jobs", name + ".json"), JSON.stringify(value), { mode: 0o600 });
  return { root, write };
}
function record(account: string, updatedAt: string, sdkSessionId?: string, factorySessionId = "native-agent"): SessionRecord {
  return { claudeAccount: account, updatedAt, sdkSessionId, factorySessionId } as SessionRecord;
}
describe("native account assignments", () => {
  it("keeps the executed assignee after cancellation instead of adopting a queued replacement", () => {
    const records = [record("team2", "2026-11-07T21:00:00Z", "sdk-team2"), record("team3", "2026-11-07T21:01:00Z"),
      record("team1", "2026-11-07T21:02:00Z", "foreign-sdk", "other-agent")];
    expect(nativeAssignedAccount(records, "native-agent", members)).toBe("team2");
    expect(nativeAssignedAccount(records, "new-agent", members)).toBeUndefined();
    expect(records[0]!.claudeAccount).toBe("team2");
    // Verified cold-retry cleanup retires the SDK checkpoint, not the assignee.
    records[0]!.sdkSessionId = undefined;
    records[0]!.retryableRequestKind = "upstream";
    expect(nativeAssignedAccount(records, "native-agent", members)).toBe("team2");
  });
  it("prefers the least occupied lane and excludes uncertain accounts", () => {
    const { root, write } = fixture();
    write("worker", { profile: "team1", state: "running" });
    write("uncertain", { profile: "team2", state: "unknown" });
    expect([...nativeAccountCandidates(root, "worker", members)]).toEqual(["team3"]);
    expect([...nativeAccountCandidates(root, "orchestrator", members)]).toEqual(["team1", "team3"]);
  });
  it("distinguishes native controllers from worker jobs and counts queued assignments", () => {
    const { root, write } = fixture();
    write("controller", { kind: "factory-session", authMode: "subscription", profile: "team1", subscriptionProfile: "team1",
      workspacePolicy: "factory-native", role: "orchestrator", state: "running" });
    write("queue", { profile: "team2", state: "waiting_slot" });
    write("worker", { profile: "team3", state: "starting" });
    expect([...nativeAccountCandidates(root, "worker", members)]).toEqual(["team1"]);
    expect([...nativeAccountCandidates(root, "orchestrator", members)]).toEqual(["team2", "team3"]);
  });
  it("rejects uncertain or unreadable ledgers without freeing an account", () => {
    const { root, write } = fixture();
    for (const profile of members) write(profile, { profile, state: "cleanup_blocked" });
    expect(() => nativeAccountCandidates(root, "worker", members)).toThrow(expect.objectContaining({ code: "native_pool_recovery_required" }));
    writeFileSync(join(root, "private-target"), "{}", { mode: 0o600 });
    symlinkSync(join(root, "private-target"), join(root, "jobs", "redirect.json"));
    expect(() => nativeAccountCandidates(root, "worker", members)).toThrow(expect.objectContaining({ code: "native_pool_state_unavailable" }));
  });
  it("supports a new ledger and applies weights only among equally eligible seats", () => {
    const { root } = fixture();
    expect([...nativeAccountCandidates(join(root, "new-state"), "worker", members)]).toEqual(members);
    const pool = new ClaudePool([{ id: "team1", weight: 100 }, { id: "team2", weight: 1 }]);
    expect(pool.pick(new Set(["team2"]))).toBe("team2");
    expect(() => pool.pick(new Set())).toThrow(expect.objectContaining({ code: "pool_selection_unavailable" }));
    expect(pool.pick()).toBe("team1");
  });
});
