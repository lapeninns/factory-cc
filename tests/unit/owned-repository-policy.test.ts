import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const auth = vi.hoisted(() => ({ prepareSubscription: vi.fn() }));
vi.mock("../../src/workers/subscription-auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/workers/subscription-auth.js")>(),
  prepareSubscription: auth.prepareSubscription,
}));

import { APIWorkerService, type APIWorkerServiceOptions, type WorkerRunContext } from "../../src/workers/service.js";

const runtimeSupport = () => ({ executable: "/fixture/unmodified-claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" });
const git = (repository: string, args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
function complete(context: WorkerRunContext) {
  context.message({ type: "result", subtype: "success", is_error: false, session_id: "fixture-session", result: "Completed isolated repository check." });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Repository fixture did not complete.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("private owned-Git repository policy", () => {
  let root: string, listed: string, requested: string;
  const services: APIWorkerService[] = [];
  function repository(name: string, commit = true) {
    const path = join(root, name); mkdirSync(path);
    git(path, ["init", "-q"]);
    writeFileSync(join(path, "tracked.txt"), "committed\n");
    if (commit) {
      git(path, ["add", "tracked.txt"]);
      git(path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    }
    return path;
  }
  function service(changes: Partial<APIWorkerServiceOptions> = {}) {
    const index = services.length;
    const value = new APIWorkerService({
      stateRoot: join(root, "state-" + index), workspaceRoot: join(root, "workers-" + index),
      allowedRepositories: [listed], provider: { kind: "subscription", profile: "team1" },
      maxMs: 5000, maxTurns: 2, verifyRuntime: runtimeSupport, run: async context => complete(context), ...changes,
    });
    services.push(value); return value;
  }
  const start = (value: APIWorkerService, path: string) => value.start({ repository: path, task: "Inspect this disposable repository only.", workflow: "investigate" });
  beforeEach(() => {
    vi.clearAllMocks();
    root = realpathSync(mkdtempSync(join(tmpdir(), "owned-repositories-")));
    listed = repository("registered"); requested = repository("new repository");
    auth.prepareSubscription.mockResolvedValue({ env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root },
      expectedIdentity: { profile: "team1", email: "fixture@example.invalid", configDir: root }, runtime: runtimeSupport() });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(services.splice(0).map(value => value.close()));
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the default allowlist and ignores attempted request-side policy escalation", async () => {
    const value = service();
    await expect(value.start({ repository: requested, task: "fixture", workflow: "investigate", repositoryPolicy: "owned-git" } as Parameters<APIWorkerService["start"]>[0])).rejects.toThrow(/allowlist/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
  });

  it("runs an unregistered owned repository in a new worktree while preserving dirty source and untracked secrets", async () => {
    const head = git(requested, ["rev-parse", "HEAD"]), branch = git(requested, ["symbolic-ref", "HEAD"]);
    writeFileSync(join(requested, "tracked.txt"), "uncommitted source\n");
    writeFileSync(join(requested, ".env"), "FIXTURE_SECRET=do-not-copy\n");
    const before = git(requested, ["status", "--porcelain"]);
    const value = service({ repositoryPolicy: "owned-git", run: async context => {
      expect(context.worker.worktree).not.toBe(requested);
      expect(readFileSync(join(context.worker.worktree, "tracked.txt"), "utf8")).toBe("committed\n");
      expect(readdirSync(context.worker.worktree)).not.toContain(".env");
      writeFileSync(join(context.worker.worktree, "result.txt"), "worker-only\n"); complete(context);
    } });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
    expect(value.status(worker.id)).toMatchObject({ sourceCommit: head, sourceDirty: true, subscriptionProfile: "team1", cleanupVerified: true });
    expect(git(requested, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(requested, ["symbolic-ref", "HEAD"])).toBe(branch);
    expect(git(requested, ["status", "--porcelain"])).toBe(before);
    expect(readFileSync(join(requested, "tracked.txt"), "utf8")).toBe("uncommitted source\n");
  });

  it.each([{ allowedRepositories: [] }, { allowedRepositories: ["/missing/previously-registered-repository"] }])("does not depend on stale or empty registration lists: %j", async ({ allowedRepositories }) => {
    const value = service({ repositoryPolicy: "owned-git", allowedRepositories });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
  });

  it("rejects non-Git folders, non-root subfolders, bare repositories and repositories without a commit before authentication", async () => {
    const plain = join(root, "plain"); mkdirSync(plain);
    const child = join(requested, "child"); mkdirSync(child);
    const unborn = repository("unborn", false);
    const bare = join(root, "bare.git"); execFileSync("git", ["init", "--bare", "-q", bare]);
    const value = service({ repositoryPolicy: "owned-git" });
    for (const path of [plain, child, unborn, bare]) await expect(start(value, path)).rejects.toThrow();
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
    expect(value.list()).toEqual([]);
    expect(readdirSync(join(root, "workers-0"))).toEqual([]);
  });

  it("rejects symlinked repository paths and redirected Git metadata", async () => {
    const alias = join(root, "alias"); symlinkSync(requested, alias);
    const value = service({ repositoryPolicy: "owned-git" });
    await expect(start(value, alias)).rejects.toThrow(/canonical/);
    const redirected = join(root, "redirected-git"); renameSync(join(requested, ".git"), redirected); symlinkSync(redirected, join(requested, ".git"));
    await expect(start(value, requested)).rejects.toThrow(/metadata/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
  });

  it("rejects a directory not owned by the runtime user", async () => {
    const value = service({ repositoryPolicy: "owned-git" });
    const identity = process as { getuid: () => number };
    const actual = identity.getuid();
    vi.spyOn(identity, "getuid").mockReturnValue(actual + 1);
    await expect(start(value, requested)).rejects.toThrow(/owned/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
  });

  it("does not allow API routes or invalid policy values to opt into owned repository access", () => {
    expect(() => service({ repositoryPolicy: "owned-git", provider: { kind: "anthropic" }, maxBudgetUsd: 1 })).toThrow(/subscription worker policy/);
    expect(() => service({ repositoryPolicy: "anywhere" as "owned-git" })).toThrow(/subscription worker policy/);
    expect(() => service({ repositoryPolicy: null as unknown as "owned-git" })).toThrow(/subscription worker policy/);
  });
});
