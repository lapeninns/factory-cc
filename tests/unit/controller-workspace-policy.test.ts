import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { validateDesktopJobBinding, DesktopJobsRuntime, type DesktopJobBinding, type DesktopJobLease } from "../../src/runtime/desktop-jobs.js";
import type { BridgeRuntime, RuntimeRequest } from "../../src/runtime/types.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "controller-policy-"))); roots.push(root);
  const primary = join(root, "primary"); mkdirSync(primary); mkdirSync(join(primary, ".git"));
  const linked = join(root, "linked"); mkdirSync(linked); writeFileSync(join(linked, ".git"), "gitdir: /fixture/linked");
  return { root, primary, linked };
}
function config(extra: Partial<BridgeConfig> = {}) {
  const { root } = fixture();
  return loadConfig({ mode: "sdk", authMode: "subscription", desktopProfile: true, desktopLifecycle: true,
    desktopJobs: true, desktopRuntimePath: root, desktopStateRoot: join(root, "state"), dataDir: join(root, "data"),
    subscriptionProfile: "team1", subscriptionExpectedEmail: "fixture@example.invalid", controllerReadOnly: true,
    workerControlFile: join(root, "control.json"), workerMcpPrefix: "factory-workers-team1___",
    models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "fixture" }], ...extra });
}
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(BRIDGE_|ANTHROPIC_|CLAUDE_|OPENROUTER_)/.test(name)) vi.stubEnv(name, undefined);
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("trusted read-only controller workspace policy", () => {
  it("admits a primary checkout only with the fixed-seat controller policy", () => {
    const { primary, linked } = fixture();
    const base = { sessionId: "factory", cwd: primary, subscriptionProfile: "team1" as const };
    expect(() => validateDesktopJobBinding(base)).toThrow(/dedicated Git worktree/);
    expect(validateDesktopJobBinding({ ...base, workspacePolicy: "controller-readonly" }).cwd).toBe(primary);
    expect(validateDesktopJobBinding({ ...base, cwd: linked }).cwd).toBe(linked);
    const invalidPolicy = expect.objectContaining({ status: 400, code: "desktop_workspace_policy" });
    expect(() => validateDesktopJobBinding({ sessionId: "factory", cwd: primary, workspacePolicy: "controller-readonly" })).toThrowError(invalidPolicy);
    expect(() => validateDesktopJobBinding({ ...base, workspacePolicy: "writer" } as unknown as DesktopJobBinding)).toThrowError(invalidPolicy);
  });
  it("uses an immutable explicit operator flag and rejects incompatible routes", () => {
    const value = config();
    expect(value.controllerReadOnly).toBe(true);
    expect(() => { (value as { controllerReadOnly: boolean }).controllerReadOnly = false; }).toThrow();
    for (const change of [{ authMode: "inherit" }, { desktopJobs: false }, { mode: "fake" }, { workerControlFile: undefined }, { workerMcpPrefix: undefined }]) {
      expect(() => config(change as Partial<BridgeConfig>)).toThrow();
    }
    vi.stubEnv("BRIDGE_CONTROLLER_READ_ONLY", "1");
    expect(config({ controllerReadOnly: undefined }).controllerReadOnly).toBe(false);
  });
  it("passes and permanently binds the trusted workspace policy, and refuses worker-role widening", async () => {
    const { primary } = fixture();
    const binding: DesktopJobBinding = { sessionId: "factory", cwd: primary, subscriptionProfile: "team1", workspacePolicy: "controller-readonly" };
    const acquire = vi.fn(async (): Promise<DesktopJobLease> => ({ jobId: "fixture", release: async () => {} }));
    const inner = { kind: "fake", handle: vi.fn(async () => ({ response: { usage: {} }, pendingToolIds: [] })), cancel: async () => {}, deliverResults: async () => [] } as unknown as BridgeRuntime;
    const runtime = new DesktopJobsRuntime(inner, { pythonExecutable: "/usr/bin/python3", runtimePackagePath: "/fixture", stateRoot: "/fixture", getBinding: () => binding, acquireLease: acquire });
    const request = { role: "chat", session: { bridgeSessionId: "bridge" } } as RuntimeRequest;
    await runtime.handle(request);
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ workspacePolicy: "controller-readonly", subscriptionProfile: "team1", cwd: primary }), expect.any(AbortSignal));
    await expect(runtime.handle({ ...request, session: { ...request.session, bridgeSessionId: "forged-worker" }, role: "worker" })).rejects.toMatchObject({ code: "desktop_workspace_policy" });
    binding.workspacePolicy = undefined;
    await expect(runtime.handle(request)).rejects.toThrow();
  });
});
