import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "../../src/upstream/auth-env.js";
import { selectionFromConfig } from "../../src/upstream/providers.js";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { parseApiWorkflowArgs, runApiWorkflows } from "../../scripts/api-workflows.js";

vi.mock("../../src/runtime/native-workflow-support.js", () => ({
  assertNativeWorkflowSupport: () => ({ executable: "/fixture/claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture-digest" }),
}));

const dirs: string[] = [];
function cfg(overrides: Partial<BridgeConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "api-workflow-config-")); dirs.push(dataDir);
  return loadConfig({ dataDir, mode: "sdk", desktopProfile: true, nativeWorkflows: true, authMode: "anthropic-api", permissionMode: "ask", ...overrides });
}
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (/^(BRIDGE_|ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR)/.test(k)) vi.stubEnv(k, undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-api-credential-not-sent");
  vi.stubEnv("BRIDGE_WORKFLOW_MAX_BUDGET_USD", "1.25");
});
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("explicit API native workflow admission", () => {
  it("defaults off without changing ordinary session capacity", () => { const c = cfg({ nativeWorkflows: false }); expect(c.nativeWorkflows).toBe(false); expect(c.maxSessions).toBe(32); });
  it("uses one session and bounded declared budget/deadline", () => { const c = cfg(); expect(c.maxSessions).toBe(1); expect(c.workflowMaxBudgetUsd).toBe(1.25); expect(c.workflowMaxMs).toBe(1800000); });
  it.each(["subscription", "claude-config", "inherit", "byok", "cloud"] as const)("rejects %s auth", (authMode) => { expect(() => cfg({ authMode })).toThrow(/anthropic-api/); });
  it("rejects implicit credentials and OAuth fallback", () => { vi.stubEnv("ANTHROPIC_API_KEY", undefined); expect(() => cfg()).toThrow(/requires ANTHROPIC_API_KEY/); vi.stubEnv("ANTHROPIC_API_KEY", "fixture"); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "secret-sentinel"); expect(() => cfg()).toThrow(/auth/i); });
  it("accepts explicit absolute key helper", () => { vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("BRIDGE_API_KEY_HELPER", "/fixture/approved-helper"); expect(cfg().nativeWorkflows).toBe(true); });
  it.each(["0", "-1", "NaN", "Infinity", "no"])("rejects budget %s", (value) => { vi.stubEnv("BRIDGE_WORKFLOW_MAX_BUDGET_USD", value); expect(() => cfg()).toThrow(/positive finite/); });
  it("requires a declared budget", () => { vi.stubEnv("BRIDGE_WORKFLOW_MAX_BUDGET_USD", undefined); expect(() => cfg()).toThrow(/positive finite/); });
  it.each(["1", "999", "7200001", "NaN", "1.5"])("rejects deadline %s", (value) => { vi.stubEnv("BRIDGE_WORKFLOW_MAX_MS", value); expect(() => cfg()).toThrow(/1000 to 7200000/); });
  it.each(["true", "yes", "2"])("rejects ambiguous opt-in %s", (value) => { vi.stubEnv("BRIDGE_NATIVE_WORKFLOWS", value); expect(() => cfg()).toThrow(/must be 0 or 1/); });
  it("rejects account pools and direct account models", () => { vi.stubEnv("BRIDGE_CLAUDE_POOL", "team1=1"); expect(() => cfg()).toThrow(/account pool/); vi.stubEnv("BRIDGE_CLAUDE_POOL", undefined); expect(() => cfg({ models: [{ id: "team1/opus", model: "opus", displayName: "fixture" }] })).toThrow(/unprefixed/); });
  it("rejects route overrides and remote endpoints", () => { expect(() => cfg({ upstreamBaseUrl: "https://elsewhere.invalid" })).toThrow(/routing overrides/); vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.invalid"); expect(() => cfg()).toThrow(); });
  it("rejects bypass permissions, remote binding and concurrency expansion", () => { expect(() => cfg({ permissionMode: "bypass" })).toThrow(/ask permissions/); expect(() => cfg({ host: "0.0.0.0", allowRemote: true, allowedHosts: ["localhost"] })).toThrow(/loopback/); expect(() => cfg({ maxSessions: 2 })).toThrow(/MAX_SESSIONS=1/); });
  it("does not include credential values in admission errors", () => { vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "must-not-leak-secret"); try { cfg(); throw new Error("unexpected success"); } catch (error) { expect(String(error)).not.toContain("must-not-leak-secret"); } });
  it("validates launcher separation without starting anything", () => { const project = mkdtempSync(join(tmpdir(), "api-workflow-project-")); dirs.push(project); expect(parseApiWorkflowArgs(["--check", "--project", project, "--data-dir", project + "-state"]).port).toBe(18788); expect(() => parseApiWorkflowArgs(["--project", project, "--data-dir", project, "--port", "18787"])).toThrow(/reserved/); });
  it("check mode reports redacted config without creating service tokens or invoking a server", async () => {
    const project = mkdtempSync(join(tmpdir(), "api-check-project-")); dirs.push(project);
    const dataDir = project + "-state"; dirs.push(dataDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runApiWorkflows(["--check", "--project", project, "--data-dir", dataDir]);
      const report = JSON.parse(log.mock.calls[0]![0]);
      expect(report).toMatchObject({ mode: "api-native-workflows", port: 18788, credentialConfigured: true });
      expect(JSON.stringify(report)).not.toContain("fixture-api-credential");
      expect(existsSync(join(dataDir, "client-token"))).toBe(false);
      await runApiWorkflows(["--check", "--project", project, "--data-dir", dataDir]);
    } finally { log.mockRestore(); }
  });
  it("refuses existing unowned state such as a desktop bridge directory", async () => {
    const project = mkdtempSync(join(tmpdir(), "api-check-project-")); dirs.push(project);
    const dataDir = project + "-state"; mkdirSync(dataDir); dirs.push(dataDir);
    await expect(runApiWorkflows(["--check", "--project", project, "--data-dir", dataDir])).rejects.toThrow(/Refusing existing state/);
  });

  it("accepts an explicit private key file and restores the environment after check", async () => {
    const project = mkdtempSync(join(tmpdir(), "api-file-project-")); dirs.push(project);
    const dataDir = project + "-state"; dirs.push(dataDir);
    const keyFile = join(project, "api-key"); writeFileSync(keyFile, "file-credential-never-sent\n", { mode: 0o600 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.stubEnv("ANTHROPIC_API_KEY", undefined);
      await runApiWorkflows(["--check", "--project", project, "--data-dir", dataDir, "--api-key-file", keyFile]);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(log.mock.calls)).not.toContain("file-credential-never-sent");
    } finally { log.mockRestore(); }
  });
  it("refuses public, symbolic and malformed key files without printing credentials", async () => {
    const project = mkdtempSync(join(tmpdir(), "api-file-project-")); dirs.push(project);
    const dataDir = project + "-state"; dirs.push(dataDir);
    const keyFile = join(project, "api-key"); writeFileSync(keyFile, "secret-sentinel", { mode: 0o644 }); chmodSync(keyFile, 0o644);
    const args = ["--check", "--project", project, "--data-dir", dataDir, "--api-key-file", keyFile];
    await expect(runApiWorkflows(args)).rejects.toThrow(/owned private regular file/);
    chmodSync(keyFile, 0o600); const symbolic = join(project, "symlink"); symlinkSync(keyFile, symbolic);
    await expect(runApiWorkflows([...args.slice(0, -1), symbolic])).rejects.toThrow(/owned private regular file/);
    writeFileSync(keyFile, "secret-sentinel\nextra");
    await expect(runApiWorkflows(args)).rejects.toThrow(/owned private regular file/);
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-api-credential-not-sent");
  });

  it("requires SDK mode, desktop guards and the SDK-provided executable", () => {
    expect(() => cfg({ mode: "mock" })).toThrow(/sdk mode/);
    expect(() => cfg({ desktopProfile: false })).toThrow(/guarded desktop profile/);
    expect(() => cfg({ claudeExecutable: "/fixture/claude" })).toThrow(/custom Claude executable/);
    vi.stubEnv("BRIDGE_CLAUDE_EXECUTABLE", "/fixture/claude");
    expect(() => cfg()).toThrow(/custom Claude executable/);
  });
  it("rejects non-Anthropic and prefixed upstream model values", () => {
    expect(() => cfg({ models: [{ id: "friendly", model: "gpt-5", displayName: "fixture" }] })).toThrow(/unprefixed Anthropic/);
    expect(() => cfg({ models: [{ id: "friendly", model: "team1/opus", displayName: "fixture" }] })).toThrow(/unprefixed Anthropic/);
  });

  function openrouter(overrides: Partial<BridgeConfig> = {}) {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("BRIDGE_OPENROUTER_API_KEY", "fixture-router-key-not-sent");
    return cfg({ workflowProvider: "openrouter", authMode: "byok", upstreamBaseUrl: "https://openrouter.ai/api", upstreamModel: "anthropic/claude-opus-5.5", upstreamTokenEnv: "BRIDGE_OPENROUTER_API_KEY", ...overrides });
  }
  it("pins approved OpenRouter endpoint/model/key and emits only selected API credentials", () => {
    const c = openrouter();
    expect(c.models).toEqual([{ id: "claude-opus-5-5", model: "anthropic/claude-opus-5.5", displayName: "Opus 5.5 via OpenRouter" }]);
    const child = buildChildEnv("byok", process.env, selectionFromConfig({ baseUrl: c.upstreamBaseUrl, model: c.upstreamModel, tokenEnv: c.upstreamTokenEnv }));
    expect(child.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(child.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-5.5");
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("fixture-router-key-not-sent");
    expect(child.ANTHROPIC_API_KEY).toBe("");
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it.each([
    { upstreamBaseUrl: "https://openrouter.ai.evil.invalid/api" },
    { upstreamBaseUrl: "https://openrouter.ai/api/" },
    { upstreamModel: "anthropic/claude-sonnet-4" },
    { upstreamTokenEnv: "ANOTHER_ROUTER_KEY" },
    { authMode: "anthropic-api" as const },
    { models: [{ id: "alias", model: "anthropic/claude-opus-5.5", displayName: "fixture" }] },
  ])("rejects OpenRouter route drift %j", (overrides) => { expect(() => openrouter(overrides)).toThrow(/exact approved|OpenRouter workflows/); });
  it("keeps direct Anthropic as default and rejects provider ambiguity", () => {
    expect(cfg().workflowProvider).toBe("anthropic");
    vi.stubEnv("BRIDGE_WORKFLOW_PROVIDER", "arbitrary"); expect(() => cfg()).toThrow(/anthropic or openrouter/);
    vi.stubEnv("BRIDGE_WORKFLOW_PROVIDER", "openrouter"); expect(() => cfg()).toThrow(/OpenRouter workflows/);
  });
  it("refuses conflicting OAuth, direct API keys and missing router keys", () => {
    openrouter(); vi.stubEnv("ANTHROPIC_API_KEY", "direct-api-secret");
    expect(() => cfg({ workflowProvider: "openrouter", authMode: "byok", upstreamBaseUrl: "https://openrouter.ai/api", upstreamModel: "anthropic/claude-opus-5.5", upstreamTokenEnv: "BRIDGE_OPENROUTER_API_KEY" })).toThrow(/conflicting/);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "never-print-secret"); expect(() => openrouter()).toThrow(/conflicting/);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "never-print-secret"); expect(() => openrouter()).toThrow(/conflicting/);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined); vi.stubEnv("BRIDGE_OPENROUTER_API_KEY", undefined);
    expect(() => cfg({ workflowProvider: "openrouter", authMode: "byok", upstreamBaseUrl: "https://openrouter.ai/api", upstreamModel: "anthropic/claude-opus-5.5", upstreamTokenEnv: "BRIDGE_OPENROUTER_API_KEY" })).toThrow(/missing or empty/);
  });
  it("OpenRouter check reads only its private file and restores its credential environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("BRIDGE_OPENROUTER_API_KEY", undefined);
    const project = mkdtempSync(join(tmpdir(), "router-file-project-")); dirs.push(project);
    const dataDir = project + "-state"; dirs.push(dataDir);
    const keyFile = join(project, "api-key"); writeFileSync(keyFile, "router-secret-never-sent", { mode: 0o600 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runApiWorkflows(["--check", "--provider", "openrouter", "--project", project, "--data-dir", dataDir, "--api-key-file", keyFile]);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(process.env.BRIDGE_OPENROUTER_API_KEY).toBeUndefined();
      expect(JSON.parse(log.mock.calls[0]![0]).provider).toBe("openrouter");
      expect(JSON.stringify(log.mock.calls)).not.toContain("router-secret");
      await expect(runApiWorkflows(["--check", "--project", project, "--data-dir", dataDir, "--api-key-file", keyFile])).rejects.toThrow(/another target/);
    } finally { log.mockRestore(); }
  });

});
