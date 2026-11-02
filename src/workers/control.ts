import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface ApprovalController {
  status(id: string): unknown;
  approve(input: { id: string; approvalId: string; decision: "allow" | "deny" }): unknown;
}
export function approvalDigest(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export function approvalSummary(approval: { toolName?: string; input: unknown }): string {
  return `${approval.toolName ?? "Worker action"}: ${JSON.stringify(approval.input)}`;
}

/** Separate from MCP tools so a model cannot grant its own approval with tools/call. */
export async function startWorkerControl(controller: ApprovalController, path: string): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return; }
    const pendingPath = request.url?.match(/^\/pending\/(worker-[a-f0-9-]{36})$/);
    if (request.method === "GET" && pendingPath) {
      try {
        const current = controller.status(pendingPath[1]!) as { approvals?: unknown[] };
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: pendingPath[1], approvals: current.approvals ?? [] }));
      } catch { response.writeHead(404).end(); }
      return;
    }
    if (request.method !== "POST" || request.url !== "/decision") { response.writeHead(404).end(); return; }
    try {
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error(); }
      const body = JSON.parse(raw);
      if (!body || typeof body.id !== "string" || typeof body.approvalId !== "string" || !["allow", "deny"].includes(body.decision) || typeof body.actionDigest !== "string") throw new Error();
      const status = controller.status(body.id) as { approvals?: Array<{ id: string; toolName?: string; input: unknown }> };
      const pending = status.approvals?.find(item => item.id === body.approvalId);
      if (!pending || approvalDigest(pending.input) !== body.actionDigest) { response.writeHead(409).end(); return; }
      const summary = approvalSummary(pending);
      if (body.summary !== summary || summary.length > 4000) { response.writeHead(409).end(); return; }
      controller.approve({ id: body.id, approvalId: body.approvalId, decision: body.decision });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, decision: body.decision }));
    } catch { response.writeHead(400).end(JSON.stringify({ ok: false })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Control listener unavailable.");
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    const previous = lstatSafe(path);
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.mode & 0o077 || (process.getuid && previous.uid !== process.getuid()))) throw new Error("Unsafe control configuration path.");
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }) + "\n"); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  } finally { rmSync(temporary, { force: true }); }
  return { close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function lstatSafe(path: string) { try { return lstatSync(path); } catch { return undefined; } }

export async function sendWorkerDecision(path: string, input: { id: string; approvalId: string; actionDigest: string; summary: string; decision: "allow" | "deny" }): Promise<{ ok: true }> {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()) || info.size > 16384) throw new Error("Unsafe private control configuration.");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const url = new URL(config.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid local control configuration.");
  const response = await fetch(new URL("/decision", url), { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("Decision was not accepted; refresh the worker state before retrying.");
  return { ok: true };
}
