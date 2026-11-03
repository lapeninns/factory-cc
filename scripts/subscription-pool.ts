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
import { factorySessionIdentity, factoryWorkerScope } from "../src/workers/factory-owner.js";

export async function runSubscriptionPool(argv = process.argv.slice(2)): Promise<void> {
  const check = argv.includes("--check"), serve = argv.includes("--serve"), factorySessionScope = argv.includes("--factory-session-scope");
  const args = argv.filter(value => !["--check", "--serve", "--factory-session-scope"].includes(value));
  if (check && serve || factorySessionScope && serve || args.length !== 2 || args[0] !== "--config") {
    throw new Error("Use --config /absolute/private/config.json [--serve|--check] [--factory-session-scope].");
  }
  const config = readPoolConfig(args[1]!);
  const token = poolClientToken(config);
  const backends = createPoolBackends(config);
  if (check) {
    console.log(JSON.stringify({ configured: true, enabled: config.enabled, authentication: "subscription", seatCount: backends.length,
      profiles: backends.map(item => item.profile), modelRequestsMade: false, apiCredentialsUsed: false }));
    return;
  }
  if (!serve) {
    // Generic MCP clients retain their original connection-lifetime scope.
    // Factory mode obtains ownership from each host-authored tool request.
    const scope = randomBytes(32).toString("hex");
    const connections = new Set<Client>();
    const connect = async (ownerScope: string, signal?: AbortSignal): Promise<Client> => {
      const value = new Client({ name: "factory-subscription-pool-adapter", version: "1.0.0" });
      connections.add(value);
      try {
        await value.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + config.port + "/mcp"), {
          requestInit: { headers: { authorization: "Bearer " + token, "x-factory-worker-scope": ownerScope }, redirect: "error" },
        }), { timeout: 5000, signal });
        return value;
      } catch (error) {
        connections.delete(value); await value.close().catch(() => {}); throw error;
      }
    };
    const client = await connect(scope);
    const proxy = new Server({ name: "factory-subscription-pool", version: "1.0.0" }, {
      capabilities: { tools: {} },
      instructions: "Use factory_worker_start for independent tasks. This connection distributes new workers across eight subscription accounts and keeps each worker pinned. Poll status/wait for completion or human approval. Never retry an unknown start automatically."
        + (factorySessionScope ? " Worker ownership follows the Factory Workstream across reconnections. List its existing workers before starting replacement work." : ""),
    });
    proxy.setRequestHandler(ListToolsRequestSchema, async () => {
      const result = await client.listTools();
      if (!factorySessionScope) return result;
      return { ...result, tools: result.tools.map(tool => tool.name === "factory_worker_list"
        ? { ...tool, description: "List workers owned by this Factory Workstream, including workers retained across reconnections." } : tool) };
    });
    proxy.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!factorySessionScope) return client.callTool(request.params, undefined, { signal: extra.signal, timeout: 120_000 });
      let ownerScope: string;
      try {
        ownerScope = factoryWorkerScope(token, factorySessionIdentity(request.params._meta));
      } catch {
        return { isError: true, content: [{ type: "text", text: "Factory worker ownership requires valid host session metadata. Reconnect this Workstream before using its workers." }] };
      }
      const owned = await connect(ownerScope, extra.signal);
      try {
        const { _meta, ...params } = request.params;
        const { assemblySessionId: _sessionId, caller: _caller, ...remainingMeta } = _meta ?? {};
        return await owned.callTool({ ...params, ...(Object.keys(remainingMeta).length ? { _meta: remainingMeta } : {}) }, undefined,
          { signal: extra.signal, timeout: 120_000 });
      } finally {
        connections.delete(owned); await owned.close().catch(() => {});
      }
    });
    process.stdin.once("end", () => { for (const connection of connections) void connection.close(); void proxy.close(); });
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
