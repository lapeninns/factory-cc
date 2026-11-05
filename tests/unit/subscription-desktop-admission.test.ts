import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig, type SubscriptionAccount } from "../../src/config.js";
import { createBridgeApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import { SUBSCRIPTION_PROFILES, type DesktopJobsOptions } from "../../src/runtime/desktop-jobs.js";
import { sanitizedSubscriptionEnvironment } from "../../src/workers/subscription-auth.js";
import type { BridgeRuntime, RuntimeRequest } from "../../src/runtime/types.js";
import { workflowAllowed } from "../../src/runtime/native-workflows.js";

const captured = vi.hoisted(() => ({ options: undefined as DesktopJobsOptions | undefined }));
vi.mock("../../src/runtime/desktop-jobs.js", async (original) => ({
  ...await original<typeof import("../../src/runtime/desktop-jobs.js")>(),
  DesktopJobsRuntime: class {
    constructor(inner: BridgeRuntime, options: DesktopJobsOptions) { captured.options = options; return inner; }
  },
}));

const roots: string[] = [];
function config(overrides: Partial<BridgeConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "subscription-admission-")); roots.push(dataDir);
  return loadConfig({ dataDir, mode: "sdk", authMode: "subscription", desktopProfile: true, desktopLifecycle: true,
    desktopJobs: true, desktopRuntimePath: "/fixture/runtime", desktopStateRoot: "/fixture/state",
    subscriptionProfile: "team1", subscriptionExpectedEmail: "fixture@example.invalid",
    models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "fixture" }], ...overrides });
}
function accounts(): SubscriptionAccount[] {
  return SUBSCRIPTION_PROFILES.map((profile, index) => ({ profile, expectedEmail: profile === "team1" ? "fixture@example.invalid" : `${profile}@example.invalid`,
    env: sanitizedSubscriptionEnvironment({ PATH: process.env.PATH }, `/fixture/${profile}`), weight: index < 4 ? 5 : 1 }));
}
function controllerPool(overrides: Partial<BridgeConfig> = {}) {
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/fixture/team1");
  return config({ controllerReadOnly: true, workerPool: true, controllerPool: true, workerControlFile: "/fixture/pool-control.json",
    workerMcpPrefix: "factory-workers-pool___", subscriptionAccounts: accounts(), ...overrides });
}
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(BRIDGE_|ANTHROPIC_|CLAUDE_|OPENROUTER_)/.test(name)) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  captured.options = undefined;
});

describe("fixed subscription Desktop admission", () => {
  it("requires explicit immutable approval bypass on the host-enabled subscription pool", () => {
    expect(controllerPool({ controllerHostTools: true }).controllerApprovalPolicy).toBe("ask");
    const value = controllerPool({ controllerHostTools: true, controllerApprovalPolicy: "bypass" });
    expect(value.controllerApprovalPolicy).toBe("bypass");
    expect(value.permissionMode).toBe("ask");
    expect(() => Object.defineProperty(value, "controllerApprovalPolicy", { value: "ask" })).toThrow();
    expect(() => controllerPool({ controllerApprovalPolicy: "bypass" })).toThrow(/bypass requires/);
    expect(() => controllerPool({ controllerHostTools: true, controllerApprovalPolicy: "always" as never })).toThrow(/must be ask or bypass/);
    expect(() => config({ controllerApprovalPolicy: "bypass" })).toThrow(/bypass requires/);
    vi.stubEnv("BRIDGE_CONTROLLER_APPROVAL_POLICY", "bypass");
    expect(controllerPool({ controllerHostTools: true }).controllerApprovalPolicy).toBe("ask");
  });

  it("requires explicit immutable host-tools opt-in on the pooled controller", () => {
    expect(controllerPool().controllerHostTools).toBe(false);
    const value = controllerPool({ controllerHostTools: true });
    expect(value.controllerHostTools).toBe(true);
    expect(() => Object.defineProperty(value, "controllerHostTools", { value: false })).toThrow();
    expect(() => controllerPool({ controllerHostTools: "true" as never })).toThrow(/boolean/);
    expect(() => controllerPool({ controllerHostTools: true, controllerPool: false, subscriptionAccounts: undefined })).toThrow(/host tools require/);
    vi.stubEnv("BRIDGE_CONTROLLER_HOST_TOOLS", "1");
    expect(controllerPool().controllerHostTools).toBe(false);
  });

  it("chooses the host workspace policy only from immutable operator configuration", async () => {
    const value = controllerPool({ controllerHostTools: true });
    const runtime = { kind: "fake", close: vi.fn(async () => {}) } as unknown as BridgeRuntime;
    const app = createBridgeApp(value, createLogger(value.logDir), join(value.sandboxDir, "canary"), runtime);
    try {
      const input = { session: { claudeAccount: "team3", nativeGeneration: 2 }, factorySession: {
        sessionId: "factory-host", cwd: "/fixture/folder", desktopLifecycle: true, workspacePolicy: "forged",
      } } as unknown as RuntimeRequest;
      expect(captured.options!.getBinding(input)).toMatchObject({ cwd: "/fixture/folder", subscriptionProfile: "team3",
        workspacePolicy: "controller-host", nativeGeneration: 2 });
    } finally {
      await app.close().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error; });
    }
  });

  it("refuses a read-only controller paired with another seat's worker namespace", () => {
    expect(() => config({ controllerReadOnly: true, workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-team8___" })).toThrow(/own fixed seat/);
    expect(() => config({ controllerReadOnly: true, workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-pool___" })).toThrow(/own fixed seat/);
  });
  it("admits the explicit aggregate worker connection without changing the controller's fixed identity", () => {
    const value = config({ controllerReadOnly: true, workerPool: true, workerControlFile: "/fixture/pool-control.json", workerMcpPrefix: "factory-workers-pool___" });
    expect(value).toMatchObject({ workerPool: true, controllerReadOnly: true, nativeWorkflows: false, workerMcpPrefix: "factory-workers-pool___" });
    expect(value.subscriptionProfile).toBe("team1");
    expect(() => { (value as { workerPool: boolean }).workerPool = false; }).toThrow();
    expect(() => Object.defineProperty(value, "workerPool", { value: false })).toThrow();
  });
  it.each(["factory-workers-team1___", "factory-workers-team2___", "factory-workers-pool-other___"])("rejects a pooled controller using namespace %s", workerMcpPrefix => {
    expect(() => config({ controllerReadOnly: true, workerPool: true, workerControlFile: "/fixture/control.json", workerMcpPrefix })).toThrow(/exact supervised pool/);
  });
  it("accepts the pool only through a boolean operator setting on a read-only subscription controller", () => {
    const connection = { workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-pool___" };
    expect(() => config({ ...connection, workerPool: true })).toThrow(/read-only subscription Desktop/);
    expect(() => config({ ...connection, controllerReadOnly: true, workerPool: "true" as never })).toThrow(/boolean/);
    expect(() => config({ ...connection, controllerReadOnly: true, workerPool: true, desktopJobs: false })).toThrow(/read-only subscription Desktop/);
    vi.stubEnv("BRIDGE_WORKER_POOL", "1");
    expect(() => config({ ...connection, controllerReadOnly: true })).toThrow(/own fixed seat/);
  });
  it("keeps legacy account-pool and API routes forbidden with a supervised worker pool", () => {
    const connection = { controllerReadOnly: true, workerPool: true, workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-pool___" };
    expect(() => config({ ...connection, claudePool: [{ id: "team1", weight: 1 }] })).toThrow(/pool, custom executable or API routing/);
    expect(() => config({ ...connection, upstreamBaseUrl: "https://example.invalid" })).toThrow(/pool, custom executable or API routing/);
  });
  it("keeps all eight controller account identities private and immutable", () => {
    const original = accounts(), value = controllerPool({ subscriptionAccounts: original });
    expect(value.controllerPool).toBe(true);
    expect(value.subscriptionAccounts).toHaveLength(8);
    expect(Object.keys(value)).not.toContain("subscriptionAccounts");
    expect(JSON.stringify(value)).not.toContain("@example.invalid");
    expect(Object.isFrozen(value.subscriptionAccounts)).toBe(true);
    expect(Object.isFrozen(value.subscriptionAccounts![0])).toBe(true);
    expect(Object.isFrozen(value.subscriptionAccounts![0]!.env)).toBe(true);
    expect(value.subscriptionAccounts![0]!.env).not.toBe(original[0]!.env);
    expect(() => Object.defineProperty(value, "controllerPool", { value: false })).toThrow();
  });
  it("requires explicit controller-pool opt-in and the guarded worker-pool controller", () => {
    expect(() => controllerPool({ controllerPool: false })).toThrow(/require explicit controller pool/);
    expect(() => controllerPool({ controllerPool: "true" as never })).toThrow(/boolean/);
    expect(() => controllerPool({ workerPool: false })).toThrow(/controller pool requires/);
    expect(() => controllerPool({ controllerReadOnly: false })).toThrow(/controller pool requires/);
    expect(() => controllerPool({ desktopJobs: false })).toThrow(/controller pool requires/);
    vi.stubEnv("BRIDGE_CONTROLLER_POOL", "1");
    expect(config().controllerPool).toBe(false);
  });
  it.each([
    (value: SubscriptionAccount[]) => value.slice(0, 7),
    (value: SubscriptionAccount[]) => [...value.slice(0, 7), value[0]!],
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, expectedEmail: value[0]!.expectedEmail } : item),
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, env: value[0]!.env } : item),
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, weight: 0 } : item),
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, env: { ...item.env, ANTHROPIC_API_KEY: "private-sentinel" } } : item),
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, env: { ...item.env, NODE_OPTIONS: "private-sentinel" } } : item),
    (value: SubscriptionAccount[]) => value.map((item, index) => index === 7 ? { ...item, env: { ...item.env, CLAUDE_CONFIG_DIR: "relative" } } : item),
  ])("rejects malformed, duplicate, unsanitized or incomplete controller accounts", alter => {
    try { controllerPool({ subscriptionAccounts: alter(accounts()) }); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).toContain("eight distinct, clean"); expect(String(error)).not.toContain("private-sentinel"); }
  });
  it("rejects a controller pool whose initial email or native directory does not match", () => {
    expect(() => controllerPool({ subscriptionExpectedEmail: "other@example.invalid" })).toThrow(/matching its initial identity/);
    expect(() => controllerPool({ subscriptionAccounts: undefined })).toThrow(/eight distinct, clean/);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/fixture/not-selected");
    expect(() => config({ controllerReadOnly: true, workerPool: true, controllerPool: true, workerControlFile: "/fixture/control.json",
      workerMcpPrefix: "factory-workers-pool___", subscriptionAccounts: accounts() })).toThrow(/matching its initial identity/);
  });
  it("accepts the exact installed Factory MCP namespace and rejects ambiguous prefixes", () => {
    expect(config({ workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-team1___" }).workerMcpPrefix).toBe("factory-workers-team1___");
    expect(() => config({ workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-team1" })).toThrow(/exact MCP namespace/);
  });
  it("admits the fixed subscription route without enabling native Workflow", () => {
    const value = config();
    expect(value).toMatchObject({ authMode: "subscription", desktopJobs: true, nativeWorkflows: false });
    expect(value.subscriptionProfile).toBe("team1");
    expect(JSON.stringify(value)).not.toContain("fixture@example.invalid");
    expect(Object.keys(value)).not.toContain("subscriptionProfile");
    expect(() => { value.subscriptionProfile = "team2"; }).toThrow();
    expect(workflowAllowed(value, undefined)).toBe(false);
  });
  it.each([
    { subscriptionProfile: undefined }, { subscriptionProfile: "team9" as never },
    { subscriptionExpectedEmail: undefined }, { subscriptionExpectedEmail: " " },
  ])("requires private fixed seat and expected identity %j", changes => {
    expect(() => config(changes)).toThrow(/private fixed Team/);
  });
  it.each(["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"] as const)("accepts immutable operator-selected %s", subscriptionProfile => {
    const value = config({ subscriptionProfile });
    expect(value.subscriptionProfile).toBe(subscriptionProfile);
    expect(Object.keys(value)).not.toContain("subscriptionProfile");
    expect(() => { value.subscriptionProfile = subscriptionProfile === "team1" ? "team8" : "team1"; }).toThrow();
  });
  it("does not accept a seat or identity supplied only through environment variables", () => {
    vi.stubEnv("BRIDGE_SUBSCRIPTION_PROFILE", "team1");
    vi.stubEnv("BRIDGE_SUBSCRIPTION_EXPECTED_EMAIL", "fixture@example.invalid");
    expect(() => config({ subscriptionProfile: undefined, subscriptionExpectedEmail: undefined })).toThrow(/private fixed Team/);
  });
  it.each(["ANTHROPIC_API_KEY", "BRIDGE_OPENROUTER_API_KEY", "OPENROUTER_API_KEY", "BRIDGE_API_KEY_HELPER", "CLAUDE_CODE_OAUTH_TOKEN"])("rejects %s without echoing its value", name => {
    vi.stubEnv(name, "secret-sentinel");
    expect(() => config()).toThrow(/environment credentials/);
    try { config(); } catch (error) { expect(String(error)).not.toContain("secret-sentinel"); }
  });
  it.each([
    { upstreamBaseUrl: "https://example.invalid" }, { claudePool: [{ id: "team1", weight: 1 }] as never },
    { claudeExecutable: "/fixture/claude" },
  ])("rejects routes outside the fixed subscription boundary %j", changes => {
    expect(() => config(changes)).toThrow(/pool, custom executable or API routing/);
  });
  it("requires one exact unprefixed Opus model", () => {
    expect(() => config({ models: [{ id: "team2/opus", model: "claude-opus-5-5", displayName: "fixture" }] })).toThrow(/fixed unprefixed/);
  });
  it("takes the shared lease seat only from immutable operator config", async () => {
    const value = config();
    const runtime = { kind: "fake", close: vi.fn(async () => {}) } as unknown as BridgeRuntime;
    const app = createBridgeApp(value, createLogger(value.logDir), join(value.sandboxDir, "canary"), runtime);
    try {
      const input = { factorySession: { sessionId: "factory-one", cwd: "/fixture/worktree", launchId: "launch-one",
        desktopLifecycle: true, subscriptionProfile: "team4" } } as unknown as RuntimeRequest;
      expect(captured.options).toMatchObject({ runtimePackagePath: "/fixture/runtime", stateRoot: "/fixture/state", maxRunning: 2 });
      expect(captured.options!.getBinding(input)).toEqual({ sessionId: "factory-one", cwd: "/fixture/worktree", launchId: "launch-one", subscriptionProfile: "team1" });
      expect(captured.options!.getBinding({ factorySession: { ...input.factorySession, desktopLifecycle: false } } as RuntimeRequest)).toBeUndefined();
    } finally {
      await app.close().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error; });
    }
  });
  it("takes primary-checkout policy only from immutable controller config", async () => {
    const value = config({ controllerReadOnly: true, workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-team1___" });
    const runtime = { kind: "fake", close: vi.fn(async () => {}) } as unknown as BridgeRuntime;
    const app = createBridgeApp(value, createLogger(value.logDir), join(value.sandboxDir, "canary"), runtime);
    try {
      const input = { factorySession: { sessionId: "factory-one", cwd: "/fixture/primary", desktopLifecycle: true,
        workspacePolicy: "writable", subscriptionProfile: "team4" } } as unknown as RuntimeRequest;
      expect(captured.options!.getBinding(input)).toMatchObject({ cwd: "/fixture/primary", subscriptionProfile: "team1", workspacePolicy: "controller-readonly" });
      expect(() => Object.defineProperty(value, "controllerReadOnly", { value: false })).toThrow();
    } finally {
      await app.close().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error; });
    }
  });
});
