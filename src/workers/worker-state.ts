import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SubscriptionProfile } from "../runtime/desktop-jobs.js";

export const WORKER_STATES = ["queued", "starting", "running", "waiting_approval", "result_ready", "cleaning", "completed", "failed", "cancelled", "unknown"] as const;
export type WorkerState = typeof WORKER_STATES[number];
export type WorkerWorkflow = "implement" | "investigate" | "release-prepare";
export interface WorkerStartInput {
  repository: string;
  task: string;
  workflow: WorkerWorkflow;
  operationId?: string;
  operationOwner?: string;
}
export interface WorkerOperation {
  id: string;
  owner: string;
  requestDigest: string;
}
export interface WorkerRecord {
  version: 1;
  id: string;
  state: WorkerState;
  operation?: WorkerOperation;
  /** The model outcome remains separate from process and lease settlement. */
  resultState?: "completed" | "failed" | "cancelled";
  leaseReleased?: boolean;
  settledAt?: string;
  executorLaunchRequested?: boolean;
  repository: string;
  worktree: string;
  branch: string;
  sourceCommit: string;
  sourceDirty: boolean;
  sourceKind?: "git" | "folder" | "unborn";
  inputCommit?: string;
  workingDirectory?: string;
  inputSnapshot?: { files: number; bytes: number; ignoredUntrackedFiles?: boolean; excluded: Array<{ path: string; reason: string }> };
  workflow: WorkerWorkflow;
  requested: { model: "claude-opus-5-5"; effort: "medium"; ultracode: true };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  sdkSessionId?: string;
  observedModels: string[];
  children?: Array<{ id: string; state: "running" | "completed" | "failed" | "cancelled" }>;
  result?: string;
  error?: string;
  failure?: { stage: "workspace" | "admission" | "execution" | "cleanup" | "lease_release"; code: string; message: string };
  reason?: string;
  /** Sanitized capacity evidence from the native SDK, never prompt prose. */
  backoff?: { kind: "rate_limit" | "usage_limit" | "overloaded"; retryAfterSeconds: number };
  pendingApprovalCount: number;
  cleanupVerified: boolean | null;
  usage?: Record<string, unknown>;
  billingEstimate?: Record<string, unknown>;
  checkEvidence: Array<{ toolUseId: string; status: "succeeded" | "failed"; commandSha256: string }>;
  authentication?: "anthropic" | "openrouter" | "subscription";
  subscriptionProfile?: SubscriptionProfile;
}

export function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("Worker directories must be absolute.");
  const absolute = resolve(path);
  for (let current = absolute; ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Worker directories must not contain symlinks."); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    if (dirname(current) === current) break;
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Worker directories must be private and owned by this user.");
  return realpathSync(absolute);
}

export function workerId(value: string): string {
  if (!/^worker-[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid worker ID.");
  return value;
}

export function writeWorker(root: string, value: WorkerRecord): void {
  const target = join(root, workerId(value.id) + ".json");
  try { if (lstatSync(target).isSymbolicLink()) throw new Error("Unsafe worker state path."); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  const temporary = join(root, ".worker-" + randomUUID());
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, target);
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temporary, { force: true }); }
}

export function readWorkers(root: string): WorkerRecord[] {
  const records: WorkerRecord[] = [];
  for (const file of readdirSync(root)) {
    if (!/^worker-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const path = join(root, file), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 2 * 1024 * 1024) throw new Error("Unsafe worker state file.");
    let value: WorkerRecord;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Malformed worker state file."); }
    if (value.version !== 1 || value.id + ".json" !== file || !WORKER_STATES.includes(value.state)) throw new Error("Invalid worker state record.");
    if (value.operation && (!validOperationId(value.operation.id) || !/^[a-f0-9]{64}$/.test(value.operation.owner)
        || !/^[a-f0-9]{64}$/.test(value.operation.requestDigest))) throw new Error("Invalid worker operation record.");
    records.push(value);
  }
  return records;
}

export function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}

export function writeWorkerTask(root: string, id: string, task: string): void {
  const path = join(root, ".pending-task-" + workerId(id) + ".json");
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ version: 1, id, task }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readWorkerTask(root: string, id: string): string | undefined {
  const path = join(root, ".pending-task-" + workerId(id) + ".json");
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 512_000) throw new Error("Unsafe pending worker task.");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || value.id !== id || typeof value.task !== "string" || !value.task.trim() || value.task.length > 100_000) throw new Error("Invalid pending worker task.");
  return value.task;
}

export function removeWorkerTask(root: string, id: string): void {
  rmSync(join(root, ".pending-task-" + workerId(id) + ".json"), { force: true });
}
