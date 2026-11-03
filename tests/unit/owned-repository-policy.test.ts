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
      expect(readFileSync(join(context.worker.worktree, "tracked.txt"), "utf8")).toBe("uncommitted source\n");
      expect(readdirSync(context.worker.worktree)).not.toContain(".env");
      writeFileSync(join(context.worker.worktree, "result.txt"), "worker-only\n"); complete(context);
    } });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
    expect(value.status(worker.id)).toMatchObject({ sourceCommit: head, sourceDirty: true, subscriptionProfile: "team1", cleanupVerified: true });
    expect(value.status(worker.id).inputCommit).not.toBe(head);
    expect(value.status(worker.id).inputSnapshot?.excluded).toContainEqual({ path: ".env", reason: "Credential or private environment file" });
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

  it("rejects non-Git folders, bare repositories and repositories without a commit before authentication", async () => {
    const plain = join(root, "plain"); mkdirSync(plain);
    const unborn = repository("unborn", false);
    const bare = join(root, "bare.git"); execFileSync("git", ["init", "--bare", "-q", bare]);
    const value = service({ repositoryPolicy: "owned-git" });
    for (const path of [plain, unborn, bare]) await expect(start(value, path)).rejects.toThrow();
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
    expect(value.list()).toEqual([]);
    expect(readdirSync(join(root, "workers-0"))).toEqual([]);
  });

  it("maps a repository subdirectory into its isolated snapshot and bounds writes there", async () => {
    const child = join(requested, "child"); mkdirSync(child);
    writeFileSync(join(child, "input.txt"), "untracked input\n");
    let denied: unknown;
    const value = service({ repositoryPolicy: "owned-git", run: async context => {
      expect(context.options.cwd).toBe(join(context.worker.worktree, "child"));
      expect(readFileSync(join(context.options.cwd!, "input.txt"), "utf8")).toBe("untracked input\n");
      denied = await context.options.canUseTool!("Write", { file_path: join(context.worker.worktree, "outside.txt"), content: "blocked" }, { signal: context.options.abortController!.signal, toolUseID: "outside", requestId: "request" });
      complete(context);
    } });
    const worker = await start(value, child);
    await until(() => value.status(worker.id).state === "completed");
    expect(denied).toMatchObject({ behavior: "deny" });
    expect(readFileSync(join(child, "input.txt"), "utf8")).toBe("untracked input\n");
  });

  it.each([false, true])("snapshots an owned ordinary or unborn folder without changing its original Git state (%s)", async unborn => {
    const source = join(root, unborn ? "new-repo" : "ordinary-folder"); mkdirSync(source);
    if (unborn) git(source, ["init", "-q"]);
    writeFileSync(join(source, "notes.txt"), "source note\n");
    writeFileSync(join(source, ".env"), "SECRET=fixture\n");
    const value = service({ repositoryPolicy: "owned-workspace", allowedRepositories: [], run: async context => {
      expect(readFileSync(join(context.worker.worktree, "notes.txt"), "utf8")).toBe("source note\n");
      expect(readdirSync(context.worker.worktree)).not.toContain(".env");
      expect(git(context.worker.worktree, ["status", "--porcelain"])).toBe("");
      writeFileSync(join(context.worker.worktree, "result.txt"), "only in worker");
      complete(context);
    } });
    const worker = await start(value, source);
    await until(() => value.status(worker.id).state === "completed");
    expect(value.status(worker.id).sourceKind).toBe(unborn ? "unborn" : "folder");
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("source note\n");
    expect(readdirSync(source)).not.toContain("result.txt");
    expect(readdirSync(source).includes(".git")).toBe(unborn);
    if (unborn) expect(() => git(source, ["rev-parse", "--verify", "HEAD"])).toThrow();
  });

  it("rejects symlink escapes and tracked credentials before authentication", async () => {
    const value = service({ repositoryPolicy: "owned-workspace" });
    symlinkSync(join(listed, "tracked.txt"), join(requested, "escaped"));
    await expect(start(value, requested)).rejects.toThrow(/outside/);
    rmSync(join(requested, "escaped"));
    writeFileSync(join(requested, ".env"), "SECRET=fixture\n");
    git(requested, ["add", ".env"]);
    await expect(start(value, requested)).rejects.toThrow(/tracked credential/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
  });

  it("preserves internal symlinks and rejects broken links before starting", async () => {
    symlinkSync("tracked.txt", join(requested, "internal-link"));
    const value = service({ repositoryPolicy: "owned-workspace", run: async context => {
      expect(realpathSync(join(context.worker.worktree, "internal-link"))).toBe(join(context.worker.worktree, "tracked.txt"));
      complete(context);
    } });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
    symlinkSync("missing.txt", join(requested, "broken-link"));
    await expect(start(value, requested)).rejects.toThrow();
  });

  it("copies tracked project instructions and provider-free settings", async () => {
    mkdirSync(join(requested, ".factory", "skills", "qa"), { recursive: true });
    mkdirSync(join(requested, ".claude", "commands"), { recursive: true });
    mkdirSync(join(requested, ".codex", "skills", "review"), { recursive: true });
    writeFileSync(join(requested, ".factory", "skills", "qa", "SKILL.md"), "Run the project checks.\n");
    writeFileSync(join(requested, ".claude", "commands", "test.md"), "Run local tests.\n");
    writeFileSync(join(requested, ".codex", "skills", "review", "SKILL.md"), "Review the source.\n");
    writeFileSync(join(requested, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
    git(requested, ["add", "."]);
    const value = service({ repositoryPolicy: "owned-workspace", run: async context => {
      expect(readFileSync(join(context.worker.worktree, ".factory", "skills", "qa", "SKILL.md"), "utf8")).toContain("project checks");
      expect(readFileSync(join(context.worker.worktree, ".claude", "commands", "test.md"), "utf8")).toContain("local tests");
      expect(readFileSync(join(context.worker.worktree, ".codex", "skills", "review", "SKILL.md"), "utf8")).toContain("Review");
      expect(JSON.parse(readFileSync(join(context.worker.worktree, ".claude", "settings.json"), "utf8"))).toMatchObject({ permissions: { defaultMode: "default" } });
      complete(context);
    } });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
  });

  it("rejects credential-bearing project settings without copying their values", async () => {
    mkdirSync(join(requested, ".claude"));
    writeFileSync(join(requested, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "private-fixture-value" } }));
    git(requested, ["add", "."]);
    const value = service({ repositoryPolicy: "owned-workspace" });
    await expect(start(value, requested)).rejects.toThrow(/tracked credential/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
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
