import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createWorkerMcp, type WorkerController } from "./mcp.js";

/** One worker controller is shared across all Factory MCP client connections. */
export async function serveWorkerMcp(controller: WorkerController, options: { port: number; token: string; approvalCommand?: string; ready?: () => boolean }): Promise<Server> {
  const server = createServer(async (request, response) => {
    const expected = Buffer.from(`Bearer ${options.token}`), actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) { response.writeHead(401).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    const ready = options.ready?.() ?? true;
    if (request.method === "GET" && request.url === "/health") { response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: ready })); return; }
    if (!ready) { response.writeHead(503).end(); return; }
    if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(405).end(); return; }
    const mcp = createWorkerMcp(controller, { approvalCommand: options.approvalCommand });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void transport.close(); void mcp.close(); });
    try {
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error(); }
      await mcp.connect(transport);
      await transport.handleRequest(request, response, JSON.parse(raw));
    } catch {
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      if (!response.writableEnded) response.end('{"error":"Invalid local worker request"}');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, "127.0.0.1", resolve); });
  return server;
}

/** Bind the singleton boundary before any state-recovering constructor runs. */
export async function startWorkerMcp<T extends WorkerController>(factory: () => T, options: { port: number; token: string; approvalCommand?: string }): Promise<{ server: Server; controller: T }> {
  let controller: T | undefined;
  const proxy: WorkerController = {
    start: input => controller!.start(input), status: id => controller!.status(id),
    list: () => controller!.list(), cancel: id => controller!.cancel(id),
  };
  const server = await serveWorkerMcp(proxy, { ...options, ready: () => controller !== undefined });
  try { controller = factory(); return { server, controller }; }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
}
