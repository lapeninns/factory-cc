import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type BridgeConfig, type SubscriptionAccount } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import type { BridgeRuntime, RuntimeTurn } from "../../src/runtime/types.js";
import { acquireDesktopJobLease } from "../../src/runtime/desktop-jobs.js";
import { SessionStore } from "../../src/sessions/store.js";
import { sanitizedSubscriptionEnvironment } from "../../src/workers/subscription-auth.js";

/** Fixed fixture identities; none of them belongs to a real account or session. */
export const FACTORY_SESSION = "8f1d2c3b-0000-4000-8000-000000000001";
export const WORKSTREAM = "8f1d2c3b-0000-4000-8000-0000000000aa";
export const CHECKPOINT = "11111111-2222-4333-8444-555555555555";
const TOOLS = [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];

export function restartConfig(root: string): BridgeConfig {
  const accounts: SubscriptionAccount[] = Array.from({ length: 8 }, (_, n) => ({ profile: `team${n + 1}` as SubscriptionAccount["profile"],
    expectedEmail: `member${n + 1}@example.invalid`, weight: 1, env: sanitizedSubscriptionEnvironment({ PATH: process.env.PATH }, `/fixture/team${n + 1}`) }));
  const base = loadConfig({ mode: "sdk", authMode: "subscription", permissionMode: "ask", dataDir: join(root, "bridge", "data"),
    clientToken: "client", adminToken: "admin", hookToken: "hook", host: "127.0.0.1", port: 0, persistSessions: true,
    models: [{ id: "opus", model: "claude-opus-5-5", displayName: "Opus" }], requestTimeoutMs: 20_000 });
  return { ...base, controllerPool: true, subscriptionAccounts: accounts, controllerReadOnly: true, controllerHostTools: true,
    factoryNative: true, controllerApprovalPolicy: "bypass", desktopProfile: true, desktopLifecycle: true, desktopJobs: true,
    desktopRuntimePath: resolve("native-runtime"), desktopStateRoot: join(root, "leases"), workerMcpPrefix: "factory-workers-pool___",
    subscriptionProfile: "team1", subscriptionExpectedEmail: "member1@example.invalid" };
}

export interface RecordedTurn { bridgeSessionId: string; sdkSessionId?: string; nativeGeneration?: number; claudeAccount?: string; recovery?: string; messages: number }

/** Stands in for the SDK runtime and records what each admitted phase would resume. */
export function recordingRuntime(): BridgeRuntime & { turns: RecordedTurn[] } {
  const turns: RecordedTurn[] = [];
  return { kind: "fake", turns, cancel: async () => undefined, deliverResults: async () => [],
    handle: async (input): Promise<RuntimeTurn> => {
      turns.push({ bridgeSessionId: input.session.bridgeSessionId, sdkSessionId: input.session.sdkSessionId,
        nativeGeneration: input.session.nativeGeneration, claudeAccount: input.session.claudeAccount, recovery: input.recovery,
        messages: input.request.messages.length });
      return { response: { id: `msg_${turns.length}`, type: "message", role: "assistant", model: "opus",
        content: [{ type: "text", text: turns.length === 1 ? "Planned." : "Continued." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }, pendingToolIds: [], sdkSessionId: input.session.sdkSessionId ?? CHECKPOINT };
    } };
}

export async function startController(root: string, runtime: BridgeRuntime): Promise<BridgeApp> {
  const config = restartConfig(root);
  mkdirSync(join(root, "workspace"), { recursive: true });
  const app = createBridgeApp(config, createLogger(config.logDir), join(root, "canary"), runtime);
  await listen(app, config);
  return app;
}

export async function hostStart(app: BridgeApp, root: string): Promise<string> {
  const response = await fetch(`${app.url}/internal/host-events`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer hook" },
    body: JSON.stringify({ eventId: randomUUID(), desktopLifecycle: true, event: { hook_event_name: "SessionStart",
      session_id: FACTORY_SESSION, cwd: join(root, "workspace"), bridgeNativeWorkstream: { role: "orchestrator", workstreamId: WORKSTREAM } } }) });
  const body = await response.json() as { bindingToken?: string };
  if (response.status !== 200 || !body.bindingToken) throw new Error(`SessionStart failed with ${response.status}`);
  return body.bindingToken;
}

export function firstTurn(token: string) {
  return { model: "opus", max_tokens: 64, tools: TOOLS, messages: [{ role: "user", content: `[factory-cc-session:${token}] Plan the release` }] };
}

/** Factory's retained history plus a new user turn carrying the current generation marker. */
export function continuation(previousToken: string, token: string, text = "Continue") {
  return { ...firstTurn(previousToken), messages: [...firstTurn(previousToken).messages,
    { role: "assistant", content: [{ type: "text", text: "Planned." }] },
    { role: "user", content: `[factory-cc-session:${token}] ${text}` }] };
}

export async function recover(app: BridgeApp, body: Record<string, unknown>) {
  const response = await fetch(`${app.url}/internal/native-checkpoint-recovery`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

/** The first controller process: one completed native turn, then an orderly close. */
export async function runFirstController(root: string): Promise<{ bridgeSessionId: string; token: string; account?: string }> {
  const runtime = recordingRuntime();
  const app = await startController(root, runtime);
  try {
    const token = await hostStart(app, root);
    const response = await fetch(`${app.url}/v1/messages`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client" }, body: JSON.stringify(firstTurn(token)) });
    const bridgeSessionId = response.headers.get("x-bridge-session") ?? "";
    if (response.status !== 200 || !bridgeSessionId) throw new Error(`first turn failed with ${response.status}: ${await response.text()}`);
    return { bridgeSessionId, token, account: runtime.turns[0]?.claudeAccount };
  } finally {
    await app.close();
  }
}

/** A failed import with a real lease whose owning process exits before recovery. */
export async function runFailedImport(root: string, profile: "team2" | "team3", state: "failed" | "unknown"): Promise<string> {
  const store = new SessionStore(join(root, "bridge", "data", "sessions"), true, 16);
  const record = store.create({ role: "orchestrator", model: "opus", claudeAccount: profile, nativeGeneration: 0, toolNames: ["Read"] });
  store.update(record.bridgeSessionId, { factorySessionId: FACTORY_SESSION, factoryCwd: join(root, "workspace") });
  const lease = await acquireDesktopJobLease({ pythonExecutable: "/usr/bin/python3", runtimePackagePath: resolve("native-runtime"),
    stateRoot: join(root, "leases"), maxRunning: 8 }, { factorySessionId: FACTORY_SESSION,
    bridgeSessionId: `${record.bridgeSessionId}:g0`, cwd: join(root, "workspace"), role: "orchestrator",
    subscriptionProfile: profile, workspacePolicy: "factory-native" }, new AbortController().signal);
  await lease.release({ state, cleanupVerified: state === "failed" });
  store.setState(record.bridgeSessionId, "FAILED");
  return record.bridgeSessionId;
}
