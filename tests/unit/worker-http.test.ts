import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveWorkerMcp, startWorkerMcp } from "../../src/workers/http.js";

describe("shared worker daemon", () => {
  it("rejects a duplicate daemon before constructing or recovering any worker state", async () => {
    let constructed = 0;
    const factory = () => { constructed++; return { start: async () => ({}), status: () => ({}), list: () => [], cancel: async () => ({}) }; };
    const first = await startWorkerMcp(factory, { port: 0, token: "fixture" });
    const address = first.server.address(); if (!address || typeof address === "string") throw new Error();
    try {
      await expect(startWorkerMcp(factory, { port: address.port, token: "fixture" })).rejects.toThrow();
      expect(constructed).toBe(1);
    } finally { await new Promise<void>(resolve => first.server.close(() => resolve())); }
  });
  it("keeps one controller across separate Factory clients and rejects unauthenticated requests", async () => {
    const workers = new Map<string, unknown>();
    const controller = { start: async () => { const item = { id: "worker-test", state: "queued" }; workers.set(item.id, item); return item; },
      status: (id: string) => workers.get(id), list: () => [...workers.values()], cancel: async () => ({ state: "cancelled" }) };
    const server = await serveWorkerMcp(controller, { port: 0, token: "fixture-only" });
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const url = `http://127.0.0.1:${address.port}`;
    const clients = [new Client({ name: "one", version: "1" }), new Client({ name: "two", version: "1" })];
    try {
      expect((await fetch(url + "/health")).status).toBe(401);
      for (const client of clients) await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { authorization: "Bearer fixture-only" } } }));
      await clients[0]!.callTool({ name: "factory_worker_start", arguments: { repository: "/repo", task: "fixture" } });
      expect(JSON.stringify(await clients[1]!.callTool({ name: "factory_worker_status", arguments: { id: "worker-test" } }))).toContain("worker-test");
      expect(workers.size).toBe(1);
    } finally {
      for (const client of clients) await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
