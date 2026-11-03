import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { approvalSummary, MAX_WORKER_APPROVAL_SUMMARY_CHARS } from "../workers/approval.js";

export interface PendingWorkerApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

const validWorker = (value: unknown): value is string => typeof value === "string" && /^worker-[a-f0-9-]{36}$/.test(value);
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** The capability is read only from an owned private local file, never model text. */
function connection(path: string): { url: URL; token: string } {
  if (!isAbsolute(path)) throw new Error("Worker permission configuration must be absolute.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 16384) throw new Error();
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!object(value) || typeof value.url !== "string" || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error();
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return { url, token: value.token };
  } catch { throw new Error("Worker permission configuration is invalid or unsafe."); }
  finally { closeSync(fd); }
}

export async function readPendingWorkerApprovals(path: string, workerId: string, signal: AbortSignal): Promise<PendingWorkerApproval[]> {
  if (!validWorker(workerId)) throw new Error("Invalid worker identifier.");
  const { url, token } = connection(path);
  const response = await fetch(new URL(`/pending/${workerId}`, url), { headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error" });
  if (!response.ok) throw new Error("Worker permission status unavailable.");
  const text = await response.text();
  if (text.length > 128 * 1024) throw new Error("Worker permission status exceeds its bound.");
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.id !== workerId || !Array.isArray(value.approvals) || value.approvals.length > 16) throw new Error("Invalid worker permission status.");
  return value.approvals.map((item: unknown) => {
    if (!object(item) || !validId(item.id) || typeof item.toolName !== "string" || !item.toolName || item.toolName.length > 256 || !object(item.input)) throw new Error("Invalid pending worker permission.");
    const summary = approvalSummary({ toolName: item.toolName, input: item.input });
    if (summary.length > MAX_WORKER_APPROVAL_SUMMARY_CHARS) throw new Error("Worker action exceeds the reviewable bound.");
    return { id: item.id, toolName: item.toolName, input: structuredClone(item.input) };
  });
}

export async function decideWorkerApproval(path: string, workerId: string, approval: PendingWorkerApproval,
  decision: "allow" | "deny", signal: AbortSignal): Promise<void> {
  if (!validWorker(workerId) || !validId(approval.id) || !["allow", "deny"].includes(decision)) throw new Error("Invalid worker decision.");
  const { url, token } = connection(path);
  const action = JSON.stringify(approval.input);
  const response = await fetch(new URL("/decision", url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: workerId, approvalId: approval.id, actionDigest: createHash("sha256").update(action).digest("hex"),
      summary: approvalSummary(approval), decision }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error" });
  if (!response.ok) throw new Error("Worker decision was not accepted.");
  const value: unknown = await response.json();
  if (!object(value) || value.ok !== true || value.decision !== decision) throw new Error("Worker decision was not confirmed.");
}
