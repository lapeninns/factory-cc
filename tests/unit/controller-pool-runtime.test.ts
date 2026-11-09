import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig, type SubscriptionAccount } from "../../src/config.js";
import { createBridgeApp, listen, controllerJobBinding, type BridgeApp } from "../../src/http/app.js";
import { DesktopJobsRuntime, type DesktopJobBinding } from "../../src/runtime/desktop-jobs.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import { sanitizedSubscriptionEnvironment } from "../../src/workers/subscription-auth.js";
import { BridgeError } from "../../src/types.js";
import type { BridgeRuntime, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";
import { postMessages } from "../helpers/server.js";

const roots: string[] = [], runtimes: SdkRuntime[] = [], apps: BridgeApp[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), "controller-pool-"))); roots.push(root); return root; }
function accounts(): SubscriptionAccount[] {
  return Array.from({ length: 8 }, (_, n) => ({ profile: `team${n + 1}` as SubscriptionAccount["profile"],
    expectedEmail: `member${n + 1}@example.invalid`, weight: 1,
    env: sanitizedSubscriptionEnvironment({ PATH: process.env.PATH }, `/fixture/team${n + 1}`) }));
}
function config(): BridgeConfig {
  // The configuration parser is covered separately. Keep this runtime fixture
  // free of real filesystem account mappings and native lease processes.
  const base = loadConfig({ mode: "sdk", authMode: "subscription", permissionMode: "ask", dataDir: directory(),
    clientToken: "client", adminToken: "admin", hookToken: "hook", host: "127.0.0.1", port: 0,
    persistSessions: false, models: [{ id: "opus", model: "claude-opus-5-5", displayName: "Opus" }], requestTimeoutMs: 2000 });
  return { ...base, controllerPool: true, subscriptionAccounts: accounts(), controllerReadOnly: true,
    workerMcpPrefix: "factory-workers-pool___", subscriptionProfile: "team1", subscriptionExpectedEmail: "member1@example.invalid" };
}
function request(profile = "team2", id = "bridge-one"): RuntimeRequest {
  return { role: "orchestrator", headers: {}, request: { model: "opus", max_tokens: 20, messages: [{ role: "user", content: "hello" }] },
    session: { bridgeSessionId: id, role: "orchestrator", state: "NEW", model: "opus", claudeAccount: profile, nativeGeneration: 0,
      createdAt: "", updatedAt: "", toolNames: [], pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
}
function turn(): RuntimeTurn {
  return { response: { id: "msg", type: "message", role: "assistant", model: "opus", content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, pendingToolIds: [] };
}
class FakeSdk implements SdkHandle {
  calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  inputs: SdkUserInput[] = [];
  identity?: string;
  fail?: Record<string, unknown>;
  beforeFailure: Record<string, unknown>[] = [];
  closeFailure = false;
  tool() { return {}; }
  createSdkMcpServer(options: Record<string, unknown>) {
    return { ...options, instance: { isConnected: () => false, sendToolListChanged: async () => undefined,
      server: { sendToolListChanged: async () => undefined, setRequestHandler() {} }, registerTool: () => ({ update() {}, remove() {} }) } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args);
    const self = this;
    return {
      async accountInfo() {
        const env = args.options.env as Record<string, string>;
        const n = env.CLAUDE_CONFIG_DIR.match(/team(\d+)$/)?.[1];
        return { email: self.identity ?? `member${n}@example.invalid`, subscriptionType: "team", apiProvider: "firstParty", authMethod: "claude.ai", apiKeySource: "oauth" };
      },
      close() { if (self.closeFailure) throw new Error("synthetic native close failure"); },
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          self.inputs.push(input);
          for (const message of self.beforeFailure) yield message;
          if (self.fail) yield self.fail;
          else yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "native-fixture" };
        }
      },
    };
  }
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native controller pool identity", () => {
  it("uses the selected account for both SDK environment and pre-prompt identity verification", async () => {
    const sdk = new FakeSdk(), runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await runtime.handle(request("team7"));
    expect((sdk.calls[0]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/fixture/team7");
    expect(sdk.inputs).toHaveLength(1);
  });
  it("rejects an incorrect account before sending any prompt", async () => {
    const sdk = new FakeSdk(); sdk.identity = "member1@example.invalid";
    const runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    logger.warn.mockClear();
    await expect(runtime.handle(request("team7"))).rejects.toMatchObject({ code: "auth_mode_mismatch" });
    expect(sdk.inputs).toHaveLength(0);
    const record = logger.warn.mock.calls.find(([event]) => event === "sdk_session_failed")?.[1];
    expect(record).toMatchObject({ code: "auth_mode_mismatch", phase: "startup", claudeProfile: "team7", sentUserTurns: 0 });
    expect(JSON.stringify(record)).not.toContain("member1@example.invalid");
  });
  it("rejects an unconfigured selected account before native startup", async () => {
    const sdk = new FakeSdk(), runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await expect(runtime.handle(request("personal"))).rejects.toMatchObject({ code: "subscription_pool_unassigned" });
    expect(sdk.calls).toHaveLength(0);
  });
  it("does not change account inside an existing query", async () => {
    const sdk = new FakeSdk(), runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await runtime.handle(request("team2"));
    await expect(runtime.handle(request("team3"))).rejects.toMatchObject({ code: "session_configuration_changed" });
    expect(sdk.calls).toHaveLength(1);
  });
  it("recognizes structured quota rejection and retires only after verified cleanup", async () => {
    const sdk = new FakeSdk(); sdk.fail = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Date.now() / 1000 + 100 } };
    const runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await expect(runtime.handle(request())).rejects.toMatchObject({ code: "rate_limit_error", extra: { usage_limit: true, retry_from_history: true } });
    await runtime.prepareColdRetry("bridge-one");
    sdk.fail = undefined;
    const retry = request("team3"); retry.session.nativeGeneration = 1; retry.recovery = "cold-import";
    await runtime.handle(retry);
    expect(sdk.calls).toHaveLength(2);
    expect((sdk.calls[1]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/fixture/team3");
  });
  it("blocks account failover when native cleanup cannot be verified", async () => {
    const sdk = new FakeSdk(); sdk.closeFailure = true; sdk.fail = { type: "assistant", error: "rate_limit" };
    const runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await expect(runtime.handle(request())).rejects.toMatchObject({ code: "rate_limit_error" });
    await expect(runtime.prepareColdRetry("bridge-one")).rejects.toMatchObject({ code: "native_cleanup_incomplete" });
    await expect(runtime.cancel("bridge-one", "test")).rejects.toMatchObject({ code: "native_cleanup_incomplete" });
  });
  it("refuses cold import after a native action was proposed in the failed turn", async () => {
    const sdk = new FakeSdk();
    sdk.beforeFailure = [{ type: "assistant", message: { content: [{ type: "tool_use", id: "native-action", name: "Bash", input: { command: "touch file" } }] } }];
    sdk.fail = { type: "assistant", error: "rate_limit" };
    const runtime = new SdkRuntime(config(), logger, sdk); runtimes.push(runtime);
    await expect(runtime.handle(request())).rejects.toMatchObject({ code: "rate_limit_error" });
    await expect(runtime.prepareColdRetry("bridge-one")).rejects.toMatchObject({ code: "native_retry_unsafe" });
  });
  it("does not grant reserved native controller capacity from model role headers", () => {
    const input = request("team8");
    input.factorySession = { sessionId: "native-factory", cwd: "/fixture", desktopLifecycle: true };
    input.headers["x-bridge-role"] = "orchestrator";
    expect(controllerJobBinding({ ...config(), factoryNative: true, controllerHostTools: true }, input))
      .toMatchObject({ workspacePolicy: "factory-native", inferenceRole: "worker" });
  });

  it.each(["orchestrator", "agent"] as const)("uses authenticated role metadata for the native %s connection", role => {
    const input = request("team8");
    input.factorySession = { sessionId: "native-factory", cwd: "/fixture", desktopLifecycle: true, nativeWorkstream: { role, workstreamId: "00000000-0000-0000-0000-000000000001" } };
    expect(controllerJobBinding({ ...config(), factoryNative: true, controllerHostTools: true }, input))
      .toMatchObject({ subscriptionProfile: "team8", nativeGeneration: 0, workspacePolicy: "factory-native", inferenceRole: role === "agent" ? "worker" : "orchestrator" });
  });

  it("binds the lease to the same privately selected account and generation", () => {
    const input = request("team8"); input.factorySession = { sessionId: "factory-one", cwd: "/fixture", desktopLifecycle: true };
    expect(controllerJobBinding(config(), input)).toMatchObject({ subscriptionProfile: "team8", nativeGeneration: 0, workspacePolicy: "controller-readonly" });
    input.session.claudeAccount = "forged";
    expect(() => controllerJobBinding(config(), input)).toThrow("no valid selected subscription");
  });
});

describe("controller pool native lease generations", () => {
  it("requires verified retirement before assigning a fresh profile and lease identity", async () => {
    const root = directory(); const cwd = join(root, "worktree"); mkdirSync(cwd); writeFileSync(join(cwd, ".git"), "gitdir: fixture\n");
    const binding: DesktopJobBinding = { sessionId: "factory", cwd, subscriptionProfile: "team1", workspacePolicy: "controller-readonly", nativeGeneration: 0 };
    const inner = { kind: "fake" as const, handle: vi.fn(async () => turn()), cancel: vi.fn(async () => undefined),
      deliverResults: vi.fn(async () => []), prepareColdRetry: vi.fn(async () => undefined) };
    const acquire = vi.fn(async (_request: import("../../src/runtime/desktop-jobs.js").DesktopJobAcquire) => ({ jobId: "job", release: vi.fn(async () => undefined) }));
    const runtime = new DesktopJobsRuntime(inner, { pythonExecutable: "/usr/bin/python3", runtimePackagePath: root,
      stateRoot: join(root, "state"), getBinding: () => binding, acquireLease: acquire, updateRecord: vi.fn(async () => undefined) });
    await runtime.handle(request("team1"));
    binding.nativeGeneration = 1; binding.subscriptionProfile = "team2";
    await expect(runtime.handle(request("team2"))).rejects.toMatchObject({ code: "desktop_job_identity" });
    await runtime.prepareColdRetry("bridge-one");
    await runtime.handle(request("team2"));
    expect(acquire.mock.calls.map(([value]) => value)).toMatchObject([
      { bridgeSessionId: "bridge-one:g0", subscriptionProfile: "team1" }, { bridgeSessionId: "bridge-one:g1", subscriptionProfile: "team2" },
    ]);
    await runtime.close();
  });
});

describe("controller account selection and failover", () => {
  async function start() {
    const runtime: BridgeRuntime & { handle: ReturnType<typeof vi.fn>; prepareColdRetry: ReturnType<typeof vi.fn> } = {
      kind: "fake", handle: vi.fn(async () => turn()), cancel: vi.fn(async () => undefined), deliverResults: async () => [],
      prepareColdRetry: vi.fn(async () => undefined),
    };
    const cfg = config(), app = createBridgeApp(cfg, logger, join(cfg.dataDir, "canary"), runtime); apps.push(app); await listen(app, cfg);
    return { app, runtime };
  }
  const body = (message: string) => ({ model: "opus", max_tokens: 20, messages: [{ role: "user", content: message }] });
  it("distributes new sessions over eight accounts and preserves an existing selection", async () => {
    const { app, runtime } = await start();
    for (let n = 0; n < 8; n++) expect((await postMessages(app.url, "client", body(`task${n}`))).status).toBe(200);
    expect(runtime.handle.mock.calls.map(([input]) => input.session.claudeAccount)).toEqual(accounts().map(value => value.profile));
  });
  it("moves a retry to another account and new generation only after native retirement", async () => {
    const { app, runtime } = await start();
    runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "limited", { retry_from_history: true, retry_after: 120 }));
    const failed = await postMessages(app.url, "client", body("one task"));
    expect(failed.status).toBe(429); expect(runtime.prepareColdRetry).toHaveBeenCalledWith(failed.session);
    expect(app.store.get(failed.session!)).toMatchObject({ claudeAccount: "team2", nativeGeneration: 1, state: "IDLE" });
    const retried = await postMessages(app.url, "client", body("one task"));
    expect(retried.status).toBe(200); expect(retried.session).toBe(failed.session);
    expect(runtime.handle.mock.calls.at(-1)![0]).toMatchObject({ recovery: "cold-import", session: { claudeAccount: "team2", nativeGeneration: 1 } });
  });
  it("does not fail over when cleanup fails or the SDK marks retry unsafe", async () => {
    const { app, runtime } = await start();
    runtime.prepareColdRetry.mockRejectedValueOnce(new Error("unverified cleanup"));
    runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "limited", { retry_from_history: true }));
    const failed = await postMessages(app.url, "client", body("cleanup"));
    expect(failed.status).toBe(503); expect(app.store.get(failed.session!)).toMatchObject({ claudeAccount: "team1", nativeGeneration: 0, state: "FAILED" });
    runtime.prepareColdRetry.mockClear();
    runtime.handle.mockRejectedValueOnce(new BridgeError(429, "rate_limit_error", "unsafe", { retry_from_history: false }));
    const unsafe = await postMessages(app.url, "client", body("pending tool"));
    expect(unsafe.status).toBe(429); expect(runtime.prepareColdRetry).not.toHaveBeenCalled();
    expect(app.store.get(unsafe.session!)?.state).toBe("FAILED");
  });
  it("waits after all accounts are cooling instead of using a cooling account", async () => {
    const { app, runtime } = await start();
    runtime.handle.mockImplementation(async () => { throw new BridgeError(429, "rate_limit_error", "limited", { retry_from_history: true, retry_after: 120 }); });
    for (let n = 0; n < 8; n++) expect((await postMessages(app.url, "client", body(`quota${n}`))).status).toBe(429);
    const before = runtime.handle.mock.calls.length;
    const blocked = await postMessages(app.url, "client", body("all cooling"));
    expect(blocked.status).toBe(429); expect(runtime.handle).toHaveBeenCalledTimes(before);
  });
  it("returns a bounded error when a persisted native generation is exhausted", async () => {
    const { app, runtime } = await start();
    runtime.handle.mockImplementationOnce(async (input: RuntimeRequest) => {
      input.session.nativeGeneration = 1_000_000;
      throw new BridgeError(429, "rate_limit_error", "limited", { retry_from_history: true });
    });
    const failed = await postMessages(app.url, "client", body("exhausted generation"));
    expect(failed.status).toBe(503);
    expect(failed.json).toMatchObject({ error: { type: "native_generation_exhausted" } });
    expect(app.store.get(failed.session!)?.state).toBe("FAILED");
  });
});
