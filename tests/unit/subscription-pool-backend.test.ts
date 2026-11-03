import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { serveWorkerMcp } from "../../src/workers/http.js";
import { startWorkerControl, approvalDigest, approvalSummary } from "../../src/workers/control.js";
import { createPoolBackends, SubscriptionWorkerPool, type PoolConfig } from "../../src/workers/pool.js";
import { WorkerStartRejected } from "../../src/workers/start-rejection.js";

it("routes through actual SDK MCP clients into eight fake fixed worker services and their private approval endpoint", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-backend-")));
  const close: Array<() => Promise<void>> = [], starts: string[] = [], decisions: unknown[] = [];
  let failure: "preflight" | "generic" | "serialization" | "false-proof" | undefined;
  const config: PoolConfig = { version: 1, enabled: true, port: 65530, stateRoot: join(root, "pool"),
    clientTokenFile: join(root, "pool-token"), seats: [] };
  const approval = { id: "fixture-action", toolName: "Bash", input: { command: "printf fixture" } };
  try {
    for (const [index, profile] of SUBSCRIPTION_PROFILES.entries()) {
      const directory = join(root, profile); mkdirSync(directory, { mode: 0o700 });
      const workers = new Map<string, Record<string, unknown>>(), token = String(index + 1).repeat(64);
      const controller = {
        start: async () => {
          if (failure === "preflight") throw new WorkerStartRejected("subscription_preflight_failed", "private account detail");
          if (failure === "generic") throw new Error("private uncertain failure");
          if (failure === "serialization") return { toJSON: () => { throw new WorkerStartRejected("runtime_unverified"); } };
          if (failure === "false-proof") return { type: "worker_start_rejected", code: "runtime_unverified", executionStarted: false };
          starts.push(profile);
          const worker = { id: "worker-" + randomUUID(), state: "waiting_approval", subscriptionProfile: profile, approvals: [approval] };
          workers.set(worker.id, worker); return worker;
        },
        status: (id: string) => { const worker = workers.get(id); if (!worker) throw new Error(); return worker; },
        list: () => [...workers.values()],
        cancel: async (id: string) => ({ ...controller.status(id), state: "cancelled" }),
        approve: (input: unknown) => { decisions.push({ profile, input }); },
      };
      const server = await serveWorkerMcp(controller, { port: 0, token });
      close.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      const address = server.address(); if (!address || typeof address === "string") throw new Error();
      const control = await startWorkerControl(controller, join(directory, "approval-control.json"));
      close.push(() => control.close());
      const tokenFile = join(directory, "client-token"), file = join(directory, "config.json");
      writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
      writeFileSync(file, JSON.stringify({ enabled: true, provider: "subscription", subscriptionProfile: profile,
        approvalGuardVerified: true, port: address.port, stateRoot: directory, clientTokenFile: tokenFile }), { mode: 0o600 });
      config.seats.push({ profile, weight: 1, configFile: file });
    }
    const backends = createPoolBackends(config);
    expect(await Promise.all(backends.map(backend => backend.health()))).toEqual(Array(8).fill(true));
    const pool = new SubscriptionWorkerPool(config.stateRoot, backends), scope = "a".repeat(64), publicIds: string[] = [];
    for (const profile of SUBSCRIPTION_PROFILES) {
      const worker = await pool.start(scope, { repository: "/fixture/repo", task: "No inference fixture", workflow: "investigate" });
      expect(worker).toMatchObject({ state: "waiting_approval", subscriptionProfile: profile });
      publicIds.push(String(worker.id));
      expect((await pool.status(scope, String(worker.id))).subscriptionProfile).toBe(profile);
    }
    expect(starts).toEqual(SUBSCRIPTION_PROFILES);
    expect(await pool.pending(publicIds[0]!, new AbortController().signal)).toEqual([approval]);
    await pool.decide({ id: publicIds[0]!, approvalId: approval.id, actionDigest: approvalDigest(approval.input),
      summary: approvalSummary(approval), decision: "allow" }, new AbortController().signal);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ profile: "team1", input: { approvalId: approval.id, decision: "allow" } });
    expect((decisions[0] as { input: { id: string } }).input.id).not.toBe(publicIds[0]);
    expect((await pool.cancel(scope, publicIds[1]!)).state).toBe("cancelled");
    failure = "preflight";
    const rejected = await pool.start(scope, { repository: "/fixture/repo", task: "Rejected before execution", workflow: "investigate" });
    expect(rejected).toMatchObject({ state: "failed", subscriptionProfile: "team1", errorCode: "subscription_preflight_failed", executionStarted: false, retrySafe: true });
    expect(JSON.stringify(rejected)).not.toContain("private");
    const restored = new SubscriptionWorkerPool(config.stateRoot, backends);
    expect(await restored.status(scope, String(rejected.id))).toEqual(rejected);
    for (const kind of ["generic", "serialization", "false-proof"] as const) {
      failure = kind;
      const uncertain = await restored.start(scope, { repository: "/fixture/repo", task: "Uncertain fixture", workflow: "investigate" });
      expect(uncertain.state).toBe("unknown");
      expect(uncertain.retrySafe).toBeUndefined();
    }
    expect(starts).toHaveLength(8);
  } finally {
    for (const finish of close.reverse()) await finish();
    rmSync(root, { recursive: true, force: true });
  }
});
