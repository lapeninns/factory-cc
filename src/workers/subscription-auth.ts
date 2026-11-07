import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { assertNativeWorkflowSupport, NATIVE_WORKFLOW_BUILD, type NativeWorkflowSupport } from "../runtime/native-workflow-support.js";
import { SUBSCRIPTION_PROFILES, type SubscriptionProfile } from "../runtime/desktop-jobs.js";
import { BridgeError } from "../types.js";

const execute = promisify(execFile);
const PROFILES = new Set<string>(SUBSCRIPTION_PROFILES);
const EXPECTED_CLI_VERSION = NATIVE_WORKFLOW_BUILD.cliVersion;
const EXPECTED_SDK_VERSION = NATIVE_WORKFLOW_BUILD.sdkVersion;
const BASE_ENVIRONMENT = new Set(["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TERM", "COLORTERM", "TZ", "LANG"]);
const NO_API_SOURCES = new Set(["", "none", "oauth"]);

export interface SubscriptionIdentity {
  profile: SubscriptionProfile;
  /** Private comparison data. Do not log or include in public worker views. */
  email: string;
  configDir: string;
}
export interface SubscriptionCliResult { stdout: string }
export interface SubscriptionOptions {
  mappingPath?: string;
  executable?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  /** Optional independently recorded executable pin, not a replacement CLI. */
  expectedSha256?: string;
  /** Test seam. Production calls execFile directly without a shell. */
  runCli?: (executable: string, args: string[], env: Record<string, string>) => Promise<SubscriptionCliResult>;
}
export interface PreparedSubscription {
  env: Record<string, string>;
  expectedIdentity: SubscriptionIdentity;
  /** Auth-preflight executable observation only; not a native-workflow compatibility attestation. */
  runtime: NativeWorkflowSupport;
}

export type SubscriptionFailureCode = "subscription_profile_invalid" | "subscription_runtime_missing" | "subscription_runtime_unverified" | "subscription_login_unavailable" | "subscription_identity_mismatch";
const FAILURE_MESSAGES: Record<SubscriptionFailureCode, string> = {
  subscription_profile_invalid: "The fixed Team profile mapping or its private directory is invalid.",
  subscription_runtime_missing: "The packaged subscription CLI is missing. Restore the complete pinned SDK release.",
  subscription_runtime_unverified: "The packaged subscription CLI or SDK failed version, ownership or digest verification.",
  subscription_login_unavailable: "The assigned Team login could not be verified through native Claude login status.",
  subscription_identity_mismatch: "Native login does not match the configured first-party Team subscription identity.",
};
/** Fixed messages only: never attach raw CLI output, paths, identities or causes. */
export class SubscriptionFailure extends Error {
  constructor(readonly code: SubscriptionFailureCode) {
    super("Subscription authentication failed. " + FAILURE_MESSAGES[code] + " Verify the assigned Team seat; no other account or API route will be selected.");
    this.name = "SubscriptionFailure";
  }
}
function failure(code: SubscriptionFailureCode = "subscription_identity_mismatch"): SubscriptionFailure {
  return new SubscriptionFailure(code);
}
export function subscriptionFailureReport(error: unknown): { code: string; message: string } {
  return error instanceof SubscriptionFailure ? { code: error.code, message: error.message }
    : { code: "worker_startup_failed", message: "Worker startup failed. Inspect private configuration, service ownership and runtime installation." };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function owned(info: Stats): boolean {
  return typeof process.getuid === "function" && info.uid === process.getuid();
}
function readMapping(path: string, profile: string): SubscriptionIdentity {
  try {
    if (!PROFILES.has(profile) || !isAbsolute(path) || realpathSync(path) !== resolve(path)) throw failure();
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) throw failure();
    const mapping: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(mapping) || !object(mapping.profiles) || !object(mapping.profiles[profile])) throw failure();
    const selected = mapping.profiles[profile];
    if (typeof selected.email !== "string" || !selected.email.trim() || /[\r\n]/.test(selected.email)
        || typeof selected.configDir !== "string" || !isAbsolute(selected.configDir)) throw failure();
    const configDir = realpathSync(selected.configDir);
    if (configDir !== resolve(selected.configDir)) throw failure();
    const folder = lstatSync(configDir);
    if (!folder.isDirectory() || !owned(folder) || (folder.mode & 0o077) !== 0) throw failure();
    return { profile: profile as SubscriptionIdentity["profile"], email: selected.email.trim(), configDir };
  } catch { throw failure("subscription_profile_invalid"); }
}

/** Allowlist keeps API, router, cloud, OAuth-token and process-injection variables out. */
export function sanitizedSubscriptionEnvironment(source: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (BASE_ENVIRONMENT.has(name) || /^LC_[A-Z_]+$/.test(name))) env[name] = value;
  }
  env.HOME = userInfo().homedir;
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_EFFORT_LEVEL = "medium";
  return env;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function nativeCli(executable: string, args: string[], env: Record<string, string>): Promise<SubscriptionCliResult> {
  const result = await execute(executable, args, { env, encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true });
  return { stdout: result.stdout };
}

/** Re-check the actual worker's accountInfo before releasing its first prompt. */
export function verifyNativeSubscription(info: unknown, identity: Pick<SubscriptionIdentity, "email">): void {
  if (!object(info)) throw failure();
  const plan = typeof info.subscriptionType === "string" ? info.subscriptionType.trim().toLowerCase() : "";
  const email = typeof info.email === "string" ? info.email.trim().toLowerCase() : "";
  const source = info.apiKeySource == null ? "" : typeof info.apiKeySource === "string" ? info.apiKeySource.trim().toLowerCase() : "invalid";
  if (!["team", "claude team"].includes(plan) || email !== identity.email.toLowerCase()
      || info.apiProvider !== "firstParty" || !NO_API_SOURCES.has(source)
      || (info.authMethod !== undefined && info.authMethod !== "claude.ai")) throw failure();
}

/** Select one operator-configured profile. This function never pools or rotates accounts. */
export async function prepareSubscription(profile: string, options: SubscriptionOptions = {}): Promise<PreparedSubscription> {
  let stage: SubscriptionFailureCode = "subscription_profile_invalid";
  try {
    const home = userInfo().homedir;
    const identity = readMapping(options.mappingPath ?? join(home, ".factory/config/native-ultracode-profiles.json"), profile);
    const env = sanitizedSubscriptionEnvironment(options.sourceEnv ?? process.env, identity.configDir);
    // Authentication and inference belong to the same immutable, verified release.
    // Native auto-updaters may prune ~/.local/share/claude/versions at any time.
    stage = "subscription_runtime_unverified";
    const bundled = options.executable === undefined ? assertNativeWorkflowSupport() : undefined;
    const selectedExecutable = options.executable ?? bundled!.executable;
    if (!isAbsolute(selectedExecutable)) throw failure(stage);
    stage = "subscription_runtime_missing";
    const executable = realpathSync(selectedExecutable), info = lstatSync(executable);
    stage = "subscription_runtime_unverified";
    if (!info.isFile() || !owned(info) || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw failure(stage);
    const sdkPath = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8"));
    if (sdk.version !== EXPECTED_SDK_VERSION) throw failure(stage);
    const before = await hashFile(executable);
    const expectedSha256 = options.expectedSha256 ?? bundled?.sha256;
    if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha256) || before !== expectedSha256)) throw failure(stage);
    const run = options.runCli ?? nativeCli;
    const version = (await run(executable, ["--version"], env)).stdout.trim();
    if (version !== EXPECTED_CLI_VERSION && version !== EXPECTED_CLI_VERSION + " (Claude Code)") throw failure(stage);
    stage = "subscription_login_unavailable";
    const status: unknown = JSON.parse((await run(executable, ["auth", "status", "--json"], env)).stdout);
    if (!object(status) || status.loggedIn !== true || status.authMethod !== "claude.ai") throw failure(stage);
    verifyNativeSubscription(status, identity);
    stage = "subscription_runtime_unverified";
    if (before !== await hashFile(executable)) throw failure(stage);
    return { env, expectedIdentity: identity,
      runtime: { executable, sdkVersion: sdk.version, cliVersion: EXPECTED_CLI_VERSION, sha256: before } };
  } catch (error) {
    if (error instanceof SubscriptionFailure) throw error;
    if (error instanceof BridgeError && error.code === "workflow_runtime_unverified" && error.extra.runtime_missing === true) throw failure("subscription_runtime_missing");
    throw failure(stage);
  }
}
