import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { acquireDesktopJobLease, updateDesktopJobRecord } from "../../src/runtime/desktop-jobs.js";

it("uses the bundled Python helper for a real folder lease and terminal update", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-package-")));
  const options = {
    pythonExecutable: execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(),
    runtimePackagePath: resolve("native-runtime"),
    stateRoot: join(root, "state"),
    admissionTimeoutMs: 10_000,
    releaseTimeoutMs: 5_000,
  };
  const request = {
    factorySessionId: "package-factory", bridgeSessionId: "package-bridge", cwd: root,
    role: "chat" as const, subscriptionProfile: "team8" as const, workspacePolicy: "controller-host" as const,
  };
  let lease: Awaited<ReturnType<typeof acquireDesktopJobLease>> | undefined;
  try {
    lease = await acquireDesktopJobLease(options, request, new AbortController().signal);
    const record = () => JSON.parse(readFileSync(join(options.stateRoot, "jobs", lease!.jobId + ".json"), "utf8"));
    expect(record()).toMatchObject({ state: "running", profile: "team8", authMode: "subscription",
      workspacePolicy: "controller-host", workspaceKind: "directory", worktree: root });
    await lease.release({ state: "idle", cleanupVerified: true, usage: { input_tokens: 7, output_tokens: 3 } });
    expect(record()).toMatchObject({ state: "idle", externalCleanupRequired: false });
    await updateDesktopJobRecord(options, request, { state: "completed", cleanupVerified: true });
    // The lease records the bridge's confirmation without claiming it has
    // independently inspected the bridge-owned process tree.
    expect(record()).toMatchObject({ state: "completed", reason: "bridge_confirmed_session_end",
      cleanupVerified: null, externalCleanupRequired: false });
  } finally {
    if (lease) await lease.release({ state: "cancelled", cleanupVerified: true }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
