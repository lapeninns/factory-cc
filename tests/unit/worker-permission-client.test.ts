import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWorkerApproval, readPendingWorkerApprovals } from "../../src/runtime/worker-permission-client.js";

const worker = "worker-00000000-0000-0000-0000-000000000001";
const approval = { id: "approval-1", toolName: "Bash", input: { command: "echo fixture" } };
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function fixture(options: { pendingId?: string; decisionStatus?: number } = {}) {
  const received: Array<{ path: string; authorization?: string; body?: any }> = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    received.push({ path: request.url!, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") response.end(JSON.stringify({ id: options.pendingId ?? worker, approvals: [approval] }));
    else { response.statusCode = options.decisionStatus ?? 200; response.end(JSON.stringify({ ok: response.statusCode === 200, decision: raw ? JSON.parse(raw).decision : "deny" })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); servers.push(server);
  const address = server.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), "worker-control-client-")), path = join(root, "control.json");
  writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: "a".repeat(64) }), { mode: 0o600 });
  return { path, root, received };
}

it("reads the exact trusted worker and submits its full digest-bound action", async () => {
  const { path, received } = await fixture(); const signal = new AbortController().signal;
  const pending = await readPendingWorkerApprovals(path, worker, signal);
  expect(pending).toEqual([approval]);
  await decideWorkerApproval(path, worker, pending[0], "allow", signal);
  expect(received.map((item) => item.path)).toEqual([`/pending/${worker}`, "/decision"]);
  expect(received.every((item) => item.authorization === `Bearer ${"a".repeat(64)}`)).toBe(true);
  expect(received[1].body).toEqual({ id: worker, approvalId: approval.id, decision: "allow",
    actionDigest: createHash("sha256").update(JSON.stringify(approval.input)).digest("hex"), summary: `Bash: ${JSON.stringify(approval.input)}` });
});

it("rejects a response for a different worker without sending a decision", async () => {
  const { path, received } = await fixture({ pendingId: "other-worker" });
  await expect(readPendingWorkerApprovals(path, worker, new AbortController().signal)).rejects.toThrow("Invalid worker permission status");
  expect(received).toHaveLength(1);
});

it("rejects broad permissions and symlinks before accessing a control endpoint", async () => {
  const { path, root, received } = await fixture(); const signal = new AbortController().signal;
  chmodSync(path, 0o644);
  await expect(readPendingWorkerApprovals(path, worker, signal)).rejects.toThrow();
  chmodSync(path, 0o600); const link = join(root, "link.json"); symlinkSync(path, link);
  await expect(readPendingWorkerApprovals(link, worker, signal)).rejects.toThrow();
  expect(received).toHaveLength(0);
});

it("refuses remote or credential-bearing control URLs without fetching them", async () => {
  const { path, received } = await fixture();
  for (const url of ["https://example.invalid", "http://127.0.0.1:80/path", "http://name:pass@127.0.0.1", "http://127.0.0.1?key=value"]) {
    writeFileSync(path, JSON.stringify({ url, token: "a".repeat(64) }));
    await expect(readPendingWorkerApprovals(path, worker, new AbortController().signal)).rejects.toThrow();
  }
  expect(received).toHaveLength(0);
});

it("does not retry an unaccepted decision", async () => {
  const { path, received } = await fixture({ decisionStatus: 409 });
  await expect(decideWorkerApproval(path, worker, approval, "allow", new AbortController().signal)).rejects.toThrow("not accepted");
  expect(received).toHaveLength(1);
});

it("does not send an already-aborted decision", async () => {
  const { path, received } = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(decideWorkerApproval(path, worker, approval, "allow", controller.signal)).rejects.toThrow();
  expect(received).toHaveLength(0);
});
