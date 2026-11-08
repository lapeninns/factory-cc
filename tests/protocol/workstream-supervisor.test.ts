import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { supervisorTick, collectObservation, atomicOwned, type SupervisorConfig } from "../../scripts/workstream-supervisor.js";
import { startPoolServer } from "../../src/workers/pool-http.js";
import { SubscriptionWorkerPool, type PoolBackend } from "../../src/workers/pool.js";
import { SUBSCRIPTION_PROFILES } from "../../src/runtime/desktop-jobs.js";

const roots: string[] = [], closes: Array<() => Promise<unknown>> = [], children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of children.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const close of closes.splice(0).reverse()) await close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function root() { const p = realpathSync(mkdtempSync(join(tmpdir(), "supervisor-protocol-"))); roots.push(p); return p; }
async function fixture() {
  const path = root(), id = "8aaea39b-7a84-492e-af57-a5fb3e44970f", token = "a".repeat(64);
  for (const d of ["controller", "controller/logs", "logs", "sessions", "sessions/repo", "automations", "automations/original-delivery", "automations/original-delivery/memory", "state", "pool-state"]) mkdirSync(join(path, d), { mode: 0o700 });
  const backends: PoolBackend[] = SUBSCRIPTION_PROFILES.map(profile => ({ profile, weight: 1, identity: createHash("sha256").update(profile).digest("hex"), health: async () => true,
    call: async name => { if (name === "factory_worker_list") return []; throw Error("No mutations permitted"); }, pending: async () => [], decide: async () => { throw Error("No decisions permitted"); } }));
  const pool = await startPoolServer(() => new SubscriptionWorkerPool(join(path, "pool-state"), backends), { port: 0, token, controlFile: join(path, "control.json") });
  closes.push(() => pool.close());
  const port = (pool.server.address() as { port: number }).port;
  writeFileSync(join(path, "pool-token"), token);
  writeFileSync(join(path, "pool.json"), JSON.stringify({ port, clientTokenFile: join(path, "pool-token") }));
  const bridgeSession = "sess_fixture_original_account", methods: string[] = [];
  const runtime = { activeRequests: 0, activeNativeTurns: 0, pendingHostCalls: 0, pendingApprovals: 0, sessions: [] as Array<Record<string, unknown>>, desktopJobs: { activePhases: 0, heldHostActions: 0 } };
  const stored = [{ factorySessionId: id, bridgeSessionId: bridgeSession, claudeAccount: "team5", updatedAt: new Date().toISOString(), state: "IDLE" }];
  const api = createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    if (req.method !== "GET" || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/internal/runtime" ? runtime : { sessions: stored }));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening"); closes.push(() => new Promise<void>((resolve, reject) => api.close(e => e ? reject(e) : resolve())));
  writeFileSync(join(path, "controller/admin-token"), token);
  writeFileSync(join(path, `sessions/repo/${id}.settings.json`), JSON.stringify({ model: "custom:bridge", tags: [{ name: "mission-v2", metadata: { kind: "orchestrator", missionId: id } }] }));
  const c: SupervisorConfig = { targetSessionId: id, controllerUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}`, controllerDataDir: join(path, "controller"), poolConfigFile: join(path, "pool.json"), factorySessionsDir: join(path, "sessions"), factoryLogsDir: join(path, "logs"), automationsDir: join(path, "automations"), watchedAutomation: "original-delivery", retryAutomation: "owned-recovery", stateDir: join(path, "state"), expectedModelId: "custom:bridge", recoveryEnabled: true };
  let now = Date.parse("2026-11-08T01:07:35Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const failed = Date.parse("2026-11-08T01:05:34.725Z");
  writeFileSync(join(path, "state/supervisor.json"), JSON.stringify({ armedAt: failed - 60_000, attempts: 0, intent: "continue", status: "watching" }));
  writeFileSync(join(path, "automations/original-delivery/HEARTBEAT.md"), "original instructions unchanged\n");
  writeFileSync(join(path, "automations/original-delivery/memory/state.json"), JSON.stringify({ lastRunId: "original-run", lastRunAt: new Date(failed).toISOString(), lastRunStatus: "success", lastRunSessionId: id }));
  writeFileSync(join(path, "logs/droid-log-single.log"), `[2026-11-08T01:05:34.725Z] WARN: [Agent] Missions 2.0 turn rejected\nError: not available\n    at missionV2Access.ts:96:17 | Context: ${JSON.stringify({ reason: "missions_v2_disabled", tags: { sessionId: id }, cause: { message: "Workstreams are not available for this organization" } })}\n`);
  return { c, path, failed, bridgeSession, runtime, stored, methods, setNow: (value: number) => { now = value; } };
}

it("replays the actual overnight failure through HTTP/MCP observations, persists one retry, and requires productive recovery", async () => {
  const f = await fixture();
  const first = await supervisorTick(f.c);
  expect(first.status).toBe("retry-scheduled");
  expect(first.attempts).toBe(1);
  const file = join(f.c.automationsDir, f.c.retryAutomation, "HEARTBEAT.md"), doc = readFileSync(file, "utf8");
  expect(doc).toContain(`targetSessionId: ${f.c.targetSessionId}`);
  expect(doc).not.toContain("model:");
  expect((await supervisorTick(f.c)).attempts).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(doc);
  const delivered = first.pending!.dueAt + 1000;
  mkdirSync(join(dirname(file), "memory"));
  writeFileSync(join(dirname(file), "memory/state.json"), JSON.stringify({ lastRunId: "retry-run", lastRunAt: new Date(delivered).toISOString(), lastRunStatus: "success", lastRunSessionId: f.c.targetSessionId }));
  f.setNow(delivered + 1000);
  expect((await supervisorTick(f.c)).status).toBe("verifying-retry");
  expect(readFileSync(file, "utf8")).toContain("paused: true");
  writeFileSync(join(f.path, "controller/logs/turns.jsonl"), JSON.stringify({ at: new Date(delivered + 100).toISOString(), session: f.bridgeSession, responseId: "response-from-inference", sdkSessionId: "same-assigned-account-sdk" }) + "\n");
  writeFileSync(join(f.path, "controller/logs/host-events.jsonl"), JSON.stringify({ at: new Date(delivered + 200).toISOString(), hostSessionId: f.c.targetSessionId, hook: "PostToolUse", toolName: "Read", matched: true }) + "\n");
  const recovered = await supervisorTick(f.c);
  expect(recovered.status).toBe("progress-verified");
  expect(recovered.pending).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.c.stateDir, "alert.json"), "utf8"))).toBeNull();
  expect(f.methods.every(m => m.startsWith("GET "))).toBe(true);
  expect(readFileSync(join(f.c.automationsDir, f.c.watchedAutomation, "HEARTBEAT.md"), "utf8")).toBe("original instructions unchanged\n");
});

it("recovers a crash after an intended file write, but stops on a human edit instead of undoing it", async () => {
  const f = await fixture(), s = await supervisorTick(f.c), file = join(f.c.automationsDir, f.c.retryAutomation, "HEARTBEAT.md");
  const paused = readFileSync(file, "utf8").replace(/^---\n/, "---\npaused: true\n");
  s.deliveryIntentHash = createHash("sha256").update(paused).digest("hex");
  atomicOwned(join(f.c.stateDir, "supervisor.json"), JSON.stringify(s));
  atomicOwned(file, paused); // crash before the durable acknowledgement
  f.runtime.pendingApprovals = 1;
  expect((await supervisorTick(f.c)).status).toBe("work-active");
  expect(readFileSync(file, "utf8")).toBe(paused);
  atomicOwned(file, paused + "\nOperator changed this task\n");
  await expect(supervisorTick(f.c)).rejects.toThrow("changed outside");
  expect(readFileSync(file, "utf8")).toContain("Operator changed this task");
});

it("honours an explicit operator pause before recovery and does not rearm its pending delivery", async () => {
  const f = await fixture(); await supervisorTick(f.c);
  writeFileSync(join(f.c.stateDir, "intent.json"), JSON.stringify({ intent: "pause", at: Date.now() }));
  expect((await supervisorTick(f.c)).status).toBe("pause");
  expect(readFileSync(join(f.c.automationsDir, f.c.retryAutomation, "HEARTBEAT.md"), "utf8")).toContain("paused: true");
});

// This exercises a real OS lock and SIGKILL, not a model or Factory account.
it("holds one kernel lock across exec and releases it after a crash", async () => {
  const path = root(), script = join(path, "fixture.mjs"), config = join(path, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: path }));
  writeFileSync(script, "console.log('locked'); if (!process.argv.includes('--once')) setInterval(()=>{},1000);\n");
  const args = [resolve("native-runtime/run_workstream_supervisor.py"), process.execPath, script, "--config", config];
  const first = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] }); children.push(first);
  await once(first.stdout!, "data");
  const second = spawn("python3", [...args, "--once"], { stdio: "pipe" }); children.push(second);
  expect((await once(second, "exit"))[0]).not.toBe(0);
  first.kill("SIGKILL"); await once(first, "exit");
  const third = spawn("python3", [...args, "--once"], { stdio: "pipe" }); children.push(third);
  expect((await once(third, "exit"))[0]).toBe(0);
});

it("does not starve behind a known foreign Workstream, while unknown writers and admissions block recovery", async () => {
  const f = await fixture(), other = "479446e5-a1f7-43e9-bdb7-091dc666143c";
  // A live session absent from trusted native metadata remains an unknown writer.
  f.runtime.sessions = [{ sessionId: "foreign", active: true, ended: false }];
  f.runtime.activeNativeTurns = 1;
  expect((await collectObservation(f.c)).busy).toBe(true);
  // No bridge mapping exists for this id: even adding settings cannot make it trusted.
  writeFileSync(join(f.path, `sessions/repo/${other}.settings.json`), JSON.stringify({ tags: [{ name: "mission-v2", metadata: { kind: "orchestrator", missionId: other } }] }));
  expect((await collectObservation(f.c)).busy).toBe(true);
  f.stored.push({ factorySessionId: other, bridgeSessionId: "foreign", claudeAccount: "team6", updatedAt: new Date().toISOString(), state: "GENERATING" });
  expect((await collectObservation(f.c)).busy).toBe(false);
  const child = "79359ebf-7b05-4c73-b07f-3d457371f4a1";
  writeFileSync(join(f.path, `sessions/repo/${child}.settings.json`), JSON.stringify({ tags: [{ name: "subagent", metadata: { callingSessionId: other } }] }));
  f.stored.push({ factorySessionId: child, bridgeSessionId: "child", claudeAccount: "team6", updatedAt: new Date().toISOString(), state: "RESUMING" });
  f.runtime.sessions = [{ sessionId: "child", active: true, ended: false }];
  expect((await collectObservation(f.c)).busy).toBe(false);
  f.stored.pop();
  f.runtime.sessions = [];
  f.stored.pop();
  f.runtime.activeNativeTurns = 0;
  f.runtime.activeRequests = 1;
  expect((await collectObservation(f.c)).busy).toBe(true);
  f.runtime.activeRequests = 0;
  expect((await collectObservation(f.c)).busy).toBe(false);
});
