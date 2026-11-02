import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPoolBackends, poolClientToken, readPoolConfig, SubscriptionWorkerPool } from "../src/workers/pool.js";
import { startPoolServer } from "../src/workers/pool-http.js";

export async function runSubscriptionPool(argv = process.argv.slice(2)): Promise<void> {
  const check = argv.includes("--check"), serve = argv.includes("--serve");
  const args = argv.filter(value => value !== "--check" && value !== "--serve");
  if (check && serve || args.length !== 2 || args[0] !== "--config") throw new Error("Use --config /absolute/private/config.json [--serve|--check].");
  const config = readPoolConfig(args[1]!);
  const token = poolClientToken(config);
  const backends = createPoolBackends(config);
  if (check) {
    console.log(JSON.stringify({ configured: true, enabled: config.enabled, authentication: "subscription", seatCount: backends.length,
      profiles: backends.map(item => item.profile), modelRequestsMade: false, apiCredentialsUsed: false }));
    return;
  }
  if (!serve) {
    // Every stdio adapter has a private lifetime scope. Reconnecting creates a new
    // scope; old workers remain pinned and require operator recovery if orphaned.
    const scope = randomBytes(32).toString("hex");
    const client = new Client({ name: "factory-subscription-pool-adapter", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + config.port + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + token, "x-factory-worker-scope": scope }, redirect: "error" },
    }), { timeout: 5000 });
    const proxy = new Server({ name: "factory-subscription-pool", version: "1.0.0" }, {
      capabilities: { tools: {} },
      instructions: "Use factory_worker_start for independent tasks. This connection distributes new workers across eight subscription accounts and keeps each worker pinned. Poll status/wait for completion or human approval. Never retry an unknown start automatically.",
    });
    proxy.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
    proxy.setRequestHandler(CallToolRequestSchema, (request, extra) => client.callTool(request.params, undefined, { signal: extra.signal, timeout: 120_000 }));
    process.stdin.once("end", () => { void client.close(); void proxy.close(); });
    await proxy.connect(new StdioServerTransport());
    return;
  }
  const running = await startPoolServer(() => new SubscriptionWorkerPool(config.stateRoot, backends), {
    port: config.port, token, controlFile: join(config.stateRoot, "approval-control.json"), enabled: config.enabled,
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void running.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  console.log(JSON.stringify({ ready: true, port: config.port, authentication: "subscription", seatCount: 8, modelRequestsMade: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runSubscriptionPool().catch(() => { console.error("Subscription pool startup failed. Check its private configuration and fixed worker services; no API fallback or start replay was used."); process.exitCode = 1; });
}
