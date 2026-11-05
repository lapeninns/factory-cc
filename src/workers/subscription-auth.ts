import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { NativeWorkflowSupport } from "../runtime/native-workflow-support.js";
import { SUBSCRIPTION_PROFILES, type SubscriptionProfile } from "../runtime/desktop-jobs.js";

const execute = promisify(execFile);
const PROFILES = new Set<string>(SUBSCRIPTION_PROFILES);
const EXPECTED_CLI_VERSION = "2.1.316";
const EXPECTED_SDK_VERSION = "0.3.300";
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

function failure(): Error {
  return new Error(`Subscription authentication failed. Verify the pinned Claude CLI ${EXPECTED_CLI_VERSION} installation and this connection's assigned Team seat through native Claude login; no other account or API route will be selected.`);
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
  } catch { throw failure(); }
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
  try {
    const home = userInfo().homedir;
    const identity = readMapping(options.mappingPath ?? join(home, ".factory/config/native-ultracode-profiles.json"), profile);
    const env = sanitizedSubscriptionEnvironment(options.sourceEnv ?? process.env, identity.configDir);
    // The login CLI has its own verified version. The mutable launcher can
    // advance independently of the separately pinned native workflow runtime.
    const selectedExecutable = options.executable ?? join(home, ".local/share/claude/versions", EXPECTED_CLI_VERSION);
    if (!isAbsolute(selectedExecutable)) throw failure();
    // Resolve once so an explicitly supplied symlink cannot switch executables
    // between the version and identity checks.
    const executable = realpathSync(selectedExecutable), info = lstatSync(executable);
    if (!info.isFile() || !owned(info) || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw failure();
    const sdkPath = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8"));
    if (sdk.version !== EXPECTED_SDK_VERSION) throw failure();
    const before = await hashFile(executable);
    if (options.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(options.expectedSha256) || before !== options.expectedSha256)) throw failure();
    const run = options.runCli ?? nativeCli;
    const version = (await run(executable, ["--version"], env)).stdout.trim();
    if (!new RegExp(`^${EXPECTED_CLI_VERSION.replaceAll(".", "\\.")}(?: \\([^\\r\\n]*\\))?$`).test(version)) throw failure();
    const status: unknown = JSON.parse((await run(executable, ["auth", "status", "--json"], env)).stdout);
    if (!object(status) || status.loggedIn !== true || status.authMethod !== "claude.ai") throw failure();
    verifyNativeSubscription(status, identity);
    if (before !== await hashFile(executable)) throw failure();
    return { env, expectedIdentity: identity,
      runtime: { executable, sdkVersion: sdk.version, cliVersion: EXPECTED_CLI_VERSION, sha256: before } };
  } catch { throw failure(); }
}
