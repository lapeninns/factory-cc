import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callWorkerExecutor, launchWorkerExecutor, runWorkerExecutor, workerExecutorStatus } from "../../src/workers/executor.js";
import { privateDirectory } from "../../src/workers/worker-state.js";
import type { WorkerView } from "../../src/workers/service.js";

const roots: string[] = [];
const active: Array<{ root: string; id: string }> = [];
const loader = createRequire(import.meta.url).resolve("tsx");
const moduleUrl = pathToFileURL(resolve("src/workers/executor.ts")).href;

afterEach(async () => {
  for (const { root, id } of active.splice(0)) {
    try { await callWorkerExecutor(root, id, "cancel"); } catch { /* Already settled or not started. */ }
    await expect.poll(() => workerExecutorStatus(root, id)?.cleanupVerified, { timeout: 5000 }).toBe(true);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-executor-"))); roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  const id = "worker-72ab2530-3da9-42eb-b2bc-af10a4ce0f58";
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify({ root, id }), { mode: 0o600 });
  const entrypoint = join(root, "runner.ts");
  writeFileSync(entrypoint, `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { runWorkerExecutor } from ${JSON.stringify(moduleUrl)};
    await runWorkerExecutor(process.argv[2], async (configFile, id) => {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      let state = { id, state: 'queued', cleanupVerified: null, leaseReleased: false, approvals: [], pendingApprovalCount: 0 };
      return {
        status: () => structuredClone(state),
        start: async () => {
          appendFileSync(join(config.root, 'starts'), 'started\\n');
          state.state = 'waiting_approval';
          state.approvals = [{ id: 'approval-one', toolName: 'Write', input: { path: 'fixture.txt' } }];
          state.pendingApprovalCount = 1;
          await wait;
          state.approvals = []; state.pendingApprovalCount = 0;
          state.state = state.state === 'cancelled' ? 'cancelled' : 'completed';
          state.cleanupVerified = true; state.leaseReleased = true;
        },
        cancel: async () => { state.state = 'cancelled'; state.cleanupVerified = true; state.leaseReleased = true; release(); },
        approve: async value => { if (value.approvalId !== 'approval-one') throw new Error(); release(); },
      };
    }, { snapshotMs: 20 });
  `, { mode: 0o600 });
  return { root, id, stateRoot: root, workerId: id, configFile, entrypoint, task: "Private fake executor fixture" };
}

describe("durable worker executor", () => {
  it("keeps an owned task available after the launching frontend exits", async () => {
    const options = fixture();
    const parent = join(options.root, "frontend.ts");
    writeFileSync(parent, `
      import { launchWorkerExecutor } from ${JSON.stringify(moduleUrl)};
      const result = await launchWorkerExecutor(${JSON.stringify(options)});
      process.stdout.write(JSON.stringify({ id: result.id }));
      process.exit(0);
    `, { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", loader, parent], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { errors += data; });
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    expect(code, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({ id: options.id });
    active.push({ root: options.root, id: options.id });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("waiting_approval");
    expect(lstatSync(join(options.root, "executors", options.id, "receipt.json")).mode & 0o077).toBe(0);
    expect(() => lstatSync(join(options.root, "executors", options.id, "request.json"))).toThrow();
    await callWorkerExecutor(options.root, options.id, "approve", { id: options.id, approvalId: "approval-one", decision: "allow" });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("completed");
    expect(workerExecutorStatus(options.root, options.id)?.cleanupVerified).toBe(true);
    expect(readFileSync(join(options.root, "starts"), "utf8")).toBe("started\n");
  });

  it("does not rerun an opened start gate and refuses a second launch record", async () => {
    const options = fixture();
    await launchWorkerExecutor(options); active.push({ root: options.root, id: options.id });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("waiting_approval");
    await callWorkerExecutor(options.root, options.id, "start");
    await callWorkerExecutor(options.root, options.id, "start");
    await expect(launchWorkerExecutor(options)).rejects.toThrow("already has an executor");
    expect(readFileSync(join(options.root, "starts"), "utf8")).toBe("started\n");
  });

  it("rejects stale birth identities without controlling the replacement process", async () => {
    const options = fixture();
    await launchWorkerExecutor(options); active.push({ root: options.root, id: options.id });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("waiting_approval");
    const path = join(options.root, "executors", options.id, "receipt.json");
    const original = readFileSync(path, "utf8");
    const receipt = JSON.parse(original); receipt.pid = process.pid; receipt.started = "not-this-process";
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
    expect(workerExecutorStatus(options.root, options.id)?.state).toBe("unknown");
    await expect(callWorkerExecutor(options.root, options.id, "cancel")).rejects.toThrow("ownership is unavailable");
    writeFileSync(path, original, { mode: 0o600 });
    expect(workerExecutorStatus(options.root, options.id)?.state).toBe("waiting_approval");
  });

  it("expires an unopened gate without executing the accepted task", async () => {
    const options = fixture();
    const directory = privateDirectory(join(options.root, "executors", options.id));
    const socketRoot = privateDirectory(join(realpathSync("/tmp"), "factory-executors-" + process.getuid!()));
    const requestPath = join(directory, "request.json");
    writeFileSync(requestPath, JSON.stringify({ version: 1, workerId: options.id, stateRoot: options.root,
      configFile: options.configFile, task: options.task,
      socketPath: join(socketRoot, randomBytes(16).toString("hex") + ".sock"),
      token: randomBytes(32).toString("hex"), entrypoint: options.entrypoint,
      entrypointSha256: createHash("sha256").update(readFileSync(options.entrypoint)).digest("hex") }), { mode: 0o600 });
    let starts = 0;
    const view = { id: options.id, state: "queued", approvals: [], cleanupVerified: null } as unknown as WorkerView;
    await runWorkerExecutor(requestPath, async () => ({
      status: () => view,
      start: async () => { starts++; },
      cancel: async () => { view.state = "cancelled"; view.cleanupVerified = true; view.leaseReleased = true; },
      approve: async () => {},
    }), { gateTimeoutMs: 20, snapshotMs: 20 });
    expect(starts).toBe(0);
    expect(workerExecutorStatus(options.root, options.id)?.state).toBe("cancelled");
  });
});


describe("shared lease completion reconciliation", () => {
  it("accepts an exact terminal receipt after executor departure without replaying or modifying evidence", async () => {
    const options = fixture();
    await launchWorkerExecutor(options); active.push({ root: options.root, id: options.id });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("waiting_approval");
    await callWorkerExecutor(options.root, options.id, "approve", { id: options.id, approvalId: "approval-one", decision: "allow" });
    await expect.poll(() => workerExecutorStatus(options.root, options.id)?.state).toBe("completed");
    const executorRoot = join(options.root, "executors", options.id);
    const receipt = JSON.parse(readFileSync(join(executorRoot, "receipt.json"), "utf8"));
    await expect.poll(() => { try { process.kill(receipt.pid, 0); return false; } catch { return true; } }).toBe(true);
    const viewPath = join(executorRoot, "view.json"), original = readFileSync(viewPath, "utf8");
    const view = { ...JSON.parse(original), state: "unknown", reason: "shared_lease_release_unproven", resultState: "completed", leaseReleased: false,
      authentication: "subscription", subscriptionProfile: "team1", worktree: "/fixture/worktree", endedAt: "2026-11-07T01:02:05.121Z" };
    const sharedStateRoot = join(options.root, "native-state");
    mkdirSync(sharedStateRoot, { mode: 0o700 }); mkdirSync(join(sharedStateRoot, "jobs"), { mode: 0o700 });
    const jobId = "factory-" + createHash("sha256").update(options.id + "\0" + options.id).digest("hex").slice(0, 32);
    const jobPath = join(sharedStateRoot, "jobs", jobId + ".json");
    const job = { version: 1, id: jobId, kind: "factory-session", role: "worker", factorySessionId: options.id, bridgeSessionId: options.id,
      state: "completed", worktree: view.worktree, profile: "team1", subscriptionProfile: "team1", authMode: "subscription", cleanupVerified: null,
      externalCleanupRequired: false, ownedProcesses: [], endedAt: "2026-11-07T11:48:50.421703+00:00",
      leaseOwnerIdentity: { pid: receipt.pid, pgid: receipt.group, start: receipt.started, uid: process.getuid!() },
      supervisorIdentity: { pid: receipt.pid, pgid: receipt.group, uid: process.getuid!(), start: receipt.started } };
    writeFileSync(viewPath, JSON.stringify(view)); writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
    try {
      expect(workerExecutorStatus(options.root, options.id, { sharedStateRoot })).toMatchObject({ state: "completed", leaseReleased: true, cleanupVerified: true, reason: "shared_lease_settlement_reconciled" });
      expect(readFileSync(viewPath, "utf8")).toBe(JSON.stringify(view));
      expect(readFileSync(jobPath, "utf8")).toBe(JSON.stringify(job));
      expect(readFileSync(join(options.root, "starts"), "utf8")).toBe("started\n");
      for (const change of [
        { state: "unknown" }, { subscriptionProfile: "team2" }, { worktree: "/other" }, { externalCleanupRequired: true },
        { leaseOwnerIdentity: { ...job.leaseOwnerIdentity, start: "different birth" } }, { supervisorIdentity: { pid: process.pid } },
        { ownedProcesses: [{ pid: process.pid }] }, { endedAt: "2026-11-06T01:00:00Z" }, { cleanupVerified: false },
      ]) {
        writeFileSync(jobPath, JSON.stringify({ ...job, ...change }));
        expect(workerExecutorStatus(options.root, options.id, { sharedStateRoot })?.state).toBe("unknown");
      }
      writeFileSync(jobPath, JSON.stringify(job));
      writeFileSync(viewPath, JSON.stringify({ ...view, cleanupVerified: false }));
      expect(workerExecutorStatus(options.root, options.id, { sharedStateRoot })?.state).toBe("unknown");
    } finally { writeFileSync(viewPath, original); }
  });
});
