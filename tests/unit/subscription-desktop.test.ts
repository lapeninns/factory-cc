import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubscriptionDesktop, runSubscriptionDesktop } from "../../scripts/subscription-desktop.js";
import { prepareSubscription } from "../../src/workers/subscription-auth.js";
import { createBridgeApp } from "../../src/http/app.js";

vi.mock("../../src/workers/subscription-auth.js", () => ({ prepareSubscription: vi.fn(async (profile: string) => ({
  env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: "/fixture/private-config", CLAUDE_CODE_EFFORT_LEVEL: "medium" },
  expectedIdentity: { profile, email: "fixture@example.invalid", configDir: "/fixture/private-config" },
})) }));
vi.mock("../../src/http/app.js", () => ({ createBridgeApp: vi.fn(() => ({ url: "http://127.0.0.1:18790" })), listen: vi.fn(async () => {}) }));
vi.mock("../../src/index.js", () => ({ installShutdownHandlers: vi.fn() }));

let root: string, project: string, data: string, args: string[], environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), "subscription-desktop-")));
  const repository = join(root, "repository"); project = join(root, "worktree"); data = join(root, "data");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  execFileSync("git", ["-C", repository, "worktree", "add", "--detach", "-q", project]);
  args = ["--profile", "team1", "--project", project, "--data-dir", data, "--runtime-path", join(root, "runtime"), "--state-root", join(root, "shared-state"),
    "--worker-control", join(root, "worker-control.json"), "--worker-mcp-prefix", "factory-workers-team1___"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
  Object.assign(process.env, environment);
  vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(root, { recursive: true, force: true });
});

function ownedState() {
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(data, "subscription-desktop.json"), JSON.stringify({ profile: "team1", project }), { mode: 0o600 });
  for (const [index, name] of ["client", "admin", "hook"].entries()) writeFileSync(join(data, name + "-token"), String(index + 1).repeat(64), { mode: 0o600 });
}

describe("subscription Desktop launcher", () => {
  it.each(["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"])("accepts the fixed %s connection", profile => {
    const selected = args.map(value => value === "team1" ? profile : value === "factory-workers-team1___" ? `factory-workers-${profile}___` : value);
    expect(parseSubscriptionDesktop(selected).profile).toBe(profile);
  });
  it.each(["team0", "team9", "pool"])("rejects unsupported %s before authentication", async profile => {
    await expect(runSubscriptionDesktop(args.map(value => value === "team1" ? profile : value))).rejects.toThrow(/assigned Team profile/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });
  it("requires explicit absolute shared paths and accepts an owned primary checkout for its read-only controller", () => {
    expect(parseSubscriptionDesktop(args)).toMatchObject({ profile: "team1", runtimePath: join(root, "runtime"), stateRoot: join(root, "shared-state") });
    expect(() => parseSubscriptionDesktop(args.filter((_value, index) => ![6, 7, 8, 9].includes(index)))).toThrow(/runtime and state/);
    expect(() => parseSubscriptionDesktop(args.map((value, index) => index === 9 ? "relative" : value))).toThrow(/runtime and state/);
    expect(parseSubscriptionDesktop(args.map(value => value === project ? join(root, "repository") : value)).project).toBe(join(root, "repository"));
    expect(() => parseSubscriptionDesktop(args.slice(0, -4))).toThrow(/worker-control/);
  });
  it("accepts an empty precreated private directory during check without writing or changing the environment", async () => {
    mkdirSync(data, { mode: 0o700 });
    const before = { ...process.env };
    await runSubscriptionDesktop([...args, "--check"]);
    expect(readdirSync(data)).toEqual([]);
    expect(process.env).toEqual(before);
    expect(createBridgeApp).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ desktopJobs: true, modelRequestsMade: false });
  });
  it("launches with shared admission and immutable private seat configuration", async () => {
    mkdirSync(data, { mode: 0o700 });
    process.env.ANTHROPIC_API_KEY = "secret-sentinel";
    await runSubscriptionDesktop(args);
    const config = vi.mocked(createBridgeApp).mock.calls[0]![0];
    expect(config).toMatchObject({ desktopJobs: true, desktopLifecycle: true, controllerReadOnly: true, nativeWorkflows: false,
      desktopRuntimePath: join(root, "runtime"), desktopStateRoot: join(root, "shared-state"), authMode: "subscription" });
    expect(config.subscriptionProfile).toBe("team1");
    expect(config.subscriptionExpectedEmail).toBe("fixture@example.invalid");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(readFileSync(join(data, "subscription-desktop.json"), "utf8"))).toMatchObject({ profile: "team1", project, stateRoot: join(root, "shared-state") });
  });
  it("accepts existing private state for this exact profile and project", async () => {
    ownedState();
    await runSubscriptionDesktop([...args, "--check"]);
    expect(prepareSubscription).toHaveBeenCalledWith("team1");
  });
  it("rejects nonempty foreign state before authentication and leaves it unchanged", async () => {
    mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, "foreign"), "keep");
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow();
    expect(prepareSubscription).not.toHaveBeenCalled();
    expect(readFileSync(join(data, "foreign"), "utf8")).toBe("keep");
  });
  it("rejects public data directories", async () => {
    mkdirSync(data, { mode: 0o755 }); chmodSync(data, 0o755);
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow(/Unsafe private data/);
  });
  it.each(["subscription-desktop.json", "client-token", "admin-token", "hook-token"])("rejects public or symbolic private state file %s", async name => {
    ownedState(); const path = join(data, name);
    chmodSync(path, 0o644);
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow(/Unsafe private subscription state/);
    chmodSync(path, 0o600); const outside = join(root, "outside");
    writeFileSync(outside, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(outside, path);
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow(/Unsafe private subscription state/);
  });
  it("rejects a symbolic data directory and a changed seat", async () => {
    const outside = join(root, "outside"); mkdirSync(outside, { mode: 0o700 }); symlinkSync(outside, data);
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow(/Unsafe private data/);
    rmSync(data); ownedState();
    await expect(runSubscriptionDesktop(args.map(value => value === "team1" ? "team2" : value))).rejects.toThrow(/another profile/);
    expect(existsSync(join(data, "client-token"))).toBe(true);
  });
});
