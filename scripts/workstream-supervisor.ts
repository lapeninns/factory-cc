import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { nativeStartRejection, superviseWorkstream, uuid, type SupervisorObservation, type SupervisorPolicy, type SupervisorState } from "../src/runtime/workstream-supervisor.js";

export interface SupervisorConfig {
  targetSessionId: string;
  controllerUrl: string;
  controllerDataDir: string;
  poolConfigFile: string;
  factorySessionsDir: string;
  factoryLogsDir: string;
  automationsDir: string;
  watchedAutomation: string;
  retryAutomation: string;
  stateDir: string;
  recoveryEnabled: boolean;
  expectedModelId: string;
  notificationExecutable?: string;
}
const time = (value: unknown): number | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const safeSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{2,90}$/.test(s);
export function ownedDirectory(path: string): void {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw Error("Noncanonical directory");
  const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== process.getuid?.()) throw Error("Unowned directory");
}
export function readOwned(path: string, maxBytes = 512 * 1024, tail = false): string {
  ownedDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (!tail && s.size > maxBytes)) throw Error("Unsafe file");
    const length = Math.min(s.size, maxBytes), buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, s.size - length);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
}
export function atomicOwned(path: string, text: string): void {
  ownedDirectory(dirname(path));
  if (existsSync(path)) readOwned(path, 4 * 1024 * 1024);
  const temporary = path + `.writing-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
export function validateConfig(c: SupervisorConfig): void {
  if (!uuid(c.targetSessionId) || !safeSlug(c.watchedAutomation) || !safeSlug(c.retryAutomation) || c.watchedAutomation === c.retryAutomation || typeof c.recoveryEnabled !== "boolean" || !c.expectedModelId?.startsWith("custom:")) throw Error("Invalid supervisor configuration");
  if (c.notificationExecutable && !["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].includes(c.notificationExecutable)) throw Error("Unsupported notification executable");
  const url = new URL(c.controllerUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Controller must be loopback");
  for (const p of [c.controllerDataDir, c.factorySessionsDir, c.factoryLogsDir, c.automationsDir, c.stateDir]) ownedDirectory(p);
}
export function verifyTarget(c: SupervisorConfig): void {
  // Identity comes only from the owned top-level native settings, never transcript content.
  const matches: string[] = [];
  for (const entry of readdirSync(c.factorySessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(c.factorySessionsDir, entry.name, `${c.targetSessionId}.settings.json`);
    if (existsSync(file)) matches.push(file);
  }
  if (matches.length !== 1) throw Error("Ambiguous or missing target settings");
  const settings = JSON.parse(readOwned(matches[0]!));
  const tags = settings.tags?.filter((t: { name?: string }) => t?.name === "mission-v2");
  if (tags?.length !== 1 || tags[0].metadata?.missionId !== c.targetSessionId || tags[0].metadata?.kind !== "orchestrator" || settings.model !== c.expectedModelId) throw Error("Target is not the selected native bridge orchestrator");
}
function workstreamMembership(c: SupervisorConfig): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  const parents = new Map<string, string>();
  for (const dir of readdirSync(c.factorySessionsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(c.factorySessionsDir, dir.name), { withFileTypes: true })) {
      const id = file.name.replace(/\.settings\.json$/, "");
      if (!file.isFile() || !file.name.endsWith(".settings.json") || !uuid(id)) continue;
      try {
        const d = JSON.parse(readOwned(join(c.factorySessionsDir, dir.name, file.name)));
        const tags = d.tags?.filter((t: { name?: string }) => t?.name === "mission-v2");
        const mission = tags?.length === 1 && ["orchestrator", "agent"].includes(tags[0].metadata?.kind) && uuid(tags[0].metadata?.missionId) ? tags[0].metadata.missionId : undefined;
        const duplicate = map.has(id);
        map.set(id, duplicate ? undefined : mission);
        const parentTags = d.tags?.filter((t: { name?: string }) => t?.name === "subagent");
        if (!duplicate && !mission && parentTags?.length === 1 && uuid(parentTags[0].metadata?.callingSessionId)) parents.set(id, parentTags[0].metadata.callingSessionId);
        if (duplicate) parents.delete(id);
      } catch { map.set(id, undefined); }
    }
  }
  const resolveMission = (id: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(id) || seen.size >= 32) return;
    const mission = map.get(id);
    if (mission) return mission;
    seen.add(id);
    const parent = parents.get(id);
    return parent ? resolveMission(parent, seen) : undefined;
  };
  for (const id of parents.keys()) map.set(id, resolveMission(id));
  return map;
}
function receipt(c: SupervisorConfig, slug: string) {
  const p = join(c.automationsDir, slug, "memory/state.json");
  if (!existsSync(p)) return;
  const d = JSON.parse(readOwned(p));
  const at = time(d.lastRunAt);
  if (at === undefined || typeof d.lastRunId !== "string" || d.lastRunSessionId !== c.targetSessionId) return;
  return { id: d.lastRunId, at };
}
function jsonLines(file: string): Record<string, any>[] {
  if (!existsSync(file)) return [];
  return readOwned(file, 8 * 1024 * 1024, true).split("\n").filter(l => l.length <= 256 * 1024).flatMap(l => {
    try { const d = JSON.parse(l); return d && typeof d === "object" && !Array.isArray(d) ? [d] : []; } catch { return []; }
  });
}
async function bridgeJson(c: SupervisorConfig, route: string) {
  const token = readOwned(join(c.controllerDataDir, "admin-token")).trim();
  const response = await fetch(new URL(route, c.controllerUrl), { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error("Bridge observation unavailable");
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw Error("Oversized bridge observation");
  return JSON.parse(text);
}
async function accountObservation(c: SupervisorConfig, assigned: string | undefined) {
  if (!assigned) throw Error("Cannot verify assigned account");
  const pool = JSON.parse(readOwned(c.poolConfigFile));
  if (!Number.isSafeInteger(pool.port) || pool.port < 1 || pool.port > 65535) throw Error("Invalid local pool port");
  const token = readOwned(pool.clientTokenFile).trim();
  const client = new Client({ name: "workstream-supervisor-read-only", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${pool.port}/mcp`), { requestInit: { headers: { authorization: "Bearer " + token, "x-factory-worker-scope": createHash("sha256").update("supervisor-read-only\0" + c.targetSessionId).digest("hex") } } }));
    const result = await client.callTool({ name: "factory_worker_accounts", arguments: {} }, undefined, { timeout: 10000 });
    if (result.isError) throw Error("Account observation unavailable");
    const content = result.content as Array<{ type: string; text?: string }>;
    const accounts = JSON.parse(content.find(x => x.type === "text")?.text ?? "{}").accounts;
    if (!Array.isArray(accounts)) throw Error("Invalid account observation");
    const account = accounts.find((a: any) => a.profile === assigned);
    if (!account || !["ready", "cooling_down"].includes(account.state) || account.recoveryWorkers?.length) throw Error("Assigned account unavailable");
    const cooldownUntil = time(account.coolingUntil);
    if (account.state === "cooling_down" && !cooldownUntil) throw Error("Unknown account recovery time");
    return { cooldownUntil, workersBusy: accounts.some((a: any) => a.activeWorkers > 0 || a.recoveryWorkers?.length) };
  } finally { await client.close(); }
}
export async function collectObservation(c: SupervisorConfig, now = Date.now()): Promise<SupervisorObservation> {
  verifyTarget(c);
  const [runtime, stored] = await Promise.all([bridgeJson(c, "/internal/runtime"), bridgeJson(c, "/internal/sessions")]);
  if (!Array.isArray(stored.sessions) || !Number.isInteger(runtime.activeRequests) || !Number.isInteger(runtime.activeNativeTurns)) throw Error("Incomplete runtime observation");
  const sessions = stored.sessions.filter((s: any) => s.factorySessionId === c.targetSessionId);
  const ids = new Set(sessions.map((s: any) => s.bridgeSessionId));
  const latest = [...sessions].sort((a: any, b: any) => (time(b.updatedAt) ?? 0) - (time(a.updatedAt) ?? 0))[0];
  const account = await accountObservation(c, latest?.claudeAccount);
  const log = join(c.controllerDataDir, "logs");
  const turns = [join(log, "turns.jsonl.1"), join(log, "turns.jsonl")].flatMap(jsonLines);
  const hosts = jsonLines(join(log, "host-events.jsonl"));
  const lastTurnAt = Math.max(0, ...turns.filter(d => ids.has(d.session) && typeof d.responseId === "string" && typeof d.sdkSessionId === "string").map(d => time(d.at) ?? 0));
  const lastToolAt = Math.max(0, ...hosts.filter(d => d.hostSessionId === c.targetSessionId && d.hook === "PostToolUse" && d.matched === true && typeof d.toolName === "string").map(d => time(d.at) ?? 0));
  const nativeLogs = readdirSync(c.factoryLogsDir, { withFileTypes: true }).filter(e => e.isFile() && /^droid-log-single\.log(?:\.\d{4}-\d\d-\d\d(?:\.\d+)?)?$/.test(e.name))
    .map(e => join(c.factoryLogsDir, e.name)).sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs).slice(0, 2);
  const rejections = nativeLogs.flatMap(file => readOwned(file, 8 * 1024 * 1024, true).split(/(?=^\[\d{4}-\d\d-\d\dT)/m).flatMap(record => {
    const r = nativeStartRejection(record); return r?.sessionId === c.targetSessionId ? [r] : [];
  })).sort((a, b) => b.at - a.at);
  const membership = workstreamMembership(c);
  const ownOrUnknown = (s: any) => s.factorySessionId === c.targetSessionId || !membership.get(s.factorySessionId) || membership.get(s.factorySessionId) === c.targetSessionId;
  const byBridge = new Map(stored.sessions.map((s: any) => [s.bridgeSessionId, s]));
  const live = Array.isArray(runtime.sessions) ? runtime.sessions : [];
  const active = live.filter((s: any) => s.active === true && s.ended !== true);
  const latestByHost = new Map<string, any>();
  for (const s of stored.sessions) if (!latestByHost.has(s.factorySessionId) || (time(s.updatedAt) ?? 0) > (time(latestByHost.get(s.factorySessionId).updatedAt) ?? 0)) latestByHost.set(s.factorySessionId, s);
  // Unrelated, positively identified native Workstreams must not starve recovery.
  // Unknown sessions and legacy writers remain conservative blockers.
  const busy = Boolean(runtime.activeNativeTurns > active.length || runtime.activeRequests > active.length || runtime.pendingApprovals || runtime.desktopJobs?.heldHostActions || account.workersBusy
    || active.some((s: any) => !byBridge.has(s.sessionId) || ownOrUnknown(byBridge.get(s.sessionId)))
    || [...latestByHost.values()].some(s => ["NEW", "GENERATING", "RESUMING", "WAITING_DROID_TOOL"].includes(s.state) && !s.hostEnded && ownOrUnknown(s)));
  return { now, healthy: true, busy, lastTurnAt, lastToolAt, rejection: rejections[0], dispatch: receipt(c, c.watchedAutomation), retryDispatch: receipt(c, c.retryAutomation), cooldownUntil: account.cooldownUntil,
    ...(latest?.cancelRequested === true || latest?.state === "CANCELLED" ? { cancelledAt: time(latest.updatedAt) } : {}) };
}

function retryFile(c: SupervisorConfig): string { return join(c.automationsDir, c.retryAutomation, "HEARTBEAT.md"); }
function ensureRetryOwnership(c: SupervisorConfig): void {
  const folder = dirname(retryFile(c)), marker = join(folder, ".bridge-supervisor-owner");
  const owner = createHash("sha256").update(resolve(c.stateDir) + "\0" + c.targetSessionId).digest("hex");
  if (!existsSync(folder)) {
    mkdirSync(folder, { mode: 0o700 });
    atomicOwned(marker, owner);
  }
  ownedDirectory(folder);
  if (readOwned(marker) !== owner) throw Error("Retry automation is not owned by this supervisor");
}
export function pauseRetry(c: SupervisorConfig): void {
  if (!existsSync(dirname(retryFile(c)))) return;
  ensureRetryOwnership(c);
  if (!existsSync(retryFile(c))) return;
  const text = readOwned(retryFile(c));
  if (!/^targetSessionId: /m.test(text) || !text.includes(`targetSessionId: ${c.targetSessionId}\n`)) throw Error("Retry target changed");
  if (!/^paused: true$/m.test(text)) atomicOwned(retryFile(c), text.replace(/^---\n/, "---\npaused: true\n"));
}
export function retryDocument(c: SupervisorConfig, id: string, dueAt: number): string {
  const d = new Date(Math.ceil(dueAt / 60_000) * 60_000);
  // The native local scheduler uses the machine timezone. Do not assume UTC outside UTC hosts.
  const cron = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
  return `---\nname: Bridge supervised Workstream recovery\nschedule: ${cron}\ntargetSessionId: ${c.targetSessionId}\n---\n\n[Bridge supervised recovery ${id}] Resume this SAME Workstream from its current checkpoint after a failed native startup. Preserve the existing account, model, worktrees, agent hierarchy, permissions and decisions. Collect completed agent results before delegating; do not duplicate an active writer or replay completed tasks. Honour the user's existing branch, review, QA and final-only CI instructions. Report the next concrete action and perform it; if blocked, state the exact blocker. This message does not grant new tool permissions or authority.\n`;
}
export function scheduleRetry(c: SupervisorConfig, id: string, dueAt: number): void {
  ensureRetryOwnership(c);
  atomicOwned(retryFile(c), retryDocument(c, id, dueAt));
}
const policy = (c: SupervisorConfig): SupervisorPolicy => ({ sessionId: c.targetSessionId, startupGraceMs: 120_000, idleAlertMs: 600_000, dispatchGraceMs: 180_000, retryDelaysMs: [300_000, 900_000, 1_800_000] });
export async function supervisorTick(c: SupervisorConfig): Promise<SupervisorState> {
  validateConfig(c);
  const path = join(c.stateDir, "supervisor.json");
  const prior: SupervisorState = existsSync(path) ? JSON.parse(readOwned(path)) : { armedAt: Date.now(), intent: "continue", attempts: 0, status: "watching" };
  // Validate persistent intent and budgets; corrupted state never authorizes recovery.
  if (!Number.isFinite(prior.armedAt) || !["continue", "pause", "complete"].includes(prior.intent) || !Number.isInteger(prior.attempts) || prior.attempts < 0 || prior.attempts > 3
    || (prior.pending && (!Number.isFinite(prior.pending.dueAt) || !/^\d+-[123]$/.test(prior.pending.id)))) throw Error("Invalid supervisor state");
  const controlPath = join(c.stateDir, "intent.json");
  if (existsSync(controlPath)) {
    const control = JSON.parse(readOwned(controlPath));
    if (!["continue", "pause", "complete"].includes(control.intent) || !Number.isFinite(control.at) || control.at > Date.now() + 5000) throw Error("Invalid operator intent");
    if (control.at > (prior.controlAt ?? 0)) {
      prior.controlAt = control.at;
      if (control.intent === "continue" && prior.intent !== "continue") {
        prior.armedAt = Date.now(); prior.attempts = 0;
        delete prior.pending; delete prior.incident; delete prior.failureAt; delete prior.verifiedAt;
      }
      prior.intent = control.intent;
    }
  }
  if (prior.deliveryHash || prior.deliveryIntentHash) {
    if (!existsSync(retryFile(c))) { if (prior.deliveryHash) throw Error("Retry automation removed outside the supervisor"); }
    else {
      const hash = createHash("sha256").update(readOwned(retryFile(c))).digest("hex");
      if (hash !== prior.deliveryHash && hash !== prior.deliveryIntentHash) throw Error("Retry automation changed outside the supervisor");
      if (hash === prior.deliveryIntentHash) { prior.deliveryHash = hash; delete prior.deliveryIntentHash; }
    }
  }
  let observation: SupervisorObservation;
  try { observation = await collectObservation(c); } catch { observation = { now: Date.now(), healthy: false, busy: true }; }
  const decision = superviseWorkstream(prior, observation, policy(c));
  let desired: string | undefined;
  if (decision.action?.type === "pause-retry" && existsSync(retryFile(c))) {
    ensureRetryOwnership(c);
    const text = readOwned(retryFile(c));
    if (!text.includes(`targetSessionId: ${c.targetSessionId}\n`)) throw Error("Retry target changed");
    desired = /^paused: true$/m.test(text) ? text : text.replace(/^---\n/, "---\npaused: true\n");
  } else if (decision.state.intent === "continue" && decision.state.status === "retry-scheduled" && decision.state.pending && !decision.state.pending.dispatchedAt && c.recoveryEnabled && observation.healthy && !observation.busy && observation.now <= decision.state.pending.dueAt) {
    ensureRetryOwnership(c);
    desired = retryDocument(c, decision.state.pending.id, decision.state.pending.dueAt);
  }
  if (desired !== undefined) decision.state.deliveryIntentHash = createHash("sha256").update(desired).digest("hex");
  // Durable intent precedes delivery mutation. On restart, only this exact intended hash is accepted.
  atomicOwned(path, JSON.stringify(decision.state, null, 2) + "\n");
  if (desired !== undefined) atomicOwned(retryFile(c), desired);
  if (existsSync(retryFile(c))) {
    decision.state.deliveryHash = createHash("sha256").update(readOwned(retryFile(c))).digest("hex");
    delete decision.state.deliveryIntentHash;
    atomicOwned(path, JSON.stringify(decision.state, null, 2) + "\n");
  }
  const status = { checkedAt: new Date().toISOString(), targetSessionId: c.targetSessionId, mode: c.recoveryEnabled ? "bounded-recovery" : "observe", ...decision.state, busy: observation.busy, cooldownUntil: observation.cooldownUntil };
  atomicOwned(join(c.stateDir, "status.json"), JSON.stringify(status, null, 2) + "\n");
  atomicOwned(join(c.stateDir, "alert.json"), JSON.stringify(decision.state.alert ?? null, null, 2) + "\n");
  if (decision.state.alert) notifyAlert(c, decision.state.alert);
  if (prior.status !== decision.state.status || prior.alert?.reason !== decision.state.alert?.reason) console.log(JSON.stringify(status));
  return decision.state;
}
export function notifyAlert(c: SupervisorConfig, alert: { at: number; reason: string }): void {
  if (!c.notificationExecutable) return;
  if (!["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].includes(c.notificationExecutable)) throw Error("Unsupported notifier");
  const path = join(c.stateDir, "notification.json");
  const previous = existsSync(path) ? JSON.parse(readOwned(path)) : undefined;
  if (previous?.alertAt === alert.at && previous?.reason === alert.reason) return;
  try {
    execFileSync(c.notificationExecutable, ["-title", "Factory Workstream needs attention", "-message", `Recovery status: ${alert.reason}. See ${join(c.stateDir, "status.json")}`, "-group", "factory-bridge-" + c.targetSessionId], { timeout: 5000, stdio: "ignore" });
    atomicOwned(path, JSON.stringify({ alertAt: alert.at, reason: alert.reason, submittedAt: new Date().toISOString(), displayed: "not independently verified" }) + "\n");
  } catch { atomicOwned(path, JSON.stringify({ alertAt: alert.at, reason: alert.reason, notificationFailed: true }) + "\n"); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "--config" || !args[1] || ![2, 3, 4].includes(args.length)) throw Error("Use --config /absolute/private/config.json [--once | --intent pause|complete|continue]");
  const c = JSON.parse(readOwned(args[1])) as SupervisorConfig;
  validateConfig(c);
  if (args[2] === "--intent" && ["pause", "complete", "continue"].includes(args[3] ?? "")) {
    atomicOwned(join(c.stateDir, "intent.json"), JSON.stringify({ intent: args[3], at: Date.now() }) + "\n");
    console.log(JSON.stringify({ intent: args[3], submitted: true })); return;
  }
  if (args.length > 2 && (args.length !== 3 || args[2] !== "--once")) throw Error("Unsupported supervisor arguments");
  // The Python launcher holds an OS advisory lock across exec, including crashes/restarts.
  const fd = Number(process.env.BRIDGE_SUPERVISOR_LOCK_FD);
  if (!Number.isSafeInteger(fd) || fd < 3 || !fstatSync(fd).isFile() || fstatSync(fd).uid !== process.getuid?.()) throw Error("Use the locking supervisor launcher");
  const tick = async () => { try { await supervisorTick(c); } catch {
    const fault = { at: new Date().toISOString(), status: "supervisor-fault", recoveryOutcome: "unverified" };
    // Keep faults observable even if the probe/config is corrupt; never log credentials or raw errors.
    try {
      atomicOwned(join(c.stateDir, "alert.json"), JSON.stringify(fault, null, 2) + "\n");
      atomicOwned(join(c.stateDir, "status.json"), JSON.stringify(fault, null, 2) + "\n");
      notifyAlert(c, { at: 0, reason: "supervisor_fault" });
    } catch {}
    console.error(JSON.stringify(fault));
  } };
  await tick();
  if (args.includes("--once")) return;
  const loop = async () => { await tick(); setTimeout(loop, 30_000); };
  setTimeout(loop, 30_000);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { console.error("Workstream supervisor could not start; no recovery was authorized."); process.exitCode = 1; });
}
