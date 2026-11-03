import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { closeSync, existsSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PoolOperationConflictError, PoolUnavailableError, readPoolPrivateFile, type PoolWorkerInput, type SubscriptionWorkerPool } from "./pool.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const tokenValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const string = (value: unknown): string => { if (typeof value !== "string" || !value.trim()) throw new Error(); return value; };
function authorize(actual: string | undefined, token: string): boolean {
  const a = Buffer.from(actual ?? ""), b = Buffer.from("Bearer " + token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(request: AsyncIterable<Buffer | string>, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += bytes.length;
    if (length > limit) throw new Error();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
}

export function createPoolMcp(pool: SubscriptionWorkerPool, scope: string, enabled = true): Server {
  const server = new Server({ name: "factory-subscription-pool", version: "1.0.0" }, {
    capabilities: { tools: {} },
    instructions: "Delegate independent tasks with these pooled supervised workers. New workers use the least occupied healthy accounts among eight fixed subscription services and remain on their assigned account. Give each logical task one stable operationId and reuse it for retries. Status reconciles an uncertain start with its original service. Start a worker, then use bounded status/wait calls and report recorded results. Check factory_worker_accounts for account availability and assignment counts. Human actions use the controller's configured permission policy.",
  });
  const idSchema = { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "factory_worker_start", description: "Start a supervised Opus 5.5 medium Ultracode worker on one of eight eligible accounts. Use one operationId for each logical task and reuse that ID if its response is lost. The same ID and task return the existing worker.", inputSchema: { type: "object", properties: { repository: { type: "string" }, task: { type: "string" }, operationId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }, workflow: { type: "string", enum: ["implement", "investigate", "release-prepare"] } }, required: ["repository", "task", "operationId"], additionalProperties: false } },
    { name: "factory_worker_status", description: "Read an owned worker's state, assigned account, result, usage and pending human actions.", inputSchema: idSchema, annotations: { readOnlyHint: true } },
    { name: "factory_worker_wait", description: "Wait at most 20 seconds for an owned worker, returning immediately for a terminal state or human approval.", inputSchema: idSchema, annotations: { readOnlyHint: true } },
    { name: "factory_worker_list", description: "List only workers started through this Workstream's current connection.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "factory_worker_cancel", description: "Cancel an owned worker through its original account's service. Never switches accounts.", inputSchema: idSchema },
    { name: "factory_worker_accounts", description: "Read availability, active and assigned worker counts for all eight accounts. Weights express assignment priority. Counts do not measure subscription quota.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (!enabled) throw new Error();
      const args = request.params.arguments ?? {};
      if (!object(args)) throw new Error();
      const name = request.params.name;
      const keys = name === "factory_worker_start" ? ["repository", "task", "workflow", "operationId"] : ["factory_worker_list", "factory_worker_accounts"].includes(name) ? [] : ["id"];
      if (Object.keys(args).some(key => !keys.includes(key))) throw new Error();
      let result: unknown;
      if (name === "factory_worker_start") {
        const workflow = args.workflow ?? "implement";
        if (!["implement", "investigate", "release-prepare"].includes(String(workflow))) throw new Error();
        result = await pool.start(scope, { repository: string(args.repository), task: string(args.task), workflow: workflow as PoolWorkerInput["workflow"],
          ...(args.operationId === undefined ? {} : { operationId: string(args.operationId) }) }, extra.signal);
      } else if (name === "factory_worker_status") result = await pool.status(scope, string(args.id), extra.signal);
      else if (name === "factory_worker_list") result = await pool.list(scope, extra.signal);
      else if (name === "factory_worker_accounts") result = await pool.accounts(extra.signal);
      else if (name === "factory_worker_cancel") result = await pool.cancel(scope, string(args.id), extra.signal);
      else if (name === "factory_worker_wait") {
        const id = string(args.id);
        let current = await pool.status(scope, id, extra.signal);
        const before = JSON.stringify(current), until = Date.now() + 20_000;
        while (!extra.signal.aborted && Date.now() < until && !["completed", "failed", "cancelled", "unknown", "waiting_approval"].includes(String(current.state))) {
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); extra.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 500);
            extra.signal.addEventListener("abort", done, { once: true });
          });
          if (extra.signal.aborted) break;
          current = await pool.status(scope, id, extra.signal);
          if (JSON.stringify(current) !== before) break;
        }
        result = current;
      } else throw new Error();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof PoolUnavailableError || error instanceof PoolOperationConflictError) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ type: error.code, message: error.message,
          ...(error instanceof PoolUnavailableError ? { executionStarted: false, retrySafe: true, retryAfterSeconds: error.retryAfterSeconds } : { retrySafe: false }) }) }] };
      }
      return { isError: true, content: [{ type: "text", text: "Pooled worker operation failed. Inspect this connection and its owned worker state. No account switch or automatic retry was performed." }] };
    }
  });
  return server;
}

async function startPoolControl(pool: SubscriptionWorkerPool, path: string): Promise<HttpServer> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!authorize(request.headers.authorization, token)) { response.writeHead(401).end(); return; }
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    const pending = request.url?.match(/^\/pending\/(worker-[a-f0-9-]{36})$/);
    if (request.method === "GET" && pending) {
      try {
        const approvals = await pool.pending(pending[1]!, abort.signal);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: pending[1], approvals }));
      } catch { response.writeHead(404).end(); }
      return;
    }
    if (request.method !== "POST" || request.url !== "/decision") { response.writeHead(404).end(); return; }
    try {
      const input = await body(request, 16384);
      if (!object(input) || typeof input.id !== "string" || typeof input.approvalId !== "string" || typeof input.actionDigest !== "string"
          || typeof input.summary !== "string" || !["allow", "deny"].includes(String(input.decision))) throw new Error();
      await pool.decide({ id: input.id, approvalId: input.approvalId, actionDigest: input.actionDigest, summary: input.summary, decision: input.decision as "allow" | "deny" }, abort.signal);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, decision: input.decision }));
    } catch { response.writeHead(409, { "content-type": "application/json" }).end('{"ok":false}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    if (existsSync(path)) readPoolPrivateFile(path, 16384);
    const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ url: "http://127.0.0.1:" + address.port, token }) + "\n"); } finally { closeSync(fd); }
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return server;
}

/** Bind the singleton socket before recovering or mutating the pool ledger. */
export async function startPoolServer(factory: () => SubscriptionWorkerPool, options: { port: number; token: string; controlFile: string; enabled?: boolean }): Promise<{ server: HttpServer; control: HttpServer; pool: SubscriptionWorkerPool; close(): Promise<void> }> {
  if (!tokenValid(options.token)) throw new Error("Invalid pool capability.");
  let pool: SubscriptionWorkerPool | undefined;
  let ready = false;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!authorize(request.headers.authorization, options.token)) { response.writeHead(401).end(); return; }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: ready, seatCount: 8, routing: "new-workers-only" })); return;
    }
    if (!ready || !pool) { response.writeHead(503).end(); return; }
    if (request.method === "GET" && request.url === "/accounts") {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      try {
        const accounts = await pool.accounts(abort.signal);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(accounts));
      } catch { response.writeHead(503).end(); }
      return;
    }
    const scope = request.headers["x-factory-worker-scope"];
    if (!tokenValid(scope)) { response.writeHead(403).end(); return; }
    if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(405).end(); return; }
    const mcp = createPoolMcp(pool, scope, options.enabled ?? true);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void transport.close(); void mcp.close(); });
    try {
      const value = await body(request, 1024 * 1024);
      await mcp.connect(transport);
      await transport.handleRequest(request, response, value);
    } catch {
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      if (!response.writableEnded) response.end('{"error":"Invalid local pool request"}');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, "127.0.0.1", resolve); });
  let control: HttpServer;
  try { pool = factory(); control = await startPoolControl(pool, options.controlFile); ready = true; }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { server, control, pool, close: async () => {
    ready = false;
    await Promise.all([server, control].map(item => new Promise<void>((resolve, reject) => item.close(error => error ? reject(error) : resolve()))));
  } };
}
