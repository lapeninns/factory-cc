import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APIWorkerService, type WorkerExecutionHost, type WorkerView } from "../../src/workers/service.js";
import { callWorkerExecutor, launchWorkerExecutor, workerExecutorStatus } from "../../src/workers/executor.js";

const roots: string[] = [];
const services: APIWorkerService[] = [];
const jobs: Array<{ root: string; id: string }> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const job of jobs.splice(0)) {
    try { await callWorkerExecutor(job.root, job.id, "cancel"); } catch { /* Already settled. */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reconstructs the API frontend while its worker and pending approval survive", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "worker-service-executor-")));
  roots.push(folder);
  const repo = join(folder, "source"), root = join(folder, "state");
  mkdirSync(repo); mkdirSync(root, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "input.txt"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  const configFile = join(folder, "executor-config.json"), entrypoint = join(folder, "executor.ts");
  writeFileSync(configFile, JSON.stringify({ root }), { mode: 0o600 });
  const module = pathToFileURL(resolve("src/workers/executor.ts")).href;
  writeFileSync(entrypoint, `
    import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
    import { join } from "node:path";
    import { runWorkerExecutor } from ${JSON.stringify(module)};
    await runWorkerExecutor(process.argv[2], async (file, id) => {
      const { root } = JSON.parse(readFileSync(file, "utf8"));
      let view = { ...JSON.parse(readFileSync(join(root, id + ".json"), "utf8")), approvals: [] };
      let finish;
      const waiting = new Promise(resolve => { finish = resolve; });
      return {
        status: () => view,
        start: async () => {
          appendFileSync(join(root, "executions"), id + "\\n");
          view = { ...view, state: "waiting_approval", pendingApprovalCount: 1, approvals: [{ id: "approval-1", toolName: "Write", input: { file_path: "output.txt" }, requestedAt: new Date().toISOString() }] };
          await waiting;
          view = { ...view, state: "completed", resultState: "completed", cleanupVerified: true, leaseReleased: true, result: "One completed execution", pendingApprovalCount: 0, approvals: [] };
          const { approvals, ...record } = view;
          writeFileSync(join(root, id + ".json"), JSON.stringify(record), { mode: 0o600 });
        },
        cancel: async () => { finish(); },
        approve: async input => { if (input.approvalId !== "approval-1") throw new Error(); finish(); },
      };
    }, { snapshotMs: 20 });
  `, { mode: 0o600 });
  const host: WorkerExecutionHost = {
    start: (worker, task) => launchWorkerExecutor({ stateRoot: root, workerId: worker.id, task, configFile, entrypoint }),
    status: worker => workerExecutorStatus(root, worker.id) ?? { ...worker, approvals: [] } as WorkerView,
    cancel: worker => callWorkerExecutor(root, worker.id, "cancel"),
    approve: (worker, input) => callWorkerExecutor(root, worker.id, "approve", input),
    detach: async () => {},
  };
  const makeService = () => {
    const service = new APIWorkerService({ stateRoot: root, workspaceRoot: join(folder, "workspaces"), allowedRepositories: [repo],
      provider: { kind: "anthropic" }, maxBudgetUsd: 0.1, maxMs: 10_000, sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "nonfunctional-fixture" },
      verifyRuntime: () => ({ executable: "/nonfunctional-fixture", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" }),
      executionHost: host });
    services.push(service); return service;
  };
  const first = makeService();
  const input = { repository: repo, task: "one execution", workflow: "implement" as const, operationId: "request-1", operationOwner: "a".repeat(64) };
  const worker = await first.start(input);
  jobs.push({ root, id: worker.id });
  await expect.poll(() => first.status(worker.id).state).toBe("waiting_approval");
  await first.close();
  const restored = makeService();
  const existing = await restored.start(input);
  expect(existing.id).toBe(worker.id);
  expect(existing.state).toBe("waiting_approval");
  expect(existing.approvals[0]?.id).toBe("approval-1");
  await restored.approve({ id: worker.id, approvalId: "approval-1", decision: "allow" });
  await expect.poll(() => restored.status(worker.id).state).toBe("completed");
  expect(restored.status(worker.id)).toMatchObject({ result: "One completed execution", cleanupVerified: true, leaseReleased: true });
  expect(readFileSync(join(root, "executions"), "utf8")).toBe(worker.id + "\n");
  await restored.close();
  // The independently owned executor has confirmed completion, while the
  // frontend still holds its earlier unknown/release-unproven observation.
  const savedPath = join(root, worker.id + ".json");
  const saved = JSON.parse(readFileSync(savedPath, "utf8"));
  saved.state = "unknown"; saved.reason = "shared_lease_release_unproven"; saved.leaseReleased = false;
  writeFileSync(savedPath, JSON.stringify(saved));
  const reconciled = makeService();
  expect(reconciled.status(worker.id)).toMatchObject({ state: "completed", cleanupVerified: true, leaseReleased: true });
  expect(reconciled.list().find(value => value.id === worker.id)?.state).toBe("completed");
  expect(JSON.parse(readFileSync(savedPath, "utf8")).state).toBe("unknown");
  expect(readFileSync(join(root, "executions"), "utf8")).toBe(worker.id + "\n");
});

it("reconciles a worker interrupted during workspace preparation after frontend restart", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "worker-executor-preparation-")));
  roots.push(folder);
  const repo = join(folder, "source"), root = join(folder, "state");
  mkdirSync(repo); mkdirSync(root, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "input.txt"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const launches: string[] = [];
  const host: WorkerExecutionHost = {
    start: async worker => { launches.push(worker.id); return { ...worker, state: "running", approvals: [] }; },
    status: worker => ({ ...worker, state: "running", approvals: [] }),
    cancel: async worker => ({ ...worker, state: "cancelled", cleanupVerified: true, leaseReleased: true, approvals: [] }),
    approve: async worker => ({ ...worker, state: "running", approvals: [] }),
    detach: async () => {},
  };
  const makeService = () => {
    const service = new APIWorkerService({ stateRoot: root, workspaceRoot: join(folder, "workspaces"), allowedRepositories: [repo], maxConcurrent: 1,
      provider: { kind: "anthropic" }, maxBudgetUsd: 0.1, maxMs: 10_000, sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "nonfunctional-fixture" },
      verifyRuntime: () => ({ executable: "/nonfunctional-fixture", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" }), executionHost: host });
    services.push(service); return service;
  };
  const first = makeService();
  await first.start({ repository: repo, task: "A", workflow: "investigate" });
  const b = await first.start({ repository: repo, task: "B", workflow: "investigate" });
  expect(first.status(b.id).state).toBe("queued");
  await first.close();
  // Simulate a frontend that stopped after persisting B but before preparation finished.
  const path = join(root, b.id + ".json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.state = "starting"; delete record.executorLaunchRequested;
  writeFileSync(path, JSON.stringify(record) + "\n");
  const restored = makeService();
  const view = restored.status(b.id);
  expect(view.state).toBe("unknown");
  expect(view.reason).toBe("workspace_preparation_unconfirmed");
  expect(JSON.parse(readFileSync(path, "utf8")).state).toBe("unknown");
  expect(launches).not.toContain(b.id);
});

it("bounds executor launches and resumes its durable queue after frontend restart", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "worker-executor-queue-")));
  roots.push(folder);
  const repo = join(folder, "source"), root = join(folder, "state");
  mkdirSync(repo); mkdirSync(root, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "input.txt"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const running = new Map<string, WorkerView>();
  const launches: string[] = [];
  const host: WorkerExecutionHost = {
    start: async worker => { launches.push(worker.id); const value: WorkerView = { ...worker, state: "running", approvals: [] }; running.set(worker.id, value); return value; },
    status: worker => running.get(worker.id) ?? { ...worker, state: "unknown", approvals: [] },
    cancel: async worker => { const value: WorkerView = { ...worker, state: "cancelled", cleanupVerified: true, leaseReleased: true, approvals: [] }; running.set(worker.id, value); return value; },
    approve: async worker => running.get(worker.id)!,
    detach: async () => {},
  };
  const makeService = () => {
    const service = new APIWorkerService({ stateRoot: root, workspaceRoot: join(folder, "workspaces"), allowedRepositories: [repo], maxConcurrent: 1,
      provider: { kind: "anthropic" }, maxBudgetUsd: 0.1, maxMs: 10_000, sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "nonfunctional-fixture" },
      verifyRuntime: () => ({ executable: "/nonfunctional-fixture", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" }), executionHost: host });
    services.push(service); return service;
  };
  const first = makeService();
  const a = await first.start({ repository: repo, task: "A", workflow: "investigate" });
  const b = await first.start({ repository: repo, task: "B", workflow: "investigate" });
  const c = await first.start({ repository: repo, task: "C", workflow: "investigate" });
  expect(launches).toEqual([a.id]);
  expect(first.status(b.id).state).toBe("queued");
  expect(first.status(c.id).state).toBe("queued");
  await first.close();
  const restored = makeService();
  expect(restored.status(b.id).state).toBe("queued");
  expect(launches).toEqual([a.id]);
  running.set(a.id, { ...running.get(a.id)!, state: "completed", cleanupVerified: true, leaseReleased: true });
  await expect.poll(() => launches).toEqual([a.id, b.id]);
  expect(restored.status(c.id).state).toBe("queued");
  running.set(b.id, { ...running.get(b.id)!, state: "completed", cleanupVerified: true, leaseReleased: true });
  await expect.poll(() => launches).toEqual([a.id, b.id, c.id]);
});
