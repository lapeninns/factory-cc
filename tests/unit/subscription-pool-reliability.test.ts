import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { PoolUnavailableError, SubscriptionWorkerPool, type PoolBackend } from "../../src/workers/pool.js";

const roots: string[] = [];
const scope = "a".repeat(64), otherScope = "b".repeat(64);
const input = { repository: "/fixture/repository", task: "Verify fixture.", workflow: "investigate" as const };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-reliability-"))); roots.push(root);
  const workers = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, string>();
  const healthy = new Set<string>(SUBSCRIPTION_PROFILES);
  const starts: Array<{ profile: string; args: Record<string, unknown> }> = [];
  let loseStartResponse = false;
  const backends: PoolBackend[] = SUBSCRIPTION_PROFILES.map((profile, index) => ({
    profile, weight: index < 4 ? 5 : 1, identity: createHash("sha256").update(profile).digest("hex"),
    health: async () => healthy.has(profile),
    call: async (name, args) => {
      const operationKey = profile + ":" + args.operationOwner + ":" + args.operationId;
      if (name === "factory_worker_start") {
        starts.push({ profile, args });
        const worker = { id: "worker-" + randomUUID(), subscriptionProfile: profile, state: "running", cleanupVerified: null };
        workers.set(worker.id, worker); operations.set(operationKey, worker.id);
        if (loseStartResponse) { loseStartResponse = false; throw new Error("Lost accepted response."); }
        return { ...worker };
      }
      if (name === "factory_worker_lookup") {
        const id = operations.get(operationKey);
        return id ? { ...workers.get(id)! } : { found: false };
      }
      if (name === "factory_worker_list") return [...workers.values()].filter(worker => worker.subscriptionProfile === profile);
      const worker = workers.get(String(args.id));
      if (!worker) throw new Error("Unknown fixture worker.");
      if (name === "factory_worker_cancel") Object.assign(worker, { state: "cancelled", cleanupVerified: true });
      return { ...worker };
    },
    pending: async () => [], decide: async () => {},
  }));
  return { root, workers, healthy, starts, backends, loseNextResponse: () => { loseStartResponse = true; } };
}

describe("pool recovery and all-account admission", () => {
  it("uses all eight idle accounts before adding work to an occupied high-weight account", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    for (let index = 0; index < 8; index++) await pool.start(scope, { ...input, operationId: "task-" + index });
    expect(new Set(f.starts.map(start => start.profile))).toEqual(new Set(SUBSCRIPTION_PROFILES));
    expect(f.starts).toHaveLength(8);
    const report = await pool.accounts();
    expect(report.seatCount).toBe(8);
    expect(report.weightMeaning).toBe("assignment_priority");
    expect((report.accounts as Array<Record<string, unknown>>).map(account => [account.activeWorkers, account.assignedWorkers]))
      .toEqual(Array.from({ length: 8 }, () => [1, 1]));
  });

  it("reuses a caller operation across restart and rejects changed payloads", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    const first = await pool.start(scope, { ...input, operationId: "stable-operation" });
    const restored = new SubscriptionWorkerPool(f.root, f.backends);
    expect(await restored.start(scope, { ...input, operationId: "stable-operation" })).toMatchObject({ id: first.id, reused: true });
    await expect(restored.start(scope, { ...input, task: "Different task", operationId: "stable-operation" })).rejects.toThrow("different worker request");
    expect(f.starts).toHaveLength(1);
    const other = await restored.start(otherScope, { ...input, operationId: "stable-operation" });
    expect(other.id).not.toBe(first.id);
    expect(f.starts).toHaveLength(2);
    expect(readFileSync(join(f.root, "pool-state.json"), "utf8")).not.toContain("stable-operation");
  });

  it("looks up an accepted start after response loss without replaying execution", async () => {
    const f = fixture(); f.loseNextResponse();
    const pool = new SubscriptionWorkerPool(f.root, f.backends);
    const first = await pool.start(scope, { ...input, operationId: "lost-response" });
    expect(first.state).toBe("unknown");
    const restored = new SubscriptionWorkerPool(f.root, f.backends);
    expect(await restored.start(scope, { ...input, operationId: "lost-response" })).toMatchObject({ id: first.id, state: "running", reused: true });
    expect(f.starts).toHaveLength(1);
    expect(await restored.cancel(scope, String(first.id))).toMatchObject({ state: "cancelled", cleanupVerified: true });
    await expect(restored.status(otherScope, String(first.id))).rejects.toThrow("does not belong");
  });

  it("keeps a concurrent duplicate start on the first route", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    const [first, second] = await Promise.all([
      pool.start(scope, { ...input, operationId: "concurrent" }),
      pool.start(scope, { ...input, operationId: "concurrent" }),
    ]);
    expect(second.id).toBe(first.id);
    expect(f.starts).toHaveLength(1);
  });

  it("preserves legacy uncertain records without inventing a backend operation", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    const first = await pool.start(scope, input);
    const path = join(f.root, "pool-state.json"), saved = JSON.parse(readFileSync(path, "utf8"));
    const route = saved.routes[0];
    route.phase = "unknown";
    delete route.backendId; delete route.backendOperation; delete route.active; delete route.observedState;
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
    expect((await new SubscriptionWorkerPool(f.root, f.backends).status(scope, String(first.id))).state).toBe("unknown");
    expect(f.starts).toHaveLength(1);
  });

  it("retains capacity until terminal cleanup settles and refreshes completed work before selecting", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    const first = await pool.start(scope, input), backend = [...f.workers.values()][0]!;
    backend.state = "completed";
    expect((await pool.accounts()).accounts).toEqual(expect.arrayContaining([expect.objectContaining({ profile: "team1", activeWorkers: 1 })]));
    backend.cleanupVerified = true;
    await pool.start(scope, input);
    expect(f.starts[1]!.profile).toBe("team2");
    expect(await pool.status(scope, String(first.id))).toMatchObject({ state: "completed", cleanupVerified: true });
    expect((await pool.accounts()).accounts).toEqual(expect.arrayContaining([expect.objectContaining({ profile: "team1", activeWorkers: 0, completedWorkers: 1 })]));
  });

  it("reports unavailable accounts once with an actionable retry delay and resumes when healthy", async () => {
    const f = fixture(), pool = new SubscriptionWorkerPool(f.root, f.backends);
    f.healthy.clear();
    await expect(pool.start(scope, input)).rejects.toMatchObject({ code: "pool_unavailable", retryAfterSeconds: 5 });
    expect(f.starts).toHaveLength(0);
    expect((await pool.accounts()).accounts).toEqual(expect.arrayContaining([expect.objectContaining({ profile: "team8", state: "unavailable" })]));
    f.healthy.add("team8");
    expect(await pool.start(scope, input)).toMatchObject({ subscriptionProfile: "team8" });
    expect(new PoolUnavailableError(7).retryAfterSeconds).toBe(7);
  });
});
