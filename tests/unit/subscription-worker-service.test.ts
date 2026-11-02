import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const mocked = vi.hoisted(() => ({ query: vi.fn(), prepareSubscription: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocked.query }));
vi.mock("../../src/workers/subscription-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/workers/subscription-auth.js")>(),
  prepareSubscription: mocked.prepareSubscription,
}));

import { APIWorkerService, type APIWorkerServiceOptions } from "../../src/workers/service.js";

const support = () => ({ executable: "/fixture/unmodified-claude", sdkVersion: "0.3.300", cliVersion: "2.1.300", sha256: "fixture" });
const account = { email: "team1@example.invalid", apiProvider: "firstParty", subscriptionType: "Claude Team", apiKeySource: "none" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Subscription fixture timed out.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("fixed-seat subscription workers", () => {
  let folder: string, repo: string, profile: string;
  const services: APIWorkerService[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    folder = realpathSync(mkdtempSync(join(tmpdir(), "subscription-worker-")));
    repo = join(folder, "source"); profile = join(folder, "team1");
    mkdirSync(repo); mkdirSync(profile, { mode: 0o700 });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "fixture.txt"), "committed\n");
    execFileSync("git", ["-C", repo, "add", "fixture.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    mocked.prepareSubscription.mockResolvedValue({
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: folder, CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EFFORT_LEVEL: "medium" },
      expectedIdentity: { profile: "team1", email: account.email, configDir: profile },
      runtime: support(),
    });
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.close()));
    rmSync(folder, { recursive: true, force: true });
  });
  function service(overrides: Partial<APIWorkerServiceOptions> = {}) {
    const value = new APIWorkerService({
      stateRoot: join(folder, "state"), workspaceRoot: join(folder, "workspaces"), allowedRepositories: [repo],
      provider: { kind: "subscription", profile: "team1" }, maxMs: 10_000, maxTurns: 3,
      sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "must-not-reach-sdk", BRIDGE_OPENROUTER_API_KEY: "must-not-reach-sdk" },
      verifyRuntime: support, ...overrides,
    });
    services.push(value); return value;
  }
  function nativeFixture(identity: Promise<unknown> = Promise.resolve(account), fail = false) {
    const releasedPrompts: unknown[] = [];
    const closed = vi.fn();
    let captured: { prompt: AsyncIterable<unknown>; options: Options } | undefined;
    mocked.query.mockImplementation((input: { prompt: AsyncIterable<unknown>; options: Options }) => {
      captured = input;
      return {
        accountInfo: () => identity,
        close: closed,
        async *[Symbol.asyncIterator]() {
          for await (const prompt of input.prompt) {
            releasedPrompts.push(prompt);
            if (fail) throw new Error("Fixture subscription usage limit reached.");
            yield { type: "assistant", session_id: "native-root", message: { id: "fixture-message", model: "claude-opus-5-5", content: [], usage: { input_tokens: 9, output_tokens: 3 } } };
            yield { type: "result", session_id: "native-root", subtype: "success", is_error: false, result: "Subscription fixture complete." };
          }
        },
      };
    });
    return { releasedPrompts, closed, captured: () => captured };
  }
  function start(runtime: APIWorkerService) {
    return runtime.start({ repository: repo, task: "Private subscription-only fixture task.", workflow: "investigate" });
  }

  it("preserves the assigned login directory and sends no API key or API budget to the SDK", async () => {
    const native = nativeFixture(), runtime = service();
    const worker = await start(runtime);
    await until(() => runtime.status(worker.id).state === "completed");
    const options = native.captured()!.options;
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(profile);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.BRIDGE_OPENROUTER_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(options, "maxBudgetUsd")).toBe(false);
    expect(options).toMatchObject({ model: "claude-opus-5-5", effort: "medium", maxTurns: 3, settingSources: [] });
    expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
    expect(runtime.status(worker.id)).toMatchObject({ authentication: "subscription", subscriptionProfile: "team1" });
    expect(mocked.prepareSubscription.mock.calls.every(([selected]) => selected === "team1")).toBe(true);
    const saved = readFileSync(join(folder, "state", worker.id + ".json"), "utf8");
    expect(saved).not.toContain(account.email);
    expect(saved).not.toContain("must-not-reach-sdk");
  });

  it("holds the prompt until the native account matches the fixed Team seat", async () => {
    const gate = deferred<unknown>(), native = nativeFixture(gate.promise), runtime = service();
    const worker = await start(runtime);
    await until(() => mocked.query.mock.calls.length === 1);
    expect(native.releasedPrompts).toEqual([]);
    gate.resolve(account);
    await until(() => runtime.status(worker.id).state === "completed");
    expect(native.releasedPrompts).toHaveLength(1);
    expect(native.closed).toHaveBeenCalledOnce();
  });

  it.each([
    { ...account, email: "other@example.invalid" },
    { ...account, apiProvider: "gateway" },
    { ...account, subscriptionType: "max" },
    { ...account, apiKeySource: "ANTHROPIC_API_KEY" },
    {},
  ])("refuses an unexpected native account before releasing a prompt: %j", async identity => {
    const native = nativeFixture(Promise.resolve(identity)), runtime = service();
    const worker = await start(runtime);
    await until(() => runtime.status(worker.id).state === "failed");
    expect(native.releasedPrompts).toEqual([]);
    expect(native.closed).toHaveBeenCalledOnce();
    expect(mocked.query).toHaveBeenCalledOnce();
  });

  it("does not release a delayed prompt after the job was cancelled", async () => {
    const gate = deferred<unknown>(), native = nativeFixture(gate.promise), runtime = service();
    const worker = await start(runtime);
    await until(() => mocked.query.mock.calls.length === 1);
    await runtime.cancel(worker.id);
    gate.resolve(account);
    await until(() => native.closed.mock.calls.length === 1);
    expect(runtime.status(worker.id).state).toBe("cancelled");
    expect(native.releasedPrompts).toEqual([]);
  });

  it("does not fall back to another seat or an API route after a subscription failure", async () => {
    const native = nativeFixture(Promise.resolve(account), true), runtime = service();
    const worker = await start(runtime);
    await until(() => runtime.status(worker.id).state === "failed");
    expect(mocked.query).toHaveBeenCalledOnce();
    expect(mocked.prepareSubscription.mock.calls.every(([selected]) => selected === "team1")).toBe(true);
    expect(native.captured()!.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runtime.list()).toHaveLength(1);
  });

  it("rejects API spend controls in subscription mode and failed preflight before making a worktree", async () => {
    expect(() => service({ maxBudgetUsd: 0.2 })).toThrow(/API spend budget/);
    mocked.prepareSubscription.mockRejectedValue(new Error("Subscription fixture preflight denied."));
    const runtime = service();
    await expect(start(runtime)).rejects.toThrow(/preflight denied/);
    expect(readdirSync(join(folder, "workspaces"))).toEqual([]);
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it("records native usage-limit evidence without retaining provider error text", async () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const runtime = service({ run: async context => {
      context.message({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: `Private usage detail|${reset}` }] } });
      context.message({ type: "result", subtype: "error_during_execution", is_error: true });
    } });
    const worker = await start(runtime);
    await until(() => runtime.status(worker.id).state === "failed");
    const result = runtime.status(worker.id);
    expect(result.reason).toBe("native_usage_limit");
    expect(result.backoff).toMatchObject({ kind: "usage_limit" });
    expect(result.backoff!.retryAfterSeconds).toBeGreaterThan(7100);
    expect(JSON.stringify(result)).not.toContain("Private usage detail");
    expect(result.cleanupVerified).toBe(true);
  });

  it("classifies thrown upstream 429 errors but never successful prose about limits", async () => {
    const limited = service({ run: async () => { throw Object.assign(new Error("Private provider detail"), { status: 429 }); } });
    const first = await start(limited);
    await until(() => limited.status(first.id).state === "failed");
    expect(limited.status(first.id)).toMatchObject({ reason: "native_rate_limit", backoff: { kind: "rate_limit", retryAfterSeconds: 60 } });
    expect(JSON.stringify(limited.status(first.id))).not.toContain("Private provider detail");
    const good = service({ stateRoot: join(folder, "good-state"), workspaceRoot: join(folder, "good-workspaces"), run: async context => {
      context.message({ type: "system", subtype: "api_retry", error_status: 429 });
      context.message({ type: "result", subtype: "success", is_error: false, result: "Documentation mentions rate_limit_error, but this run succeeded." });
    } });
    const second = await start(good);
    await until(() => good.status(second.id).state === "completed");
    expect(good.status(second.id).backoff).toBeUndefined();
  });

  it.each(["rate_limit_event", "overloaded"])("records structured native %s capacity failures", async kind => {
    const runtime = service({ run: async context => {
      context.message(kind === "rate_limit_event"
        ? { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 500 } }
        : { type: "assistant", error: "overloaded" });
      context.message({ type: "result", subtype: "error_during_execution", is_error: true });
    } });
    const worker = await start(runtime);
    await until(() => runtime.status(worker.id).state === "failed");
    expect(runtime.status(worker.id).backoff?.kind).toBe(kind === "overloaded" ? "overloaded" : "usage_limit");
    expect(runtime.status(worker.id).backoff!.retryAfterSeconds).toBeGreaterThanOrEqual(60);
  });
});
