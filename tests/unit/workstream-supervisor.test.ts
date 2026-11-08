import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStartRejection, superviseWorkstream, type SupervisorObservation, type SupervisorPolicy, type SupervisorState } from "../../src/runtime/workstream-supervisor.js";
import { atomicOwned, pauseRetry, readOwned, scheduleRetry, verifyTarget, type SupervisorConfig } from "../../scripts/workstream-supervisor.js";

const id = "8aaea39b-7a84-492e-af57-a5fb3e44970f";
const other = "4ecf9980-a17b-454f-a9a4-ee62a3fe798f";
const start = Date.parse("2026-11-08T01:00:00Z");
const failed = start + 5 * 60_000;
const p: SupervisorPolicy = { sessionId: id, startupGraceMs: 120_000, idleAlertMs: 600_000, dispatchGraceMs: 180_000, retryDelaysMs: [300_000, 900_000, 1_800_000] };
const state = (): SupervisorState => ({ armedAt: start, intent: "continue", attempts: 0, status: "watching" });
const observation = (o: Partial<SupervisorObservation> = {}): SupervisorObservation => ({ now: failed + 120_000, healthy: true, busy: false, ...o });
const rejected = (o: Partial<SupervisorObservation> = {}) => observation({ rejection: { at: failed, sessionId: id, reason: "missions_v2_disabled" }, ...o });

describe("independent Workstream supervision", () => {
  it("reproduces the overnight false-success case: a successful dispatch is not productive startup", () => {
    const result = superviseWorkstream(state(), observation({ dispatch: { id: "overnight-run", at: failed } }), p);
    expect(result.state.status).toBe("start-unverified");
    expect(result.state.alert?.reason).toBe("dispatch_succeeded_but_no_productive_start");
    expect(result.action).toBeUndefined(); // An unknown reason never authorizes a replay.
  });
  it("detects the exact access rejection and schedules one bounded retry into the original session", () => {
    const result = superviseWorkstream(state(), rejected(), p);
    expect(result.state.attempts).toBe(1);
    expect(result.action).toEqual({ type: "schedule", id: `${start}-1`, dueAt: failed + 300_000 });
    expect(result.state.verifiedAt).toBeUndefined();
  });
  it("does not count admission, one tool alone, or one model turn alone as verified progress", () => {
    for (const evidence of [{}, { lastTurnAt: failed + 10 }, { lastToolAt: failed + 10 }]) {
      expect(superviseWorkstream(state(), rejected(evidence), p).state.status).toBe("retry-scheduled");
    }
  });
  it("requires fresh completed inference AND a completed host tool, then clears the incident", () => {
    const pending = superviseWorkstream(state(), rejected(), p).state;
    const at = pending.pending!.dueAt;
    const result = superviseWorkstream(pending, rejected({ now: at + 1000, lastTurnAt: at + 400, lastToolAt: at + 500 }), p);
    expect(result.state.status).toBe("progress-verified");
    expect(result.state.attempts).toBe(0);
    expect(result.state.pending).toBeUndefined();
    expect(result.action?.type).toBe("pause-retry");
  });
  it("does not mistake pre-rejection or pre-retry evidence for recovery", () => {
    const pending = superviseWorkstream(state(), rejected(), p).state;
    expect(superviseWorkstream(pending, rejected({ lastTurnAt: failed - 1, lastToolAt: failed - 1 }), p).state.status).toBe("retry-scheduled");
    expect(superviseWorkstream(pending, rejected({ lastTurnAt: failed + 1, lastToolAt: failed + 1 }), p).state.status).toBe("retry-scheduled");
  });
  it("does not reset the retry budget on each new rejection, and stops after three attempts", () => {
    let result = superviseWorkstream(state(), rejected(), p);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(result.action?.type).toBe("schedule");
      expect(result.state.attempts).toBe(attempt);
      const at = result.state.pending!.dueAt + 1000;
      result = superviseWorkstream(result.state, rejected({ now: at + 120_000, rejection: { at, sessionId: id, reason: "missions_v2_disabled" }, retryDispatch: { id: `run-${attempt}`, at } }), p);
    }
    expect(result.state.status).toBe("blocked");
    expect(result.state.attempts).toBe(3);
    expect(result.action).toBeUndefined();
  });
  it("pauses a queued retry while any agent, callback, approval or other writer is busy", () => {
    const s = superviseWorkstream(state(), rejected(), p).state;
    const r = superviseWorkstream(s, rejected({ busy: true }), p);
    expect(r.state.status).toBe("work-active");
    expect(r.state.alert?.reason).toBe("native_start_rejected_recovery_deferred");
    expect(r.action?.type).toBe("pause-retry");
    expect(r.state.attempts).toBe(1);
  });
  it("never rotates an account or retries during its reported cooldown", () => {
    const r = superviseWorkstream(state(), rejected({ cooldownUntil: failed + 3_600_000 }), p);
    expect(r.state.status).toBe("waiting-for-account");
    expect(r.state.attempts).toBe(0);
    expect(r.action).toBeUndefined();
    const s = superviseWorkstream(state(), rejected(), p).state;
    const waiting = superviseWorkstream(s, rejected({ cooldownUntil: failed + 3_600_000 }), p);
    expect(waiting.action?.type).toBe("pause-retry");
    expect(waiting.state.pending!.dueAt).toBe(failed + 3_660_000);
  });
  it("does not retry a cancellation, explicit pause, completion, unrelated failure or unclassified rejection", () => {
    expect(superviseWorkstream(state(), rejected({ cancelledAt: failed + 1 }), p).state.status).toBe("operator-interrupted");
    for (const intent of ["pause", "complete"] as const) expect(superviseWorkstream({ ...state(), intent }, rejected(), p).action).toBeUndefined();
    expect(superviseWorkstream(state(), rejected({ rejection: { at: failed, sessionId: other, reason: "missions_v2_disabled" } }), p).action).toBeUndefined();
    expect(superviseWorkstream(state(), rejected({ rejection: { at: failed, sessionId: id, reason: "permission_denied" } }), p).state.status).toBe("blocked");
  });
  it("fails closed on unavailable observations, even with a previous rejection", () => {
    const r = superviseWorkstream(state(), rejected({ healthy: false }), p);
    expect(r.state.status).toBe("observation-unavailable");
    expect(r.action).toBeUndefined();
  });
  it("waits for start grace and alerts unexpected idle without blindly resuming it", () => {
    expect(superviseWorkstream(state(), rejected({ now: failed + 1 }), p).state.status).toBe("start-rejected");
    const r = superviseWorkstream(state(), observation({ now: start + 600_000 }), p);
    expect(r.state.status).toBe("attention-idle");
    expect(r.action).toBeUndefined();
  });
  it("verifies a dispatch instead of declaring recovery, and alerts a missed or unproductive retry", () => {
    const s = superviseWorkstream(state(), rejected(), p).state;
    const at = s.pending!.dueAt;
    expect(superviseWorkstream(s, observation({ now: at + 1, retryDispatch: { id: "retry", at } }), p).state.status).toBe("verifying-retry");
    expect(superviseWorkstream(s, observation({ now: at + 120_000, retryDispatch: { id: "retry", at } }), p).state.status).toBe("retry-unverified");
    expect(superviseWorkstream(s, observation({ now: at + 180_001 }), p).state.status).toBe("delivery-missed");
  });
  it("preserves input state and maintains a stable alert timestamp", () => {
    const s = state();
    const r = superviseWorkstream(s, observation({ now: start + 600_000 }), p);
    expect(s.status).toBe("watching");
    const next = superviseWorkstream(r.state, observation({ now: start + 700_000 }), p);
    expect(next.state.alert?.at).toBe(r.state.alert?.at);
  });
});

describe("native logger boundary", () => {
  const record = `[2026-11-08T01:05:34.725Z] WARN: [Agent] Missions 2.0 turn rejected\n  Error: unavailable\n    at native (missionV2Access.ts:96:17) | Context: ${JSON.stringify({ reason: "missions_v2_disabled", cause: { message: "Workstreams are not available for this organization" }, tags: { sessionId: id } })}\n`;
  it("reads the owned native logger's top-level reason and tags only", () => {
    expect(nativeStartRejection(record)).toEqual({ at: Date.parse("2026-11-08T01:05:34.725Z"), sessionId: id, reason: "missions_v2_disabled" });
  });
  it("rejects transcript nesting, other log categories, incomplete context, oversized records and nested identity", () => {
    for (const s of [JSON.stringify({ content: record }), record.replace("WARN: [Agent]", "INFO: [Tool]"), record.slice(0, -20), record + "x".repeat(256 * 1024), record.replace(`"tags":{"sessionId":"${id}"}`, `"tags":{},"untrusted":{"sessionId":"${id}"}`)]) expect(nativeStartRejection(s)).toBeUndefined();
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workstream-supervisor-"))); roots.push(root);
  for (const d of ["controller", "logs", "sessions", "sessions/repo", "automations", "state"]) mkdirSync(join(root, d), { mode: 0o700 });
  const c: SupervisorConfig = { targetSessionId: id, controllerUrl: "http://127.0.0.1:18870", controllerDataDir: join(root, "controller"), poolConfigFile: join(root, "pool.json"), factorySessionsDir: join(root, "sessions"), factoryLogsDir: join(root, "logs"), automationsDir: join(root, "automations"), stateDir: join(root, "state"), watchedAutomation: "existing-trigger", retryAutomation: "owned-recovery", recoveryEnabled: true, expectedModelId: "custom:bridge" };
  const settings = join(root, "sessions/repo", `${id}.settings.json`);
  writeFileSync(settings, JSON.stringify({ model: "custom:bridge", tags: [{ name: "mission-v2", metadata: { kind: "orchestrator", missionId: id } }] }));
  return { root, c, settings };
}
describe("private filesystem and native schedule adapter", () => {
  it("creates a date-restricted schedule for exactly the existing session, and pauses it without touching the source automation", () => {
    const { c } = fixture();
    scheduleRetry(c, "incident-1", failed + 300_000);
    const file = join(c.automationsDir, c.retryAutomation, "HEARTBEAT.md"), first = readFileSync(file, "utf8");
    expect(first).toContain(`targetSessionId: ${id}`);
    expect(first).not.toContain("model:");
    expect(first).not.toContain("* * * * *");
    scheduleRetry(c, "incident-1", failed + 300_000);
    expect(readFileSync(file, "utf8")).toBe(first);
    pauseRetry(c); pauseRetry(c);
    expect(readFileSync(file, "utf8").match(/paused: true/g)).toHaveLength(1);
  });
  it("refuses to overwrite an existing automation without its own ownership marker", () => {
    const { c } = fixture();
    mkdirSync(join(c.automationsDir, c.retryAutomation));
    const file = join(c.automationsDir, c.retryAutomation, "HEARTBEAT.md"); writeFileSync(file, "private existing task");
    expect(() => scheduleRetry(c, "incident", failed)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("private existing task");
  });
  it("rejects symlink reads, symlink replacement, escaping parents and oversized private configuration", () => {
    const { root } = fixture(), file = join(root, "state/file"), link = join(root, "state/link");
    writeFileSync(file, "preserve"); symlinkSync(file, link);
    expect(() => readOwned(link)).toThrow();
    expect(() => atomicOwned(link, "overwrite")).toThrow();
    expect(() => readOwned(file, 2)).toThrow();
    symlinkSync(join(root, "state"), join(root, "alias"));
    expect(() => readOwned(join(root, "alias/file"))).toThrow();
    expect(readFileSync(file, "utf8")).toBe("preserve");
  });
  it("requires one exact owned native orchestrator tag and the selected bridge custom model", () => {
    const { c, settings } = fixture(); expect(() => verifyTarget(c)).not.toThrow();
    for (const d of [{ model: "custom:bridge", content: { tags: [{ name: "mission-v2", metadata: { kind: "orchestrator", missionId: id } }] } }, { model: "hosted", tags: [{ name: "mission-v2", metadata: { kind: "orchestrator", missionId: id } }] }, { model: "custom:bridge", tags: [{ name: "mission-v2", metadata: { kind: "agent", missionId: id } }] }]) {
      writeFileSync(settings, JSON.stringify(d)); expect(() => verifyTarget(c)).toThrow();
    }
  });
});
