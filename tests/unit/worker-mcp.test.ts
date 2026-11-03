import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkerMcp } from "../../src/workers/mcp.js";
import { WorkerStartRejected } from "../../src/workers/start-rejection.js";

describe("Factory supervised worker MCP", () => {
  it("exposes scoped worker operations and no self-approval tool", async () => {
    const controller = { start: async (input: unknown) => ({ id: "worker-test", state: "queued", input }),
      status: (id: string) => ({ id, state: "completed", result: "fixture result" }),
      list: () => [], cancel: async (id: string) => ({ id, state: "cancelled" }) };
    const server = createWorkerMcp(controller), client = new Client({ name: "fixture", version: "1" });
    const [host, peer] = InMemoryTransport.createLinkedPair();
    await server.connect(peer); await client.connect(host);
    try {
      const catalog = await client.listTools();
      expect(catalog.tools.map(tool => tool.name)).toEqual(["factory_worker_start", "factory_worker_status", "factory_worker_wait", "factory_worker_list", "factory_worker_cancel"]);
      const started = await client.callTool({ name: "factory_worker_start", arguments: { repository: "/repo", task: "bounded fixture", workflow: "investigate" } });
      expect(JSON.stringify(started)).toContain("worker-test");
      const complete = await client.callTool({ name: "factory_worker_status", arguments: { id: "worker-test" } });
      expect(JSON.stringify(complete)).toContain("fixture result");
      const invalid = await client.callTool({ name: "factory_worker_start", arguments: { repository: "/repo", task: "fixture", workflow: "unknown" } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it("exposes only bounded pre-execution rejections and keeps post-start errors uncertain", async () => {
    let mode = "preflight";
    const controller = {
      start: async () => {
        if (mode === "preflight") throw new WorkerStartRejected("subscription_preflight_failed", "private account detail");
        if (mode === "generic") throw new Error("private transport detail");
        return { toJSON: () => { throw new WorkerStartRejected("repository_rejected", "serialization after start"); } };
      },
      status: () => ({}), list: () => [], cancel: async () => ({}),
    };
    const server = createWorkerMcp(controller), client = new Client({ name: "fixture", version: "1" });
    const [host, peer] = InMemoryTransport.createLinkedPair();
    await server.connect(peer); await client.connect(host);
    try {
      const request = { name: "factory_worker_start", arguments: { repository: "/repo", task: "fixture" } };
      const rejected = await client.callTool(request);
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([{ type: "text", text: JSON.stringify({ type: "worker_start_rejected", code: "subscription_preflight_failed", executionStarted: false }) }]);
      for (const next of ["generic", "serialization"]) {
        mode = next;
        const result = await client.callTool(request);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("worker_start_rejected");
        expect(JSON.stringify(result)).not.toContain("private");
      }
    } finally { await client.close(); await server.close(); }
  });

});
