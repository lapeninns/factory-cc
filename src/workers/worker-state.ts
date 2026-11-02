import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const WORKER_STATES = ["queued", "starting", "running", "waiting_approval", "completed", "failed", "cancelled", "unknown"] as const;
export type WorkerState = typeof WORKER_STATES[number];
export type WorkerWorkflow = "implement" | "investigate" | "release-prepare";
export interface WorkerRecord {
  version: 1;
  id: string;
  state: WorkerState;
  repository: string;
  worktree: string;
  branch: string;
  sourceCommit: string;
  sourceDirty: boolean;
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
  reason?: string;
  pendingApprovalCount: number;
  cleanupVerified: boolean | null;
  usage?: Record<string, unknown>;
  billingEstimate?: Record<string, unknown>;
  checkEvidence: Array<{ toolUseId: string; status: "succeeded" | "failed"; commandSha256: string }>;
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
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); } finally { closeSync(fd); }
  renameSync(temporary, target);
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
    records.push(value);
  }
  return records;
}
