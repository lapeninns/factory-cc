import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareSubscription, sanitizedSubscriptionEnvironment, verifyNativeSubscription, type SubscriptionIdentity } from "../../src/workers/subscription-auth.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subscription-auth-")));
  roots.push(root);
  const profiles: Record<string, { email: string; configDir: string }> = {};
  for (let index = 1; index <= 4; index++) {
    const dir = join(root, `team${index}`); mkdirSync(dir, { mode: 0o700 });
    profiles[`team${index}`] = { email: `team${index}@example.invalid`, configDir: dir };
  }
  const mappingPath = join(root, "profiles.json");
  writeFileSync(mappingPath, JSON.stringify({ version: 1, profiles }), { mode: 0o600 });
  const executable = join(root, "claude");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team", email: profiles.team1!.email };
  const runCli = vi.fn(async (_exe: string, args: string[]) => ({ stdout: args[0] === "--version" ? "2.1.316 (Claude Code)\n" : JSON.stringify(status) }));
  return { root, mappingPath, executable, profiles, status, runCli };
}

describe("fixed-seat subscription worker authentication", () => {
  it("selects exactly the configured profile and exposes only sanitized environment", async () => {
    const f = fixture();
    const prepared = await prepareSubscription("team1", { ...f, sourceEnv: {
      PATH: "/usr/bin:/bin", HOME: "/other-user", LANG: "en_GB.UTF-8", LC_ALL: "C", TERM: "xterm",
      ANTHROPIC_API_KEY: "secret-api", ANTHROPIC_AUTH_TOKEN: "secret-token", OPENROUTER_API_KEY: "secret-router",
      BRIDGE_OPENROUTER_API_KEY: "secret-router", CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth", CLAUDE_CONFIG_DIR: "/other-profile",
      CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: "secret-cloud", NODE_OPTIONS: "--require injected.js", HTTPS_PROXY: "http://wrong-provider",
      CLAUDE_CODE_EFFORT_LEVEL: "high", DYLD_INSERT_LIBRARIES: "injected.dylib",
    } });
    expect(prepared.env).toEqual({ PATH: "/usr/bin:/bin", HOME: userInfo().homedir, LANG: "en_GB.UTF-8", LC_ALL: "C", TERM: "xterm", CLAUDE_CONFIG_DIR: f.profiles.team1!.configDir, CLAUDE_CODE_EFFORT_LEVEL: "medium" });
    expect(prepared.expectedIdentity.profile).toBe("team1");
    expect(prepared.runtime).toMatchObject({ executable: f.executable, cliVersion: "2.1.316", sdkVersion: "0.3.300" });
    expect(prepared.runtime.sha256).toBe(createHash("sha256").update(readFileSync(f.executable)).digest("hex"));
    expect(f.runCli.mock.calls.map(([, args]) => args)).toEqual([["--version"], ["auth", "status", "--json"]]);
  });

  it.each([1, 2, 3, 4])("validates the assigned team%d identity without rotation", async (index) => {
    const f = fixture();
    f.status.email = f.profiles[`team${index}`]!.email;
    const prepared = await prepareSubscription(`team${index}`, f);
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(f.profiles[`team${index}`]!.configDir);
    expect(f.runCli).toHaveBeenCalledTimes(2);
  });

  it("fails before invoking any CLI for unknown profiles or unsafe mappings", async () => {
    const f = fixture();
    await expect(prepareSubscription("team5", f)).rejects.toThrow("assigned Team seat");
    expect(f.runCli).not.toHaveBeenCalled();
    chmodSync(f.mappingPath, 0o644);
    await expect(prepareSubscription("team1", f)).rejects.toThrow();
    expect(f.runCli).not.toHaveBeenCalled();
    chmodSync(f.mappingPath, 0o600);
    const link = join(f.root, "mapping-link"); symlinkSync(f.mappingPath, link);
    await expect(prepareSubscription("team1", { ...f, mappingPath: link })).rejects.toThrow();
    expect(f.runCli).not.toHaveBeenCalled();
  });

  it("refuses redirected and nonprivate profile directories", async () => {
    const f = fixture(), dir = f.profiles.team1!.configDir;
    chmodSync(dir, 0o755);
    await expect(prepareSubscription("team1", f)).rejects.toThrow();
    chmodSync(dir, 0o700);
    const link = join(f.root, "linked-profile"); symlinkSync(dir, link);
    writeFileSync(f.mappingPath, JSON.stringify({ profiles: { team1: { ...f.profiles.team1, configDir: link } } }));
    await expect(prepareSubscription("team1", f)).rejects.toThrow();
    expect(f.runCli).not.toHaveBeenCalled();
  });

  it.each([
    { loggedIn: false }, { authMethod: "api_key" }, { apiProvider: "bedrock" },
    { subscriptionType: "pro" }, { apiKeySource: "ANTHROPIC_API_KEY" }, { email: "other-seat@example.invalid" },
  ])("rejects mismatched auth without leaking response details: %j", async (change) => {
    const f = fixture(); Object.assign(f.status, change);
    await expect(prepareSubscription("team1", f)).rejects.toThrow("Subscription authentication failed");
    try { await prepareSubscription("team1", f); } catch (error) { expect(String(error)).not.toContain("example.invalid"); expect(String(error)).not.toContain("ANTHROPIC_API_KEY"); }
  });

  it("rejects changed CLI versions, bad output and unexpected binary pins", async () => {
    const f = fixture();
    f.runCli.mockResolvedValueOnce({ stdout: "2.1.317 (Claude Code)" });
    await expect(prepareSubscription("team1", f)).rejects.toThrow();
    expect(f.runCli).toHaveBeenCalledTimes(1);
    await expect(prepareSubscription("team1", { ...f, expectedSha256: "0".repeat(64) })).rejects.toThrow();
    const bad = vi.fn(async (_exe: string, args: string[]) => ({ stdout: args[0] === "--version" ? "2.1.316" : "malformed-private-response" }));
    await expect(prepareSubscription("team1", { ...f, runCli: bad })).rejects.not.toThrow("malformed-private-response");
  });

  it("uses the real process boundary for a fake executable without shell interpolation", async () => {
    const f = fixture();
    writeFileSync(f.executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '2.1.316 (Claude Code)'; else printf '%s\\n' '${JSON.stringify(f.status)}'; fi\n`, { mode: 0o700 });
    const prepared = await prepareSubscription("team1", { mappingPath: f.mappingPath, executable: f.executable });
    expect(prepared.expectedIdentity.profile).toBe("team1");
  });

  it("verifies SDK Team spelling, first-party identity and absence of API billing", () => {
    const identity: SubscriptionIdentity = { profile: "team1", email: "team1@example.invalid", configDir: "/profile" };
    for (const subscriptionType of ["team", "Claude Team"]) verifyNativeSubscription({ subscriptionType, apiProvider: "firstParty", apiKeySource: "none", email: "TEAM1@example.invalid" }, identity);
    for (const info of [{ subscriptionType: "team", email: identity.email }, { subscriptionType: "Claude Team", apiProvider: "firstParty", email: identity.email, apiKeySource: "project" }, { subscriptionType: "team", apiProvider: "firstParty", email: "team2@example.invalid" }]) {
      expect(() => verifyNativeSubscription(info, identity)).toThrow("Subscription authentication failed");
    }
  });

  it("drops unrecognized variables instead of treating inherited credentials as fallback", () => {
    const env = sanitizedSubscriptionEnvironment({ ANTHROPIC_BASE_URL: "https://wrong", OPENAI_API_KEY: "secret", RANDOM_TOKEN: "secret", USER: "fixture", LC_MONETARY: "C" }, "/fixed");
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CONFIG_DIR", "HOME", "LC_MONETARY", "USER"].sort());
  });
});
