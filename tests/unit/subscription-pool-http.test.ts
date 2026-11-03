import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";
import { decideWorkerApproval, readPendingWorkerApprovals } from "../../src/runtime/worker-permission-client.js";
import { startPoolServer } from "../../src/workers/pool-http.js";
import { SubscriptionWorkerPool, type PoolBackend } from "../../src/workers/pool.js";

const token = "c".repeat(64), scopeA = "a".repeat(64), scopeB = "b".repeat(64);
const roots: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const approval = { id: "review-exact-action", toolName: "Bash", input: { command: "printf isolated-fixture" } };
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), "pool-http-"))); roots.push(path); return path; }
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function backends() {
  const workers = new Map<string, Record<string, unknown>>();
  const decisions: Array<{ profile: string; id: string; decision: string }> = [];
  const pending: Array<{ profile: string; id: string }> = [];
  const tasks: unknown[] = [];
  const values: PoolBackend[] = SUBSCRIPTION_PROFILES.map(profile => ({
    profile, weight: 1, identity: createHash("sha256").update(profile).digest("hex"), health: async () => true,
    call: async (name, args) => {
      if (name === "factory_worker_start") {
        tasks.push(args.task);
        const worker = { id: "worker-" + randomUUID(), state: "waiting_approval", subscriptionProfile: profile, approvals: [approval] };
        workers.set(worker.id, worker); return worker;
      }
      if (name === "factory_worker_list") return [...workers.values()].map(worker => ({ ...worker }));
      const worker = workers.get(String(args.id));
      if (!worker) throw new Error();
      if (name === "factory_worker_cancel") worker.state = "cancelled";
      return { ...worker };
    },
    pending: async id => { pending.push({ profile, id }); return [approval]; },
    decide: async (id, _approval, decision) => { decisions.push({ profile, id, decision }); },
  }));
  return { values, workers, decisions, pending, tasks };
}

async function fixture() {
  const path = root(), f = backends();
  const controlFile = join(path, "approval-control.json");
  const running = await startPoolServer(() => new SubscriptionWorkerPool(path, f.values), { port: 0, token, controlFile });
  cleanups.push(() => running.close());
  const address = running.server.address();
  if (!address || typeof address === "string") throw new Error();
  return { ...f, ...running, path, controlFile, url: "http://127.0.0.1:" + address.port, port: address.port };
}
async function client(url: string, scope: string) {
  const value = new Client({ name: "pool-fixture", version: "1.0.0" });
  await value.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: {
    headers: { authorization: "Bearer " + token, "x-factory-worker-scope": scope },
  } }));
  cleanups.push(() => value.close());
  return value;
}
function result(value: Awaited<ReturnType<Client["callTool"]>>): any {
  const first = Array.isArray(value.content) ? value.content[0] as { type?: string; text?: unknown } : undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("Missing text result");
  return JSON.parse(first.text);
}

describe("pooled worker MCP and approval boundaries", () => {
  it("preserves a UTF-8 task when HTTP chunks split a multi-byte character", async () => {
    const f = await fixture(), task = "Inspect the café fixture.";
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call",
      params: { name: "factory_worker_start", arguments: { repository: "/fixture/repo", task } } }));
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    expect(bytes[split - 1]).toBe(0xc3);
    expect(bytes[split]).toBe(0xa9);
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(f.url + "/mcp", { method: "POST", headers: {
        authorization: "Bearer " + token, "x-factory-worker-scope": scopeA,
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "content-length": bytes.length, "mcp-protocol-version": "2025-06-18",
      } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.flushHeaders();
      req.write(bytes.subarray(0, split));
      setTimeout(() => req.end(bytes.subarray(split)), 10);
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).result.isError).not.toBe(true);
    expect(f.tasks).toEqual([task]);
  });

  it("serves authenticated readiness, requires a private scope, and exposes worker tools plus account availability", async () => {
    const f = await fixture();
    expect((await fetch(f.url + "/health")).status).toBe(401);
    const health = await fetch(f.url + "/health", { headers: { authorization: "Bearer " + token } });
    expect(await health.json()).toEqual({ ok: true, seatCount: 8, routing: "new-workers-only" });
    expect((await fetch(f.url + "/mcp", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" })).status).toBe(403);
    const c = await client(f.url, scopeA);
    expect((await c.listTools()).tools.map(item => item.name)).toEqual([
      "factory_worker_start", "factory_worker_status", "factory_worker_wait", "factory_worker_list", "factory_worker_cancel", "factory_worker_accounts",
    ]);
    const unknown = await c.callTool({ name: "factory_worker_approve", arguments: {} });
    expect(unknown.isError).toBe(true);
  });

  it("isolates clients and translates public identifiers for status, wait and cancel", async () => {
    const f = await fixture(), a = await client(f.url, scopeA), b = await client(f.url, scopeB);
    const workerA = result(await a.callTool({ name: "factory_worker_start", arguments: { repository: "/fixture/repo", task: "fixture A" } }));
    const workerB = result(await b.callTool({ name: "factory_worker_start", arguments: { repository: "/fixture/repo", task: "fixture B" } }));
    expect(workerA.subscriptionProfile).toBe("team1");
    expect(workerB.subscriptionProfile).toBe("team2");
    expect(result(await a.callTool({ name: "factory_worker_list", arguments: {} })).map((item: any) => item.id)).toEqual([workerA.id]);
    expect(result(await b.callTool({ name: "factory_worker_list", arguments: {} })).map((item: any) => item.id)).toEqual([workerB.id]);
    expect((await a.callTool({ name: "factory_worker_status", arguments: { id: workerB.id } })).isError).toBe(true);
    expect((await a.callTool({ name: "factory_worker_cancel", arguments: { id: workerB.id } })).isError).toBe(true);
    expect(result(await a.callTool({ name: "factory_worker_wait", arguments: { id: workerA.id } })).state).toBe("waiting_approval");
    expect(result(await a.callTool({ name: "factory_worker_cancel", arguments: { id: workerA.id } })).state).toBe("cancelled");
    expect([...f.workers.values()].map(worker => worker.state)).toEqual(["cancelled", "waiting_approval"]);
  });

  it("exposes eight-account availability and stable operation retries through MCP", async () => {
    const f = await fixture(), c = await client(f.url, scopeA);
    const input = { repository: "/fixture/repo", task: "one logical task", operationId: "operation-1" };
    const first = result(await c.callTool({ name: "factory_worker_start", arguments: input }));
    const repeated = result(await c.callTool({ name: "factory_worker_start", arguments: input }));
    expect(repeated).toMatchObject({ id: first.id, reused: true });
    expect(f.tasks).toEqual([input.task]);
    const conflict = await c.callTool({ name: "factory_worker_start", arguments: { ...input, task: "changed task" } });
    expect(conflict.isError).toBe(true);
    expect(result(conflict)).toMatchObject({ type: "operation_conflict", retrySafe: false });
    const accounts = result(await c.callTool({ name: "factory_worker_accounts", arguments: {} }));
    expect(accounts.seatCount).toBe(8);
    expect(accounts.accounts.map((account: { profile: string }) => account.profile)).toEqual(SUBSCRIPTION_PROFILES);
    expect(accounts.accounts[0]).toMatchObject({ profile: "team1", activeWorkers: 1, assignedWorkers: 1 });
    expect((await fetch(f.url + "/accounts")).status).toBe(401);
    const readback = await fetch(f.url + "/accounts", { headers: { authorization: "Bearer " + token } });
    expect(await readback.json()).toMatchObject({ seatCount: 8 });
  });

  it("returns a bounded retry instruction when all accounts are unavailable", async () => {
    const f = await fixture(), c = await client(f.url, scopeA);
    for (const backend of f.values) backend.health = async () => false;
    const reply = await c.callTool({ name: "factory_worker_start", arguments: {
      repository: "/fixture/repo", task: "wait for availability", operationId: "unavailable-1",
    } });
    expect(reply.isError).toBe(true);
    expect(result(reply)).toMatchObject({ type: "pool_unavailable", executionStarted: false, retrySafe: true, retryAfterSeconds: 5 });
    expect(f.tasks).toEqual([]);
  });

  it("uses the private exact-action approval channel and the pinned backend identifier", async () => {
    const f = await fixture(), c = await client(f.url, scopeA);
    const item = result(await c.callTool({ name: "factory_worker_start", arguments: { repository: "/fixture/repo", task: "approval fixture" } }));
    const backendId = [...f.workers.keys()][0]!;
    expect(item.id).not.toBe(backendId);
    const control = JSON.parse(readFileSync(f.controlFile, "utf8"));
    expect((await fetch(control.url + "/pending/" + item.id)).status).toBe(401);
    const pending = await readPendingWorkerApprovals(f.controlFile, item.id, new AbortController().signal);
    expect(pending).toEqual([approval]);
    expect(f.pending.at(-1)).toEqual({ profile: "team1", id: backendId });
    const bad = await fetch(control.url + "/decision", { method: "POST", headers: {
      authorization: "Bearer " + control.token, "content-type": "application/json",
    }, body: JSON.stringify({ id: item.id, approvalId: approval.id, decision: "allow", actionDigest: "0".repeat(64), summary: "wrong" }) });
    expect(bad.status).toBe(409); expect(f.decisions).toHaveLength(0);
    await decideWorkerApproval(f.controlFile, item.id, approval, "allow", new AbortController().signal);
    expect(f.decisions).toEqual([{ profile: "team1", id: backendId, decision: "allow" }]);
  });

  it("rejects a duplicate listener before constructing or recovering another pool", async () => {
    const f = await fixture(); let constructed = false;
    await expect(startPoolServer(() => { constructed = true; return new SubscriptionWorkerPool(f.path, f.values); }, {
      port: f.port, token, controlFile: join(f.path, "duplicate-control.json"),
    })).rejects.toThrow();
    expect(constructed).toBe(false);
  });

  it("a fresh adapter scope cannot discover or operate earlier scoped jobs", async () => {
    const f = await fixture(), first = await client(f.url, scopeA);
    const item = result(await first.callTool({ name: "factory_worker_start", arguments: { repository: "/fixture/repo", task: "old connection" } }));
    const restarted = await client(f.url, "d".repeat(64));
    expect(result(await restarted.callTool({ name: "factory_worker_list", arguments: {} }))).toEqual([]);
    expect((await restarted.callTool({ name: "factory_worker_status", arguments: { id: item.id } })).isError).toBe(true);
  });
});
