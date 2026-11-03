import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareControllerWorkspaceMigration } from "../../src/http/app.js";
import { SessionStore } from "../../src/sessions/store.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { BridgeConfig } from "../../src/config.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const config = { controllerHostTools: true } as BridgeConfig;
function fixture() {
  const session: SessionRecord = { bridgeSessionId: "retained-controller", role: "orchestrator", state: "IDLE", model: "opus",
    sdkSessionId: "old-native", claudeAccount: "team2", nativeGeneration: 0, controllerWorkspacePolicy: "controller-readonly",
    retryableRequestHash: "old-retry", createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], toolNames: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true } };
  const runtime = { kind: "sdk", isSessionUsable: vi.fn(() => false), pendingHostCalls: vi.fn(() => []),
    protectedSessionIds: vi.fn(() => []), forget: vi.fn(async () => {}) } as unknown as BridgeRuntime;
  return { session, runtime };
}

describe("retained controller workspace capability migration", () => {
  it.each([undefined, "controller-readonly"] as const)("uses a fresh generation for old policy %s", async policy => {
    const { session, runtime } = fixture(); session.controllerWorkspacePolicy = policy;
    const before = structuredClone(session);
    const patch = await prepareControllerWorkspaceMigration(config, session, runtime);
    expect(patch).toEqual({ controllerWorkspacePolicy: "controller-host", nativeGeneration: 1,
      sdkSessionId: undefined, retryableRequestHash: undefined, state: "IDLE" });
    expect(runtime.forget).toHaveBeenCalledWith(session);
    expect(session).toEqual(before);
  });

  it("can migrate a failed pre-inference session without reviving ended work", async () => {
    const { session, runtime } = fixture(); session.state = "FAILED"; session.sdkSessionId = undefined;
    expect(await prepareControllerWorkspaceMigration(config, session, runtime)).toMatchObject({ state: "IDLE", nativeGeneration: 1 });
  });

  it.each(["NEW", "GENERATING", "RESUMING", "WAITING_DROID_TOOL", "CANCELLED"] as const)("refuses state %s", async state => {
    const { session, runtime } = fixture(); session.state = state;
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 409, code: "controller_workspace_migration_busy" });
    expect(runtime.forget).not.toHaveBeenCalled();
  });

  it.each([
    { pendingToolIds: ["tool-one"] }, { endedToolIds: ["old-unresolved-tool"] }, { cancelRequested: true },
    { hostEnded: "terminal" }, { hostEnded: "resumable" }, { hostEnded: "interrupted" },
  ] as Partial<SessionRecord>[])("refuses persisted pending or ended state %j", async patch => {
    const { session, runtime } = fixture(); Object.assign(session, patch);
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 409 });
    expect(runtime.forget).not.toHaveBeenCalled();
  });

  it("refuses any live native query or callback before changing persisted identity", async () => {
    const { session, runtime } = fixture(); vi.mocked(runtime.isSessionUsable!).mockReturnValue(true);
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 409 });
    vi.mocked(runtime.isSessionUsable!).mockReturnValue(false);
    vi.mocked(runtime.pendingHostCalls!).mockReturnValue([{ toolUseId: "live", toolName: "Read", input: {} }]);
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 409 });
    expect(runtime.forget).not.toHaveBeenCalled();
  });

  it("rechecks activity after retirement and propagates retirement failure", async () => {
    const { session, runtime } = fixture();
    vi.mocked(runtime.forget!).mockImplementation(async () => { vi.mocked(runtime.isSessionUsable!).mockReturnValue(true); });
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 409 });
    vi.mocked(runtime.isSessionUsable!).mockReturnValue(false);
    vi.mocked(runtime.forget!).mockRejectedValue(new Error("cleanup unproven"));
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toThrow("cleanup unproven");
    expect(session.controllerWorkspacePolicy).toBe("controller-readonly");
  });

  it("refuses overflow and unknown policy values", async () => {
    const { session, runtime } = fixture(); session.nativeGeneration = 1_000_000;
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 422 });
    session.nativeGeneration = 0; session.controllerWorkspacePolicy = "forged" as never;
    await expect(prepareControllerWorkspaceMigration(config, session, runtime)).rejects.toMatchObject({ status: 422 });
  });

  it("does not change current host-policy sessions or disabled configurations", async () => {
    const { session, runtime } = fixture(); session.controllerWorkspacePolicy = "controller-host";
    expect(await prepareControllerWorkspaceMigration(config, session, runtime)).toBeUndefined();
    session.controllerWorkspacePolicy = "controller-readonly";
    expect(await prepareControllerWorkspaceMigration({ controllerHostTools: false } as BridgeConfig, session, runtime)).toBeUndefined();
    expect(runtime.forget).not.toHaveBeenCalled();
  });

  it("persists the new capability and generation without replacing account or history", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-migration-")); roots.push(root);
    const store = new SessionStore(root, true, 5);
    const record = store.create({ role: "orchestrator", model: "opus", toolNames: [], claudeAccount: "team2",
      nativeGeneration: 0, controllerWorkspacePolicy: "controller-readonly", historyMessageHashes: ["one", "two"] });
    store.setState(record.bridgeSessionId, "IDLE");
    const { runtime } = fixture();
    const patch = await prepareControllerWorkspaceMigration(config, record, runtime);
    store.update(record.bridgeSessionId, patch!);
    const restored = new SessionStore(root, true, 5).require(record.bridgeSessionId);
    expect(restored).toMatchObject({ controllerWorkspacePolicy: "controller-host", nativeGeneration: 1,
      claudeAccount: "team2", historyMessageHashes: ["one", "two"] });
  });
});
