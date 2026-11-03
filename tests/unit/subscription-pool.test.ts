import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { approvalDigest, approvalSummary } from "../../src/workers/control.js";
import { createPoolBackends, readPoolConfig, readPoolPrivateFile, SubscriptionWorkerPool, type PoolBackend, type PoolConfig } from "../../src/workers/pool.js";

const roots: string[] = [];
const scopeA = "a".repeat(64), scopeB = "b".repeat(64);
const input = { repository: "/fixture/repository", task: "Investigate the disposable fixture.", workflow: "investigate" as const };
const approval = { id: "approval-fixture", toolName: "Bash", input: { command: "printf fixture" } };
const signal = () => new AbortController().signal;
function root(): string { const value = realpathSync(mkdtempSync(join(tmpdir(), "pool-test-"))); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

function fixture(weights = SUBSCRIPTION_PROFILES.map(() => 1)) {
  const calls: Array<{ profile: string; name: string; args: Record<string, unknown> }> = [];
  const pending: Array<{ profile: string; id: string }> = [];
  const decisions: Array<{ profile: string; id: string; approval: unknown; decision: string }> = [];
  const workers = new Map<string, Record<string, unknown>>();
  const healthy = new Set<string>(SUBSCRIPTION_PROFILES);
  const backends: PoolBackend[] = SUBSCRIPTION_PROFILES.map((profile, index) => ({
    profile, weight: weights[index]!, identity: createHash("sha256").update(profile).digest("hex"),
    health: async () => healthy.has(profile),
    call: async (name, args) => {
      calls.push({ profile, name, args });
      if (name === "factory_worker_start") {
        const worker = { id: "worker-" + randomUUID(), state: "running", subscriptionProfile: profile, approvals: [approval] };
        workers.set(worker.id, worker); return { ...worker };
      }
      const worker = workers.get(String(args.id));
      if (!worker) throw new Error("Unknown fake worker");
      if (name === "factory_worker_cancel") worker.state = "cancelled";
      return { ...worker };
    },
    pending: async id => { pending.push({ profile, id }); return [approval]; },
    decide: async (id, action, decision) => { decisions.push({ profile, id, approval: action, decision }); },
  }));
  return { backends, calls, pending, decisions, workers, healthy };
}

describe("subscription worker pool routing", () => {
  it("assigns equal-weight starts across all eight seats and keeps operations pinned", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(root(), f.backends);
    const starts = [];
    for (let index = 0; index < 8; index++) starts.push(await pool.start(scopeA, input));
    expect(starts.map(item => item.subscriptionProfile)).toEqual(SUBSCRIPTION_PROFILES);
    const first = starts[0]!, firstBackendId = f.calls[0]!.args;
    expect(first.id).not.toEqual([...f.workers.keys()][0]);
    await pool.status(scopeA, String(first.id));
    await pool.cancel(scopeA, String(first.id));
    const operations = f.calls.slice(-2);
    expect(operations.map(item => item.profile)).toEqual(["team1", "team1"]);
    expect(operations.map(item => item.args.id)).toEqual([[...f.workers.keys()][0], [...f.workers.keys()][0]]);
    expect(firstBackendId).toEqual(input);
  });

  it("retains the configured legacy 5:1 relative weights", async () => {
    const f = fixture([5, 5, 5, 5, 1, 1, 1, 1]), pool = new SubscriptionWorkerPool(root(), f.backends);
    const counts: Record<string, number> = {};
    for (let index = 0; index < 24; index++) {
      const worker = await pool.start(scopeA, input), profile = String(worker.subscriptionProfile);
      counts[profile] = (counts[profile] ?? 0) + 1;
    }
    expect(SUBSCRIPTION_PROFILES.map(profile => counts[profile])).toEqual([5, 5, 5, 5, 1, 1, 1, 1]);
  });

  it("skips unavailable seats before dispatch and dispatches nothing when none is healthy", async () => {
    const f = fixture(); f.healthy.delete("team1");
    const path = root(), pool = new SubscriptionWorkerPool(path, f.backends);
    expect((await pool.start(scopeA, input)).subscriptionProfile).toBe("team2");
    f.healthy.clear();
    await expect(pool.start(scopeA, input)).rejects.toThrow("No healthy");
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).routes).toHaveLength(1);
  });

  it("scopes listing, status and cancellation without exposing raw scope in the ledger", async () => {
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends);
    const a = await pool.start(scopeA, input), b = await pool.start(scopeB, input);
    expect((await pool.list(scopeA)).map(item => item.id)).toEqual([a.id]);
    expect((await pool.list(scopeB)).map(item => item.id)).toEqual([b.id]);
    const count = f.calls.length;
    await expect(pool.status(scopeA, String(b.id))).rejects.toThrow("does not belong");
    await expect(pool.cancel(scopeB, String(a.id))).rejects.toThrow("does not belong");
    expect(f.calls).toHaveLength(count);
    expect(readFileSync(join(path, "pool-state.json"), "utf8")).not.toContain(scopeA);
    expect(statSync(join(path, "pool-state.json")).mode & 0o777).toBe(0o600);
  });

  it("persists exact routing and scheduler progress across daemon reconstruction", async () => {
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends);
    const first = await pool.start(scopeA, input), backendId = [...f.workers.keys()][0];
    const restored = new SubscriptionWorkerPool(path, f.backends);
    expect((await restored.status(scopeA, String(first.id))).id).toBe(first.id);
    expect(f.calls.at(-1)).toMatchObject({ profile: "team1", name: "factory_worker_status", args: { id: backendId } });
    expect((await restored.start(scopeA, input)).subscriptionProfile).toBe("team2");
    const changed = f.backends.map(item => ({ ...item }));
    changed[0]!.identity = "f".repeat(64);
    expect(() => new SubscriptionWorkerPool(path, changed)).toThrow("another routing");
  });

  it("records uncertain delivery once without retrying another account", async () => {
    const f = fixture(), path = root();
    f.backends[0]!.call = async (name, args) => { f.calls.push({ profile: "team1", name, args }); throw new Error("disconnected after send"); };
    const pool = new SubscriptionWorkerPool(path, f.backends), item = await pool.start(scopeA, input);
    expect(item).toMatchObject({ state: "unknown", subscriptionProfile: "team1", cleanupVerified: null });
    expect(f.calls).toHaveLength(1);
    const restored = new SubscriptionWorkerPool(path, f.backends);
    expect((await restored.status(scopeA, String(item.id))).state).toBe("unknown");
    expect((await restored.cancel(scopeA, String(item.id))).state).toBe("unknown");
    expect(f.calls).toHaveLength(1);
  });

  it("persists confirmed rejection without contacting the backend again or retrying", async () => {
    const f = fixture(), path = root();
    f.backends[0]!.call = async (name, args) => {
      f.calls.push({ profile: "team1", name, args });
      return { type: "worker_start_rejected", code: "subscription_preflight_failed", executionStarted: false };
    };
    const pool = new SubscriptionWorkerPool(path, f.backends), item = await pool.start(scopeA, input);
    expect(item).toMatchObject({ state: "failed", errorCode: "subscription_preflight_failed", executionStarted: false, retrySafe: true, cleanupVerified: true });
    expect(String(item.reason)).toContain("pinned authentication runtime");
    const restored = new SubscriptionWorkerPool(path, f.backends);
    expect(await restored.status(scopeA, String(item.id))).toEqual(item);
    expect(await restored.cancel(scopeA, String(item.id))).toEqual(item);
    expect((await restored.list(scopeA))[0]).toEqual(item);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).routes[0]).toMatchObject({ phase: "unknown", rejectionCode: "subscription_preflight_failed" });
  });

  it.each([
    { type: "worker_start_rejected", code: "subscription_preflight_failed", executionStarted: true },
    { type: "worker_start_rejected", code: "unknown_private_error", executionStarted: false },
    { type: "worker_start_rejected", code: "subscription_preflight_failed", executionStarted: false, id: "worker-" + randomUUID() },
  ])("keeps malformed rejection proof uncertain", async rejection => {
    const f = fixture(); f.backends[0]!.call = async () => rejection;
    const item = await new SubscriptionWorkerPool(root(), f.backends).start(scopeA, input);
    expect(item.state).toBe("unknown");
    expect(item.executionStarted).toBeUndefined();
    expect(item.retrySafe).toBeUndefined();
  });

  it("rejects persisted rejection records with contradictory execution identity", async () => {
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends);
    await pool.start(scopeA, input);
    const file = join(path, "pool-state.json"), saved = JSON.parse(readFileSync(file, "utf8"));
    saved.routes[0].phase = "unknown"; saved.routes[0].rejectionCode = "runtime_unverified";
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    expect(() => new SubscriptionWorkerPool(path, f.backends)).toThrow("Invalid pool route");
  });

  it("recovers interrupted dispatch records as unknown without sending a start", async () => {
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends);
    const item = await pool.start(scopeA, input);
    const file = join(path, "pool-state.json"), saved = JSON.parse(readFileSync(file, "utf8"));
    saved.routes[0].phase = "dispatching"; delete saved.routes[0].backendId;
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    const count = f.calls.length, restored = new SubscriptionWorkerPool(path, f.backends);
    expect((await restored.status(scopeA, String(item.id))).state).toBe("unknown");
    expect(f.calls).toHaveLength(count);
    expect(JSON.parse(readFileSync(file, "utf8")).routes[0].phase).toBe("unknown");
  });

  it("uses bounded structured native backoff for cooling and never interprets error or task prose", async () => {
    let now = 10_000;
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends, () => now);
    const item = await pool.start(scopeA, input), backend = [...f.workers.values()][0]!;
    backend.state = "completed"; backend.result = "The rate limit implementation needs a test.";
    await pool.status(scopeA, String(item.id));
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil).toEqual({});
    backend.state = "failed"; backend.error = "rate_limit_error";
    await pool.status(scopeA, String(item.id));
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil).toEqual({});
    for (const retryAfterSeconds of [0, -1, 86401, "60", 0.5]) {
      backend.backoff = { kind: "rate_limit", retryAfterSeconds };
      await pool.status(scopeA, String(item.id));
      expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil).toEqual({});
    }
    backend.backoff = { kind: "usage_limit", retryAfterSeconds: 60 };
    await pool.status(scopeA, String(item.id));
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil.team1).toBe(now + 60_000);
    now += 1000;
    await pool.status(scopeA, String(item.id));
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil.team1).toBe(70_000);
    f.healthy.clear(); f.healthy.add("team1");
    await expect(pool.start(scopeA, input)).rejects.toThrow("No healthy");
    now += 60_001;
    expect((await pool.start(scopeA, input)).subscriptionProfile).toBe("team1");
  });

  it("forwards exact approvals only to the original backend worker identifier", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(root(), f.backends), item = await pool.start(scopeA, input);
    const backendId = [...f.workers.keys()][0]!;
    expect(await pool.pending(String(item.id), signal())).toEqual([approval]);
    const valid = { id: String(item.id), approvalId: approval.id, actionDigest: approvalDigest(approval.input), summary: approvalSummary(approval), decision: "allow" as const };
    await expect(pool.decide({ ...valid, actionDigest: "0".repeat(64) }, signal())).rejects.toThrow("changed");
    await expect(pool.decide({ ...valid, summary: "approve something else" }, signal())).rejects.toThrow("changed");
    await expect(pool.decide({ ...valid, id: "worker-" + randomUUID() }, signal())).rejects.toThrow("does not belong");
    expect(f.decisions).toHaveLength(0);
    await pool.decide(valid, signal());
    expect(f.decisions).toEqual([{ profile: "team1", id: backendId, approval, decision: "allow" }]);
    expect(f.pending.every(call => call.id === backendId && call.profile === "team1")).toBe(true);
  });

  it("anchors late-observed cooldowns to completion instead of renewing stale failures", async () => {
    const now = 1_800_000_000_000;
    const f = fixture(), path = root(), pool = new SubscriptionWorkerPool(path, f.backends, () => now);
    const item = await pool.start(scopeA, input), backend = [...f.workers.values()][0]!;
    backend.state = "failed";
    backend.backoff = { kind: "rate_limit", retryAfterSeconds: 60 };
    backend.endedAt = new Date(now - 120_000).toISOString();
    await pool.status(scopeA, String(item.id));
    expect(JSON.parse(readFileSync(join(path, "pool-state.json"), "utf8")).coolUntil.team1).toBe(now - 60_000);
    f.healthy.clear(); f.healthy.add("team1");
    expect((await pool.start(scopeA, input)).subscriptionProfile).toBe("team1");
  });

  it("rejects malformed scopes before contacting a backend", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(root(), f.backends);
    await expect(pool.start("team1", input)).rejects.toThrow("scope");
    const aborted = new AbortController(); aborted.abort();
    await expect(pool.start(scopeA, input, aborted.signal)).rejects.toThrow("cancelled before dispatch");
    expect(f.calls).toHaveLength(0);
  });
});

describe("private pool configuration", () => {
  function configuration() {
    const path = root(), file = join(path, "config.json");
    const config: PoolConfig = { version: 1, enabled: true, stateRoot: join(path, "state"), port: 21870,
      clientTokenFile: join(path, "token"), seats: SUBSCRIPTION_PROFILES.map((profile, index) => ({ profile, weight: 1, configFile: join(path, profile + ".json") })) };
    for (const [index, seat] of config.seats.entries()) writeFileSync(seat.configFile, JSON.stringify({
      provider: "subscription", subscriptionProfile: seat.profile, enabled: true, approvalGuardVerified: true,
      port: 21871 + index, clientTokenFile: join(path, seat.profile + "-token"), stateRoot: join(path, seat.profile),
    }), { mode: 0o600 });
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return { path, file, config };
  }
  it("accepts exactly eight private fixed subscription connections without provider access", () => {
    const f = configuration(), config = readPoolConfig(f.file);
    expect(config.seats.map(item => item.profile)).toEqual(SUBSCRIPTION_PROFILES);
    expect(createPoolBackends(config)).toHaveLength(8);
  });
  it("rejects duplicated seats, missing seats and cross-profile backend configuration", () => {
    const f = configuration();
    writeFileSync(f.file, JSON.stringify({ ...f.config, seats: f.config.seats.slice(0, 7) }));
    expect(() => readPoolConfig(f.file)).toThrow();
    writeFileSync(f.file, JSON.stringify({ ...f.config, seats: [f.config.seats[0], ...f.config.seats.slice(0, 7)] }));
    expect(() => readPoolConfig(f.file)).toThrow();
    writeFileSync(f.config.seats[0]!.configFile, JSON.stringify({ provider: "subscription", subscriptionProfile: "team2", enabled: true,
      approvalGuardVerified: true, port: 22000, clientTokenFile: "/fixture/token", stateRoot: "/fixture/state" }));
    expect(() => createPoolBackends(f.config)).toThrow("fixed subscription");
  });
  it("refuses broad permissions, symlinks and API configuration", () => {
    const f = configuration();
    chmodSync(f.file, 0o644);
    expect(() => readPoolConfig(f.file)).toThrow("Unsafe private");
    chmodSync(f.file, 0o600); const alias = join(f.path, "alias.json"); symlinkSync(f.file, alias);
    expect(() => readPoolPrivateFile(alias)).toThrow();
    const first = JSON.parse(readFileSync(f.config.seats[0]!.configFile, "utf8"));
    writeFileSync(f.config.seats[0]!.configFile, JSON.stringify({ ...first, apiKeyFile: "/do-not-read" }));
    expect(() => createPoolBackends(f.config)).toThrow("fixed subscription");
  });
});
