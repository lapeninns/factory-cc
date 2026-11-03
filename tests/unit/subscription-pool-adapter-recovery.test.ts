import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { SubscriptionWorkerPool, type PoolBackend, type PoolConfig } from "../../src/workers/pool.js";
import { startPoolServer } from "../../src/workers/pool-http.js";

const token = "a".repeat(64);
const sessionA = "b51062d9-a24d-459c-9f8e-6d8887fa9e92";
const sessionB = "a8063b76-c5f6-4c5c-bdcb-7a764df6a455";
const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];
const adapter = resolve("scripts/subscription-pool.ts");
const loader = createRequire(import.meta.url).resolve("tsx");
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-adapter-recovery-"))); roots.push(root);
  const workers = new Map<string, Record<string, unknown>>();
  const starts: string[] = [];
  let loseStartResponse = false;
  const backends: PoolBackend[] = SUBSCRIPTION_PROFILES.map(profile => ({
    profile, weight: 1, identity: createHash("sha256").update(profile).digest("hex"), health: async () => true,
    call: async (name, args) => {
      if (name === "factory_worker_start") {
        const id = "worker-" + randomUUID(); starts.push(id);
        const worker = { id, state: "running", subscriptionProfile: profile, cleanupVerified: false };
        workers.set(id, worker);
        if (loseStartResponse) { loseStartResponse = false; throw new Error("Accepted start response was lost"); }
        return worker;
      }
      const worker = workers.get(String(args.id));
      if (!worker) throw new Error("Unknown fixture worker");
      if (name === "factory_worker_cancel") { worker.state = "cancelled"; worker.cleanupVerified = true; }
      return { ...worker };
    },
    pending: async () => [], decide: async () => {},
  }));
  const poolRoot = join(root, "pool");
  const running = await startPoolServer(() => new SubscriptionWorkerPool(poolRoot, backends), {
    port: 0, token, controlFile: join(poolRoot, "control.json"),
  });
  cleanups.push(() => running.close());
  const address = running.server.address(); if (!address || typeof address === "string") throw new Error();
  const tokenFile = join(root, "token"); writeFileSync(tokenFile, token, { mode: 0o600 });
  const config: PoolConfig = { version: 1, enabled: true, stateRoot: poolRoot, port: address.port, clientTokenFile: tokenFile, seats: [] };
  for (const [index, profile] of SUBSCRIPTION_PROFILES.entries()) {
    const directory = join(root, profile); mkdirSync(directory, { mode: 0o700 });
    const configFile = join(directory, "config.json");
    writeFileSync(configFile, JSON.stringify({ provider: "subscription", subscriptionProfile: profile, enabled: true,
      approvalGuardVerified: true, port: 10000 + index, stateRoot: directory, clientTokenFile: tokenFile }), { mode: 0o600 });
    config.seats.push({ profile, weight: 1, configFile });
  }
  const configPath = join(root, "config.json"); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  async function connect(strict = true, cwd = root) {
    const client = new Client({ name: "Factory host fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, cwd,
      args: ["--import", loader, adapter, "--config", configPath, ...(strict ? ["--factory-session-scope"] : [])], stderr: "pipe" });
    let errors = ""; transport.stderr?.on("data", bytes => { errors += String(bytes); });
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw new Error(`Adapter failed: ${errors}`, { cause: error }); }
    cleanups.push(() => client.close());
    return client;
  }
  return { root, workers, starts, connect, loseNextStartResponse: () => { loseStartResponse = true; } };
}

function call(client: Client, name: string, args: Record<string, unknown>, session = sessionA) {
  return client.callTool({ name, arguments: args, _meta: { assemblySessionId: session, caller: "AGENT" } });
}
function value(result: Awaited<ReturnType<Client["callTool"]>>): any {
  expect(result.isError).not.toBe(true);
  const first = Array.isArray(result.content) ? result.content[0] as { type?: string; text?: unknown } : undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error();
  return JSON.parse(first.text);
}

describe("real pooled worker stdio adapter recovery", () => {
  it("recovers running and completed workers after fresh adapter processes without restarting execution", async () => {
    const f = await fixture(), first = await f.connect();
    const catalogue = await first.listTools();
    expect(catalogue.tools).toHaveLength(5);
    expect(catalogue.tools.find(tool => tool.name === "factory_worker_list")?.description).toContain("across reconnections");
    const running = value(await call(first, "factory_worker_start", { repository: f.root, task: "running fixture" }));
    const completed = value(await call(first, "factory_worker_start", { repository: f.root, task: "completed fixture" }));
    const completedBackend = f.workers.get(f.starts[1]!)!;
    Object.assign(completedBackend, { state: "completed", cleanupVerified: true, result: "retained result", commit: "f".repeat(40) });
    await first.close();
    const resumed = await f.connect();
    expect(value(await call(resumed, "factory_worker_list", {})).map((worker: any) => worker.id)).toEqual([running.id, completed.id]);
    expect(value(await call(resumed, "factory_worker_status", { id: running.id })).state).toBe("running");
    const timer = setTimeout(() => { f.workers.get(f.starts[0]!)!.state = "waiting_approval"; }, 20);
    try { expect(value(await call(resumed, "factory_worker_wait", { id: running.id })).state).toBe("waiting_approval"); }
    finally { clearTimeout(timer); }
    expect(value(await call(resumed, "factory_worker_wait", { id: completed.id }))).toMatchObject({ state: "completed", result: "retained result", commit: "f".repeat(40), cleanupVerified: true });
    expect(value(await call(resumed, "factory_worker_cancel", { id: running.id }))).toMatchObject({ state: "cancelled", cleanupVerified: true });
    await resumed.close();
    const differentDirectory = join(f.root, "different-directory"); mkdirSync(differentDirectory);
    const again = await f.connect(true, differentDirectory);
    expect(value(await call(again, "factory_worker_status", { id: running.id })).state).toBe("cancelled");
    expect(value(await call(again, "factory_worker_status", { id: completed.id })).state).toBe("completed");
    expect(f.starts).toHaveLength(2);
  });

  it("isolates two host sessions sharing one adapter and directory", async () => {
    const f = await fixture(), adapter = await f.connect();
    const [a, b] = await Promise.all([
      call(adapter, "factory_worker_start", { repository: f.root, task: "A" }, sessionA).then(value),
      call(adapter, "factory_worker_start", { repository: f.root, task: "B" }, sessionB).then(value),
    ]);
    expect(value(await call(adapter, "factory_worker_list", {}, sessionA)).map((worker: any) => worker.id)).toEqual([a.id]);
    expect(value(await call(adapter, "factory_worker_list", {}, sessionB)).map((worker: any) => worker.id)).toEqual([b.id]);
    expect((await call(adapter, "factory_worker_status", { id: b.id }, sessionA)).isError).toBe(true);
    expect((await call(adapter, "factory_worker_cancel", { id: a.id }, sessionB)).isError).toBe(true);
    expect(f.starts).toHaveLength(2);
  });

  it("rejects missing, malformed and model-supplied identity before dispatch", async () => {
    const f = await fixture(), adapter = await f.connect();
    const params = { name: "factory_worker_start", arguments: { repository: f.root, task: "must not run" } };
    expect((await adapter.callTool(params)).isError).toBe(true);
    for (const _meta of [{ assemblySessionId: "unknown", caller: "AGENT" }, { assemblySessionId: sessionA, caller: "USER" }]) {
      expect((await adapter.callTool({ ...params, _meta })).isError).toBe(true);
    }
    expect((await adapter.callTool({ ...params, arguments: { ...params.arguments, assemblySessionId: sessionA, caller: "AGENT" } })).isError).toBe(true);
    expect((await call(adapter, params.name, { ...params.arguments, assemblySessionId: sessionB })).isError).toBe(true);
    expect(f.starts).toHaveLength(0);
  });

  it("preserves connection-lifetime ownership for generic clients without the Factory flag", async () => {
    const f = await fixture(), first = await f.connect(false);
    const worker = value(await first.callTool({ name: "factory_worker_start", arguments: { repository: f.root, task: "generic fixture" } }));
    await first.close();
    const next = await f.connect(false);
    expect(value(await next.callTool({ name: "factory_worker_list", arguments: {} }))).toEqual([]);
    expect((await next.callTool({ name: "factory_worker_status", arguments: { id: worker.id } })).isError).toBe(true);
    expect(f.starts).toHaveLength(1);
  });

  it("retains an uncertain accepted start after reconnect without replaying it", async () => {
    const f = await fixture(), first = await f.connect();
    f.loseNextStartResponse();
    const worker = value(await call(first, "factory_worker_start", { repository: f.root, task: "uncertain fixture" }));
    expect(worker.state).toBe("unknown");
    await first.close();
    const resumed = await f.connect();
    expect(value(await call(resumed, "factory_worker_status", { id: worker.id })).state).toBe("unknown");
    expect(value(await call(resumed, "factory_worker_list", {})).map((item: any) => item.id)).toEqual([worker.id]);
    expect(f.starts).toHaveLength(1);
  });
});
