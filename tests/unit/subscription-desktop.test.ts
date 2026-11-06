import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubscriptionDesktop, runSubscriptionDesktop } from "../../scripts/subscription-desktop.js";
import { prepareSubscription } from "../../src/workers/subscription-auth.js";
import { createBridgeApp } from "../../src/http/app.js";

vi.mock("../../src/workers/subscription-auth.js", async original => {
  const actual = await original<typeof import("../../src/workers/subscription-auth.js")>();
  return { ...actual, prepareSubscription: vi.fn(async (profile: string) => {
    const configDir = profile === "team1" ? "/fixture/private-config" : `/fixture/private-config-${profile}`;
    return { env: actual.sanitizedSubscriptionEnvironment(process.env, configDir),
      expectedIdentity: { profile, email: profile === "team1" ? "fixture@example.invalid" : `${profile}@example.invalid`, configDir } };
  }) };
});
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

function pooledArgs() {
  return [...args.map(value => value === "factory-workers-team1___" ? "factory-workers-pool___" : value), "--worker-pool"];
}

describe("subscription Desktop launcher", () => {
  it("defaults host tools to routine autonomy and preserves explicit ask", () => {
    expect(parseSubscriptionDesktop(args).approvalPolicy).toBe("ask");
    expect(() => parseSubscriptionDesktop([...args, "--approval-policy", "bypass"])).toThrow(/requires explicit --host-tools/);
    const host = [...pooledArgs(), "--controller-pool", "--host-tools"];
    expect(parseSubscriptionDesktop(host).approvalPolicy).toBe("bypass");
    expect(parseSubscriptionDesktop([...host, "--approval-policy", "ask"]).approvalPolicy).toBe("ask");
    expect(parseSubscriptionDesktop([...host, "--approval-policy", "bypass"]).approvalPolicy).toBe("bypass");
    expect(() => parseSubscriptionDesktop([...host, "--approval-policy", "always"])).toThrow(/must be ask or bypass/);
    expect(() => parseSubscriptionDesktop([...host, "--approval-policy", "bypass", "--approval-policy", "ask"])).toThrow(/Invalid subscription Desktop arguments/);
  });

  it("persists approval bypass and refuses policy drift before authentication", async () => {
    const host = [...pooledArgs(), "--controller-pool", "--host-tools", "--approval-policy", "bypass"];
    await runSubscriptionDesktop(host);
    expect(vi.mocked(createBridgeApp).mock.calls[0]![0]).toMatchObject({ controllerApprovalPolicy: "bypass", permissionMode: "ask" });
    const marker = JSON.parse(readFileSync(join(data, "subscription-desktop.json"), "utf8"));
    expect(marker.approvalPolicy).toBe("bypass");
    vi.mocked(prepareSubscription).mockClear();
    await expect(runSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools", "--approval-policy", "ask", "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
    await runSubscriptionDesktop([...host, "--check"]);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({ approvalPolicy: "bypass", modelRequestsMade: false });
  });

  it("treats an older host-tools marker as ask and refuses an implicit upgrade to bypass", async () => {
    const host = [...pooledArgs(), "--controller-pool", "--host-tools"];
    await runSubscriptionDesktop(host);
    const path = join(data, "subscription-desktop.json"), marker = JSON.parse(readFileSync(path, "utf8"));
    delete marker.approvalPolicy; writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
    vi.mocked(prepareSubscription).mockClear();
    await expect(runSubscriptionDesktop([...host, "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
    await runSubscriptionDesktop([...host, "--approval-policy", "ask", "--check"]);
    expect(prepareSubscription).toHaveBeenCalledTimes(8);
    vi.mocked(prepareSubscription).mockClear();
    await expect(runSubscriptionDesktop([...host, "--approval-policy", "bypass", "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });

  it("requires both pools for --host-tools and rejects duplicate opt-in", () => {
    expect(() => parseSubscriptionDesktop([...args, "--host-tools"])).toThrow(/requires? --controller-pool/);
    expect(() => parseSubscriptionDesktop([...pooledArgs(), "--host-tools"])).toThrow(/requires? --controller-pool/);
    expect(parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools"]).hostTools).toBe(true);
    expect(() => parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools", "--host-tools"])).toThrow(/Duplicate host-tools/);
    expect(parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools"]).spawnAgents).toBe(false);
    expect(parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools", "--spawn-agents"]).spawnAgents).toBe(true);
    expect(() => parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--spawn-agents"])).toThrow(/requires --host-tools/);
    expect(() => parseSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools", "--spawn-agents", "--spawn-agents"])).toThrow(/Duplicate spawn-agents/);
  });

  it("refuses changing an existing pooled marker into host-tools mode", async () => {
    ownedState();
    writeFileSync(join(data, "subscription-desktop.json"), JSON.stringify({ profile: "team1", project,
      workerPool: true, controllerPool: true, workerMcpPrefix: "factory-workers-pool___", workerControlFile: join(root, "worker-control.json") }), { mode: 0o600 });
    await expect(runSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--host-tools", "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });

  it.each(["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"])("accepts the fixed %s connection", profile => {
    const selected = args.map(value => value === "team1" ? profile : value === "factory-workers-team1___" ? `factory-workers-${profile}___` : value);
    expect(parseSubscriptionDesktop(selected).profile).toBe(profile);
  });
  it.each(["team0", "team9", "pool"])("rejects unsupported %s before authentication", async profile => {
    await expect(runSubscriptionDesktop(args.map(value => value === "team1" ? profile : value))).rejects.toThrow(/assigned Team profile/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });
  it("requires an explicit pool flag and exact aggregate namespace before authentication", async () => {
    expect(parseSubscriptionDesktop(pooledArgs())).toMatchObject({ workerPool: true, profile: "team1", workerMcpPrefix: "factory-workers-pool___" });
    expect(parseSubscriptionDesktop(args).workerPool).toBe(false);
    for (const invalid of [pooledArgs().filter(value => value !== "--worker-pool"), [...args, "--worker-pool"], [...pooledArgs(), "--worker-pool"]]) {
      await expect(runSubscriptionDesktop(invalid)).rejects.toThrow();
    }
    expect(prepareSubscription).not.toHaveBeenCalled();
  });
  it("requires the worker pool before accepting controller pooling", async () => {
    await expect(runSubscriptionDesktop([...args, "--controller-pool"])).rejects.toThrow(/requires --worker-pool/);
    await expect(runSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--controller-pool"])).rejects.toThrow(/Duplicate controller/);
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
  it("launches a separate pooled controller and records its exact worker connection", async () => {
    await runSubscriptionDesktop(pooledArgs());
    const config = vi.mocked(createBridgeApp).mock.calls[0]![0];
    expect(config).toMatchObject({ controllerReadOnly: true, workerPool: true, workerMcpPrefix: "factory-workers-pool___", nativeWorkflows: false });
    expect(config.subscriptionProfile).toBe("team1");
    const marker = JSON.parse(readFileSync(join(data, "subscription-desktop.json"), "utf8"));
    expect(marker).toMatchObject({ workerPool: true, workerMcpPrefix: "factory-workers-pool___", workerControlFile: join(root, "worker-control.json") });
    await runSubscriptionDesktop([...pooledArgs(), "--check"]);
    expect(vi.mocked(prepareSubscription)).toHaveBeenCalledTimes(2);
  });
  it("preflights all eight native controller accounts without model execution or check-mode writes", async () => {
    const before = { ...process.env };
    await runSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--check"]);
    expect(vi.mocked(prepareSubscription).mock.calls.map(call => call[0])).toEqual(["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"]);
    const report = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(report).toMatchObject({ workerPool: true, controllerPool: true, modelRequestsMade: false, controllerProfiles: ["team1", "team2", "team3", "team4", "team5", "team6", "team7", "team8"] });
    expect(JSON.stringify(report)).not.toContain("@example.invalid");
    expect(process.env).toEqual(before);
    expect(existsSync(data)).toBe(false);
    expect(createBridgeApp).not.toHaveBeenCalled();
  });
  it("passes frozen private controller accounts to the bridge and binds the pool role in state", async () => {
    await runSubscriptionDesktop([...pooledArgs(), "--controller-pool"]);
    const config = vi.mocked(createBridgeApp).mock.calls[0]![0];
    expect(config.controllerPool).toBe(true);
    expect(config.subscriptionAccounts?.map(account => [account.profile, account.weight])).toEqual([
      ["team1", 5], ["team2", 5], ["team3", 5], ["team4", 5], ["team5", 1], ["team6", 1], ["team7", 1], ["team8", 1],
    ]);
    expect(JSON.stringify(config)).not.toContain("@example.invalid");
    expect(JSON.parse(readFileSync(join(data, "subscription-desktop.json"), "utf8"))).toHaveProperty("controllerPool", true);
    vi.mocked(prepareSubscription).mockClear();
    await expect(runSubscriptionDesktop([...pooledArgs(), "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });
  it("does not enable controller pooling on an existing worker-only pool state", async () => {
    await runSubscriptionDesktop(pooledArgs());
    vi.mocked(prepareSubscription).mockClear();
    await expect(runSubscriptionDesktop([...pooledArgs(), "--controller-pool", "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
  });
  it("rejects changing fixed state into pooled state and rejects pooled connection drift before authentication", async () => {
    ownedState();
    await expect(runSubscriptionDesktop([...pooledArgs(), "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
    const markerPath = join(data, "subscription-desktop.json");
    writeFileSync(markerPath, JSON.stringify({ profile: "team1", project, workerPool: true,
      workerMcpPrefix: "factory-workers-pool___", workerControlFile: join(root, "worker-control.json") }));
    await expect(runSubscriptionDesktop([...args, "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    await expect(runSubscriptionDesktop([...pooledArgs().map(value => value === join(root, "worker-control.json") ? join(root, "other-control.json") : value), "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    const incomplete = { profile: "team1", project, workerPool: true };
    writeFileSync(markerPath, JSON.stringify(incomplete));
    await expect(runSubscriptionDesktop([...pooledArgs(), "--check"])).rejects.toThrow(/another worker connection or pool policy/);
    expect(prepareSubscription).not.toHaveBeenCalled();
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
    await expect(runSubscriptionDesktop(args.map(value => value === "team1" ? "team2" : value === "factory-workers-team1___" ? "factory-workers-team2___" : value))).rejects.toThrow(/another profile/);
    expect(existsSync(join(data, "client-token"))).toBe(true);
  });
});
