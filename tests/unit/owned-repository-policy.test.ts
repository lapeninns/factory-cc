import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rootCertificates } from "node:tls";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

const auth = vi.hoisted(() => ({ prepareSubscription: vi.fn() }));
vi.mock("../../src/workers/subscription-auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/workers/subscription-auth.js")>(),
  prepareSubscription: auth.prepareSubscription,
}));

import { APIWorkerService, type APIWorkerServiceOptions, type WorkerRunContext } from "../../src/workers/service.js";
import { createWorkerServiceOptions } from "../../scripts/factory-workers.js";
import { inspectWorkerWorkspace, prepareWorkerWorkspace } from "../../src/workers/workspace.js";

const runtimeSupport = () => ({ executable: "/fixture/unmodified-claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" });
const git = (repository: string, args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
const publicFixture = generateKeyPairSync("ed25519");
const publicPem = publicFixture.publicKey.export({ format: "pem", type: "spki" }).toString();
const privatePem = publicFixture.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
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

  it.each([false, true])("admits an ordinary or unborn snapshot through the actual native lease (%s)", async unborn => {
    const source = join(root, unborn ? "new-repo" : "ordinary-folder"); mkdirSync(source);
    if (unborn) git(source, ["init", "-q"]);
    writeFileSync(join(source, "notes.txt"), "source note\n");
    writeFileSync(join(source, ".env"), "SECRET=fixture\n");
    const nativeState = join(root, "native-state");
    const options = createWorkerServiceOptions({
      enabled: true, provider: "subscription", subscriptionProfile: "team1",
      stateRoot: join(root, "state-native"), workspaceRoot: join(root, "workers-native"),
      allowedRepositories: [], repositoryPolicy: "owned-workspace",
      nativeRuntimePath: resolve("native-runtime"), sharedStateRoot: nativeState,
      port: 18999, clientTokenFile: join(root, "unused-token"), approvalGuardVerified: true,
      maxMs: 5000, maxTurns: 2,
    });
    const value = service({ ...options, run: async context => {
      expect(lstatSync(join(context.worker.worktree, ".git")).isFile()).toBe(true);
      const gitDirectory = realpathSync(git(context.worker.worktree, ["rev-parse", "--absolute-git-dir"]));
      const commonDirectory = realpathSync(resolve(context.worker.worktree, git(context.worker.worktree, ["rev-parse", "--git-common-dir"])));
      expect(gitDirectory).not.toBe(commonDirectory);
      expect(readFileSync(join(context.worker.worktree, "notes.txt"), "utf8")).toBe("source note\n");
      expect(readdirSync(context.worker.worktree)).not.toContain(".env");
      expect(git(context.worker.worktree, ["status", "--porcelain"])).toBe("");
      writeFileSync(join(context.worker.worktree, "result.txt"), "only in worker");
      complete(context);
    } });
    const worker = await start(value, source);
    await until(() => value.status(worker.id).state === "completed");
    expect(value.status(worker.id)).toMatchObject({
      sourceKind: unborn ? "unborn" : "folder", cleanupVerified: true, leaseReleased: true,
    });
    const jobs = readdirSync(join(nativeState, "jobs")).filter(name => name.endsWith(".json"));
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(nativeState, "jobs", jobs[0]!), "utf8")))
      .toMatchObject({ state: "completed", cleanupVerified: null, externalCleanupRequired: false, worktree: worker.worktree });
    expect(existsSync(worker.worktree + ".snapshot-source")).toBe(true);
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("source note\n");
    expect(readdirSync(source)).not.toContain("result.txt");
    expect(readdirSync(source).includes(".git")).toBe(unborn);
    if (unborn) expect(() => git(source, ["rev-parse", "--verify", "HEAD"])).toThrow();
  });

  it("removes only owned snapshot state when source verification fails during preparation", async () => {
    const source = join(root, "changing-folder"); mkdirSync(source);
    writeFileSync(join(source, "notes.txt"), "before\n");
    const inspected = await inspectWorkerWorkspace(source, true);
    writeFileSync(join(source, "notes.txt"), "changed\n");
    const target = join(root, "failed-worker");
    await expect(prepareWorkerWorkspace(inspected, target, "worker-fixture"))
      .rejects.toThrow(/changed during snapshot preparation/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(target + ".snapshot-source")).toBe(false);
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("changed\n");
  });

  it("refuses pre-existing snapshot paths without changing their files", async () => {
    const source = join(root, "existing-folder"); mkdirSync(source);
    writeFileSync(join(source, "notes.txt"), "source\n");
    const inspected = await inspectWorkerWorkspace(source, true);
    const target = join(root, "existing-worker"); mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "existing\n");
    await expect(prepareWorkerWorkspace(inspected, target, "worker-fixture"))
      .rejects.toThrow(/must be unused/);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("existing\n");
    expect(existsSync(target + ".snapshot-source")).toBe(false);
  });

  it("preserves a concurrently created workspace when its atomic ownership claim fails", async () => {
    const source = join(root, "racing-folder"); mkdirSync(source);
    writeFileSync(join(source, "notes.txt"), "source\n");
    const inspected = await inspectWorkerWorkspace(source, true);
    const target = join(root, "racing-worker");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(mkdirSync).mockImplementationOnce(((path, options) => {
      const result = actual.mkdirSync(path, options);
      actual.mkdirSync(target);
      writeFileSync(join(target, "foreign.txt"), "concurrent owner\n");
      return result;
    }) as typeof mkdirSync);
    await expect(prepareWorkerWorkspace(inspected, target, "worker-fixture"))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(join(target, "foreign.txt"), "utf8")).toBe("concurrent owner\n");
    expect(existsSync(target + ".snapshot-source")).toBe(false);
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

  it.each([
    ["verification-public.pem", publicPem],
    ["verification-public.key", publicPem],
    ["rsa-public.pem", generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "pem", type: "pkcs1" }).toString()],
    ["certificate.pem", rootCertificates[0]!],
  ])("copies a tracked validated public PEM into the worker snapshot: %s", async (name, content) => {
    writeFileSync(join(requested, name), content);
    git(requested, ["add", name]);
    const value = service({ repositoryPolicy: "owned-workspace", run: async context => {
      expect(readFileSync(join(context.worker.worktree, name), "utf8")).toBe(content);
      complete(context);
    } });
    const worker = await start(value, requested);
    await until(() => value.status(worker.id).state === "completed");
    expect(readFileSync(join(requested, name), "utf8")).toBe(content);
  });

  it.each([
    ["private key", privatePem],
    ["public key followed by private key", publicPem + privatePem],
    ["multiple public blocks", publicPem + publicPem],
    ["credential suffix", publicPem + "API_KEY=private-fixture-value\n"],
    ["credential prefix", "API_KEY=private-fixture-value\n" + publicPem],
    ["malformed public key", "-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----\n"],
    ["extra data inside DER", "-----BEGIN PUBLIC KEY-----\n" + Buffer.concat([
      publicFixture.publicKey.export({ format: "der", type: "spki" }), Buffer.from("private-fixture-value"),
    ]).toString("base64") + "\n-----END PUBLIC KEY-----\n"],
  ])("rejects a tracked PEM containing %s before authentication", async (_name, content) => {
    writeFileSync(join(requested, "verification-public.pem"), content);
    git(requested, ["add", "verification-public.pem"]);
    const value = service({ repositoryPolicy: "owned-workspace" });
    await expect(start(value, requested)).rejects.toThrow(/tracked credential/);
    expect(auth.prepareSubscription).not.toHaveBeenCalled();
    expect(readdirSync(join(root, "workers-0"))).toEqual([]);
  });

  it("keeps public PEM exceptions out of credential directories and untracked inputs", async () => {
    mkdirSync(join(requested, ".ssh"));
    writeFileSync(join(requested, ".ssh", "verification-public.pem"), publicPem);
    git(requested, ["add", ".ssh/verification-public.pem"]);
    await expect(inspectWorkerWorkspace(requested, true)).rejects.toThrow(/tracked credential/);
    git(requested, ["reset", "--", ".ssh/verification-public.pem"]);
    writeFileSync(join(requested, "untracked-public.pem"), publicPem);
    const source = await inspectWorkerWorkspace(requested, true);
    expect(source.snapshot.excluded).toContainEqual({ path: "untracked-public.pem", reason: "Credential or private environment file" });
  });

  it("rejects tracked public PEM symlinks before authentication", async () => {
    writeFileSync(join(requested, "public.txt"), publicPem);
    symlinkSync("public.txt", join(requested, "verification-public.pem"));
    git(requested, ["add", "verification-public.pem"]);
    const value = service({ repositoryPolicy: "owned-workspace" });
    await expect(start(value, requested)).rejects.toThrow(/public PEM input must be a regular file/);
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
