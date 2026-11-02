import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { createBridgeApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import type { DesktopJobsOptions } from "../../src/runtime/desktop-jobs.js";
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
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(BRIDGE_|ANTHROPIC_|CLAUDE_|OPENROUTER_)/.test(name)) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  captured.options = undefined;
});

describe("fixed subscription Desktop admission", () => {
  it("refuses a read-only controller paired with another seat's worker namespace", () => {
    expect(() => config({ controllerReadOnly: true, workerControlFile: "/fixture/control.json", workerMcpPrefix: "factory-workers-team8___" })).toThrow(/own fixed seat/);
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
