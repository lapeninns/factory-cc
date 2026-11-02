import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installFactoryHooks, persistFactoryBinding } from "../../src/control/factory-hooks.js";
import { buildChildEnv } from "../../src/upstream/auth-env.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "named-factory-binding-")); roots.push(root);
  return { root, hooksPath: join(root, "hooks.json"), envFile: join(root, "session-env.sh") };
}

describe("per-seat Factory lifecycle bindings", () => {
  it.each(["BRIDGE_FACTORY_BINDING_TEAM8", "BRIDGE_FACTORY_BINDING_POOL"])("keeps legacy and %s generations independent through real hook processes", async bindingEnv => {
    const f = fixture(), requests: Array<{ key: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), key = request.headers.authorization === "Bearer fixture-one" ? "one" : "eight";
      requests.push({ key, body });
      const token = (key === "one" ? "a" : "b").repeat(64);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bindingToken: token, additionalContext: `[factory-cc-session:${token}]` }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture listener");
    const url = `http://127.0.0.1:${address.port}`;
    const one = join(f.root, "one.json"), eight = join(f.root, "eight.json");
    installFactoryHooks({ hooksPath: f.hooksPath, configPath: one, url, hookToken: "fixture-one", desktopLifecycle: true });
    installFactoryHooks({ hooksPath: f.hooksPath, configPath: eight, url, hookToken: "fixture-eight", desktopLifecycle: true, bindingEnv });
    const hookConfig = JSON.parse(readFileSync(f.hooksPath, "utf8"));
    expect(hookConfig.SessionStart).toHaveLength(2);
    expect(JSON.parse(readFileSync(one, "utf8"))).not.toHaveProperty("bindingEnv");
    expect(JSON.parse(readFileSync(eight, "utf8"))).toHaveProperty("bindingEnv", bindingEnv);

    const invoke = async (configPath: string, event: string, bindings: Record<string, string> = {}) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("BRIDGE_FACTORY_BINDING") || key === "BRIDGE_FACTORY_LAUNCH_ID") delete env[key];
      Object.assign(env, bindings);
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/factory-hook.ts"), "--factory-cc-hook-config", configPath, "--factory-cc-desktop-lifecycle"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.resume();
      const done = new Promise<{ code: number | null; stdout: string }>((resolveResult, reject) => {
        child.once("error", reject); child.once("close", code => resolveResult({ code, stdout }));
      });
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "same-factory-session", cwd: f.root, CLAUDE_ENV_FILE: f.envFile }));
      return done;
    };
    try {
      expect((await invoke(one, "SessionStart")).code).toBe(0);
      expect((await invoke(eight, "SessionStart")).code).toBe(0);
      const persisted = readFileSync(f.envFile, "utf8");
      expect(persisted).toContain(`export BRIDGE_FACTORY_BINDING='${"a".repeat(64)}'`);
      expect(persisted).toContain(`export ${bindingEnv}='${"b".repeat(64)}'`);
      const bindings = { BRIDGE_FACTORY_BINDING: "a".repeat(64), [bindingEnv]: "b".repeat(64) };
      expect((await invoke(one, "UserPromptSubmit", bindings)).code).toBe(0);
      expect((await invoke(eight, "UserPromptSubmit", bindings)).code).toBe(0);
      expect(requests.slice(-2)).toMatchObject([
        { key: "one", body: { bindingToken: "a".repeat(64) } },
        { key: "eight", body: { bindingToken: "b".repeat(64) } },
      ]);
      const count = requests.length;
      expect((await invoke(eight, "UserPromptSubmit", { BRIDGE_FACTORY_BINDING: "a".repeat(64) })).code).toBe(1);
      expect(requests).toHaveLength(count);
    } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    }
  });

  it.each(["HOME", "BRIDGE_FACTORY_BINDING_TEAM0", "BRIDGE_FACTORY_BINDING_TEAM9", "BRIDGE_FACTORY_BINDING_TEAM01", "BRIDGE_FACTORY_BINDING_TEAM8\n", "BRIDGE_FACTORY_BINDING_POOL_OTHER", "BRIDGE_FACTORY_BINDING;echo x"])("rejects unsafe binding names before writes: %s", bindingEnv => {
    const f = fixture(), configPath = join(f.root, "private.json");
    expect(() => installFactoryHooks({ hooksPath: f.hooksPath, configPath, url: "http://127.0.0.1:1", hookToken: "fixture", bindingEnv })).toThrow("binding environment name");
    expect(existsSync(configPath)).toBe(false); expect(existsSync(f.hooksPath)).toBe(false);
    expect(() => persistFactoryBinding({ hook_event_name: "SessionStart", CLAUDE_ENV_FILE: f.envFile }, "a".repeat(64), bindingEnv)).toThrow("binding environment name");
    expect(existsSync(f.envFile)).toBe(false);
  });

  it("strips every named generation from inherited SDK environments and denies passthrough", () => {
    const source = { PATH: "/usr/bin:/bin", HOME: "/tmp", BRIDGE_FACTORY_BINDING_TEAM2: "private-generation-two", BRIDGE_FACTORY_BINDING_TEAM8: "private-generation-eight", BRIDGE_FACTORY_BINDING_POOL: "private-generation-pool" };
    expect(buildChildEnv("inherit", source)).not.toHaveProperty("BRIDGE_FACTORY_BINDING_TEAM2");
    expect(buildChildEnv("inherit", source)).not.toHaveProperty("BRIDGE_FACTORY_BINDING_TEAM8");
    expect(buildChildEnv("subscription", source)).not.toHaveProperty("BRIDGE_FACTORY_BINDING_TEAM8");
    expect(buildChildEnv("inherit", source)).not.toHaveProperty("BRIDGE_FACTORY_BINDING_POOL");
    expect(buildChildEnv("subscription", source)).not.toHaveProperty("BRIDGE_FACTORY_BINDING_POOL");
    expect(() => buildChildEnv("subscription", { ...source, BRIDGE_ENV_PASSTHROUGH: "BRIDGE_FACTORY_BINDING_TEAM8" })).toThrow("BRIDGE_ENV_PASSTHROUGH");
  });
});
