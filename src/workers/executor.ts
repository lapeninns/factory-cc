import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants, closeSync, chmodSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerView } from "./service.js";
import { privateDirectory, workerId } from "./worker-state.js";

interface ExecutorRequest {
  version: 1;
  workerId: string;
  stateRoot: string;
  configFile: string;
  task: string;
  socketPath: string;
  token: string;
  entrypoint: string;
  entrypointSha256: string;
}

interface ExecutorReceipt {
  version: 1;
  workerId: string;
  pid: number;
  group: number;
  started: string;
  socketPath: string;
  token: string;
  entrypoint: string;
  entrypointSha256: string;
}

export interface WorkerExecutorController {
  status(): WorkerView;
  start(): Promise<void>;
  cancel(): Promise<unknown>;
  approve(input: { id: string; approvalId: string; decision: "allow" | "deny" }): Promise<unknown> | unknown;
}

export interface WorkerExecutorLaunch {
  stateRoot: string;
  workerId: string;
  configFile: string;
  task: string;
  /** An immutable compiled entry point in production; injectable for subprocess fixtures. */
  entrypoint?: string;
  startupTimeoutMs?: number;
}

const terminal = new Set(["completed", "failed", "cancelled"]);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const delay = (ms: number): Promise<void> => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

function paths(root: string, id: string) {
  if (!isAbsolute(root)) throw new Error("An absolute executor state directory is required.");
  const directory = join(root, "executors", workerId(id));
  return { directory, request: join(directory, "request.json"), receipt: join(directory, "receipt.json"), view: join(directory, "view.json") };
}

function readPrivate(path: string, limit = 2 * 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > limit) throw new Error("Unsafe executor file.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = path + "." + randomBytes(12).toString("hex");
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temporary, { force: true }); }
}

function processIdentity(pid: number): { pid: number; group: number; started: string } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (/^[ZX]$/.test(fields[0]!)) return;
      return { pid, group: Number(fields[2]), started: fields[19]! };
    }
    if (process.platform !== "darwin") return;
    const text = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart=,stat="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)/.exec(text);
    if (!match || /^[ZX]/.test(match[4]!)) return;
    return { pid: Number(match[1]), group: Number(match[2]), started: match[3]! };
  } catch { return; }
}

function readReceipt(root: string, id: string): ExecutorReceipt | undefined {
  try {
    if (realpathSync(root) !== resolve(root)) return;
    for (const directory of [root, join(root, "executors"), paths(root, id).directory]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) return;
    }
    const value = JSON.parse(readPrivate(paths(root, id).receipt)) as ExecutorReceipt;
    if (value.version !== 1 || value.workerId !== id || !Number.isSafeInteger(value.pid) || value.pid <= 1
        || !Number.isSafeInteger(value.group) || value.group <= 0 || typeof value.started !== "string"
        || typeof value.socketPath !== "string" || dirname(value.socketPath) !== socketDirectory()
        || !/^[a-f0-9]{32}\.sock$/.test(value.socketPath.slice(socketDirectory().length + 1))
        || !/^[a-f0-9]{64}$/.test(value.token) || !isAbsolute(value.entrypoint)
        || !/^[a-f0-9]{64}$/.test(value.entrypointSha256)
        || digest(readFileSync(value.entrypoint)) !== value.entrypointSha256) return;
    return value;
  } catch { return; }
}

function socketDirectory(): string {
  return join(realpathSync("/tmp"), "factory-executors-" + process.getuid!());
}

function alive(receipt: ExecutorReceipt): boolean {
  const current = processIdentity(receipt.pid);
  return !!current && current.group === receipt.group && current.started === receipt.started;
}

/** Reads private snapshots only. A stale process identity never authorizes control of a reused PID. */
export function workerExecutorStatus(root: string, id: string): WorkerView | undefined {
  try {
    const receipt = readReceipt(root, id);
    if (!receipt) return;
    const value = JSON.parse(readPrivate(paths(root, id).view)) as WorkerView;
    if (value.id !== id || !Array.isArray(value.approvals)) return;
    if (terminal.has(value.state) && value.cleanupVerified === true && value.leaseReleased !== false) return value;
    if (alive(receipt)) return value;
    return { ...value, state: "unknown", reason: "executor_process_unavailable", cleanupVerified: null, pendingApprovalCount: 0, approvals: [] };
  } catch { return; }
}

export async function callWorkerExecutor(root: string, id: string, action: "start" | "status" | "cancel" | "approve", input?: unknown): Promise<WorkerView> {
  const receipt = readReceipt(root, id);
  if (!receipt || !alive(receipt)) throw new Error("Worker executor ownership is unavailable.");
  const socket = lstatSync(receipt.socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || socket.mode & 0o077) throw new Error("Worker executor socket is unsafe.");
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ socketPath: receipt.socketPath, path: "/" + action, method: "POST",
      headers: { authorization: "Bearer " + receipt.token, "content-type": "application/json" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) outgoing.destroy(new Error("Executor response exceeds its bound.")); });
      response.once("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Worker executor operation was not accepted.");
          const value = JSON.parse(body) as WorkerView;
          if (value.id !== id || !Array.isArray(value.approvals)) throw new Error("Worker executor identity mismatch.");
          resolveResponse(value);
        } catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    outgoing.setTimeout(action === "cancel" ? 60_000 : 10_000, () => outgoing.destroy(new Error("Worker executor response timed out.")));
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(input ?? {}));
  });
}

/** Launches once, records ownership before opening the execution gate, and survives frontend death. */
export async function launchWorkerExecutor(options: WorkerExecutorLaunch): Promise<WorkerView> {
  const root = privateDirectory(options.stateRoot);
  const path = paths(root, options.workerId);
  privateDirectory(path.directory);
  if (existsSync(path.receipt) || existsSync(path.request)) throw new Error("This worker already has an executor launch record.");
  const source = fileURLToPath(import.meta.url).endsWith(".ts");
  const entrypoint = realpathSync(options.entrypoint ?? fileURLToPath(new URL(`../../scripts/worker-executor.${source ? "ts" : "js"}`, import.meta.url)));
  if (!isAbsolute(options.configFile) || !options.task.trim() || options.task.length > 100_000) throw new Error("Invalid worker executor request.");
  const socketRoot = privateDirectory(socketDirectory());
  const socketPath = join(socketRoot, digest(root + options.workerId + randomBytes(16).toString("hex")).slice(0, 32) + ".sock");
  const input: ExecutorRequest = { version: 1, workerId: options.workerId, stateRoot: root, configFile: options.configFile,
    task: options.task, socketPath, token: randomBytes(32).toString("hex"), entrypoint, entrypointSha256: digest(readFileSync(entrypoint)) };
  const fd = openSync(path.request, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(input) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(path.directory, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const args = entrypoint.endsWith(".ts") ? ["--import", createRequire(import.meta.url).resolve("tsx"), entrypoint, path.request] : [entrypoint, path.request];
  const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME"].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  const child = spawn(process.execPath, args, { env, detached: true, stdio: "ignore" });
  let error: Error | undefined;
  child.once("error", value => { error = value; });
  child.unref();
  const until = Date.now() + (options.startupTimeoutMs ?? 15_000);
  while (Date.now() < until) {
    if (error) throw error;
    const receipt = readReceipt(root, options.workerId);
    if (receipt) {
      if (receipt.pid !== child.pid || !alive(receipt)) throw new Error("Worker executor launch identity mismatch.");
      return callWorkerExecutor(root, options.workerId, "start");
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Worker executor exited before acknowledging ownership.");
    await delay(25);
  }
  // Never relaunch or kill an uncertain PID. Its unopened gate expires in the child.
  throw new Error("Worker executor launch was not confirmed.");
}

/** Child entry point. The controller owns native callbacks independently of the HTTP frontend. */
export async function runWorkerExecutor(requestPath: string, createController: (configFile: string, id: string, task: string) => Promise<WorkerExecutorController>, options: { gateTimeoutMs?: number; snapshotMs?: number } = {}): Promise<void> {
  const input = JSON.parse(readPrivate(requestPath)) as ExecutorRequest;
  if (input.version !== 1 || typeof input.task !== "string" || !input.task.trim() || input.task.length > 100_000
      || !isAbsolute(input.configFile) || !isAbsolute(input.stateRoot) || !isAbsolute(input.socketPath)
      || !/^[a-f0-9]{64}$/.test(input.token) || !isAbsolute(input.entrypoint)
      || digest(readFileSync(input.entrypoint)) !== input.entrypointSha256) throw new Error("Invalid executor launch record.");
  const root = privateDirectory(input.stateRoot), path = paths(root, input.workerId);
  if (resolve(requestPath) !== path.request) throw new Error("Executor launch path mismatch.");
  const socketRoot = privateDirectory(socketDirectory());
  if (dirname(input.socketPath) !== socketRoot || !/^[a-f0-9]{32}\.sock$/.test(input.socketPath.slice(socketRoot.length + 1))) throw new Error("Invalid executor socket path.");
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error("Executor process identity is unavailable.");
  const controller = await createController(input.configFile, input.workerId, input.task);
  let lastView = "", started = false, finishing: Promise<void> | undefined, execution: Promise<void> | undefined;
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const snapshot = (): WorkerView => {
    const view = controller.status();
    if (view.id !== input.workerId) throw new Error("Executor controller identity mismatch.");
    const encoded = JSON.stringify(view);
    if (encoded !== lastView) { atomicWrite(path.view, view); lastView = encoded; }
    return view;
  };
  let server: Server;
  const finish = (): Promise<void> => finishing ??= (async () => {
    clearTimeout(gate); clearInterval(interval);
    try { snapshot(); } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(input.socketPath, { force: true });
      resolveFinished();
    }
  })();
  server = createServer(async (incoming, response) => {
    const expected = Buffer.from("Bearer " + input.token), actual = Buffer.from(incoming.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    try {
      if (incoming.method !== "POST") { response.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of incoming) { body += chunk; if (Buffer.byteLength(body) > 16_384) throw new Error("Executor request is too large."); }
      const value = JSON.parse(body || "{}");
      if (incoming.url === "/start") {
        if (!started) {
          started = true; clearTimeout(gate);
          // Begin after this response so the acknowledgement identifies one opened gate.
          execution = new Promise<void>(resolve => setImmediate(resolve)).then(() => controller.start());
          void execution.finally(finish).catch(() => undefined);
        }
      } else if (incoming.url === "/cancel") await controller.cancel();
      else if (incoming.url === "/approve") {
        if (!value || value.id !== input.workerId || typeof value.approvalId !== "string" || !["allow", "deny"].includes(value.decision)) throw new Error("Invalid executor approval.");
        await controller.approve(value);
      } else if (incoming.url !== "/status") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(snapshot()));
    } catch { response.writeHead(409).end(JSON.stringify({ error: "executor_operation_failed" })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socketPath, resolve); });
  chmodSync(input.socketPath, 0o600);
  snapshot();
  atomicWrite(path.receipt, { version: 1, workerId: input.workerId, ...identity, socketPath: input.socketPath, token: input.token,
    entrypoint: input.entrypoint, entrypointSha256: input.entrypointSha256 } satisfies ExecutorReceipt);
  rmSync(requestPath);
  const cancelAndFinish = (): void => { void controller.cancel().finally(finish).catch(() => undefined); };
  const interval = setInterval(() => { try { snapshot(); } catch { cancelAndFinish(); } }, options.snapshotMs ?? 1000);
  const gate = setTimeout(() => { if (!started) cancelAndFinish(); }, options.gateTimeoutMs ?? 30_000);
  const stop = (): void => { cancelAndFinish(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await finished;
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
}
