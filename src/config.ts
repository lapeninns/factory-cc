import { assertClaudeCredential, readClaudeConfig, claudeConfigModels, loadClaudeProfiles, parseClaudeProfileList, type ClaudeConfig, type ClaudeProfile } from "./upstream/claude-config.js";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { BridgeMode } from "./types.js";
import { parseAuthMode, preflightAuth, type AuthMode } from "./upstream/auth-env.js";
import { selectionFromConfig } from "./upstream/providers.js";
import { canonicalWorkspacePath } from "./workspace.js";
import { parseClaudePool, POOL_PROFILE, type PoolMember } from "./upstream/claude-pool.js";
import { claudeProfileModels, modelsFromIds, parseModelIds, validateModels, type BridgeModel } from "./models.js";
import { SUBSCRIPTION_PROFILES, type SubscriptionProfile } from "./runtime/desktop-jobs.js";
import { sanitizedSubscriptionEnvironment } from "./workers/subscription-auth.js";

/** Private, preflight-verified native account routing; never model or request input. */
export interface SubscriptionAccount {
  readonly profile: SubscriptionProfile;
  readonly expectedEmail: string;
  readonly env: Readonly<Record<string, string>>;
  readonly weight: number;
}

export interface BridgeConfig {
  desktopProfile?: boolean;
  /** Explicit lifecycle/job integration; does not alter legacy desktop requests. */
  desktopJobs?: boolean;
  desktopLifecycle?: boolean;
  /** Opt-in compatibility for legacy unbound claude-config requests only. */
  ignoreUnknownSessionMarkers?: boolean;
  desktopRuntimePath?: string;
  desktopStateRoot?: string;
  desktopWorkflow?: "implement" | "investigate" | "release-prepare";
  /** Private worker-control channel used only by the native Factory AskUser adapter. */
  workerControlFile?: string;
  workerMcpPrefix?: string;
  /** Private fixed-seat comparison, deliberately non-enumerable at runtime. */
  subscriptionExpectedEmail?: string;
  /** Operator-selected seat; never read from request metadata or environment. */
  subscriptionProfile?: SubscriptionProfile;
  /** Trusted operator-only mode: primary checkout reads, isolated worker writes. */
  readonly controllerReadOnly?: boolean;
  /** Explicit operator opt-in to the supervised aggregate worker connection. */
  readonly workerPool?: boolean;
  /** Explicit operator opt-in to native controller account selection. */
  readonly controllerPool?: boolean;
  /** Explicit operator opt-in to exactly approved Factory filesystem actions. */
  readonly controllerHostTools?: boolean;
  /** Operator opt-in to visible Factory Workstream agents through SpawnAgent. */
  readonly controllerSpawnAgents?: boolean;
  /** Model transport only: all tools and agent lifecycle execute in Factory. */
  readonly factoryNative?: boolean;
  /** Operator-only policy for the bridge's extra host-action confirmation. */
  readonly controllerApprovalPolicy?: "ask" | "bypass";
  /** Private native account descriptors, deeply frozen and non-enumerable. */
  readonly subscriptionAccounts?: readonly SubscriptionAccount[];
  /** Explicit API-only native workflow mode; disabled unless opted in. */
  nativeWorkflows?: boolean;
  workflowProvider?: "anthropic" | "openrouter";
  workflowMaxBudgetUsd?: number;
  workflowMaxMs?: number;
  droidSessionsDir?: string;
  host: string;
  port: number;
  mode: BridgeMode;
  clientToken: string;
  adminToken: string;
  hookToken: string;
  /** Operator opted in to a non-loopback bind. Never true for subscription. */
  allowRemote: boolean;
  /** Names or IPs remote clients use to reach the bridge. Honored only with allowRemote. */
  allowedHosts: string[];
  dataDir: string;
  logDir: string;
  sandboxDir: string;
  maxBodyBytes: number;
  maxSessions: number;
  maxIdleSessions?: number;
  sdkStartTimeoutMs?: number;
  sessionMaxRecords?: number;
  sessionRetentionMs?: number;
  maxTurns: number;
  toolWaitMs: number;
  /** How long a session parked on a Droid tool must be idle before it may be reclaimed once session slots run out. */
  toolWaitTimeoutMs: number;
  /** Droid ends a Mission worker once its EndFeatureRun succeeds and never returns that result. After this long without one, release the worker's native process. */
  workerEndGraceMs: number;
  /** Idle limit for one native turn. Any SDK message, delta or tool event restarts it; approvals pause it. */
  requestTimeoutMs: number;
  /** How long a human has to answer an approval on the Control page. */
  approvalTimeoutMs: number;
  /** Absolute cap for one native turn, whatever progress it reports. */
  turnMaxMs: number;
  claudeExecutable?: string;
  sdkCwd: string;
  persistSessions: boolean;
  /** Write full request bodies to the request log. Off by default: only a hash, size and tool names. */
  logBodies: boolean;
  authMode: AuthMode;
  claudeConfig?: ClaudeConfig;
  /** Extra accounts from BRIDGE_CLAUDE_PROFILES; each adds `<id>/<model>` menu entries. claude-config only. */
  claudeProfiles?: ClaudeProfile[];
  /** Accounts and weights from BRIDGE_CLAUDE_POOL: adds `pool/<model>` entries and moves limited sessions to another account. */
  claudePool?: PoolMember[];
  permissionMode: "bypass" | "ask";
  upstreamBaseUrl?: string;
  upstreamModel?: string;
  upstreamTokenEnv?: string;
  models?: BridgeModel[];
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** `127.0.0.1`, any other `127.x.x.x`, `localhost`, or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  const parts = bare.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** `0.0.0.0` or `::`: listens everywhere, so the address says nothing about what clients will call it. */
export function isWildcardHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "0.0.0.0" || bare === "::" || bare === "0:0:0:0:0:0:0:0";
}

/** Bare host names and IPs only, lowercased; IPv6 comes back bracketed as it appears in a Host header. */
export function parseAllowedHosts(raw: string | string[] | undefined): string[] {
  const entries = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  const names = new Set<string>();
  for (const entry of entries) {
    const bare = entry.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!bare) continue;
    const ipv6 = isIPv6(bare);
    if (!ipv6 && !/^[a-z0-9._-]+$/.test(bare)) {
      throw new Error(`BRIDGE_ALLOWED_HOSTS entries must be bare host names or IP addresses without a port or scheme; got "${entry.trim()}".`);
    }
    names.add(ipv6 ? `[${bare}]` : bare);
  }
  return [...names];
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir mode is filtered by umask. chmod makes the directory actually 0700.
  chmodSync(path, 0o700);
}

function readCursorMenu(file: string | undefined): BridgeModel[] | undefined {
  if (!file) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`BRIDGE_CURSOR_MODELS_FILE could not be read: ${file}`); }
  if (!Array.isArray(parsed)) throw new Error("BRIDGE_CURSOR_MODELS_FILE must contain a JSON array of models.");
  return validateModels(parsed as BridgeModel[]);
}

function mergeModelCatalog(base: BridgeModel[] | undefined, cursor: BridgeModel[] | undefined): BridgeModel[] | undefined {
  if (!cursor?.length) return base;
  return validateModels([...(base ?? []).filter((model) => model.provider !== "cursor"), ...cursor]);
}

function withProfiles(base: BridgeModel[] | undefined, profiles: Array<{ id: string }>): BridgeModel[] | undefined {
  return base && profiles?.length ? validateModels([...base, ...claudeProfileModels(base, profiles)]) : base;
}

function tokenEnv(name: string): string | undefined {
  const file = env(`${name}_FILE`);
  if (file && env(name)) throw new Error(`${name} and ${name}_FILE cannot both be set.`);
  if (!file) return env(name);
  const value = readFileSync(file, "utf8").trim();
  if (!value || /\s/.test(value)) throw new Error(`${name}_FILE must contain a nonempty token without whitespace.`);
  return value;
}

/** The launcher and configuration loader share this check, including --check mode. */
export function validateSubscriptionAccountPool(value: unknown, current: { profile: SubscriptionProfile; expectedEmail: string; configDir?: string }): readonly SubscriptionAccount[] {
  const fail = (): never => { throw new Error("The controller pool requires eight distinct, clean, preflight-verified native Team account descriptors matching its initial identity."); };
  if (!Array.isArray(value) || value.length !== SUBSCRIPTION_PROFILES.length) return fail();
  const profiles = new Set<string>(), emails = new Set<string>(), directories = new Set<string>();
  const accounts: SubscriptionAccount[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || Object.keys(raw).some(key => !["profile", "expectedEmail", "env", "weight"].includes(key))) return fail();
    const account = raw as SubscriptionAccount;
    if (!SUBSCRIPTION_PROFILES.includes(account.profile) || profiles.has(account.profile)
        || typeof account.expectedEmail !== "string" || !/^[^\s@]+@[^\s@]+$/.test(account.expectedEmail)
        || emails.has(account.expectedEmail.toLowerCase()) || !Number.isSafeInteger(account.weight) || account.weight < 1 || account.weight > 9999
        || !account.env || typeof account.env !== "object" || Array.isArray(account.env)
        || Object.values(account.env).some(item => typeof item !== "string" || item.includes("\0"))) return fail();
    const configDir = account.env.CLAUDE_CONFIG_DIR;
    if (typeof configDir !== "string" || !isAbsolute(configDir) || resolve(configDir) !== configDir || directories.has(configDir)) return fail();
    const clean = sanitizedSubscriptionEnvironment(account.env, configDir);
    if (Object.keys(account.env).length !== Object.keys(clean).length
        || Object.entries(clean).some(([key, item]) => account.env[key] !== item)) return fail();
    preflightAuth("subscription", clean);
    profiles.add(account.profile); emails.add(account.expectedEmail.toLowerCase()); directories.add(configDir);
    accounts.push(Object.freeze({ profile: account.profile, expectedEmail: account.expectedEmail, weight: account.weight, env: Object.freeze({ ...clean }) }));
  }
  const selected = accounts.find(account => account.profile === current.profile);
  if (!selected || selected.expectedEmail.toLowerCase() !== current.expectedEmail.toLowerCase()
      || !current.configDir || selected.env.CLAUDE_CONFIG_DIR !== current.configDir) return fail();
  return Object.freeze(accounts);
}

export function loadConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const authMode = parseAuthMode(overrides.authMode ?? env("BRIDGE_AUTH", "byok"));
  const nativeRaw = env("BRIDGE_NATIVE_WORKFLOWS");
  if (nativeRaw !== undefined && nativeRaw !== "0" && nativeRaw !== "1") throw new Error("BRIDGE_NATIVE_WORKFLOWS must be 0 or 1.");
  const nativeWorkflows = overrides.nativeWorkflows ?? nativeRaw === "1";
  const workflowProvider = overrides.workflowProvider ?? env("BRIDGE_WORKFLOW_PROVIDER", "anthropic");
  if (nativeWorkflows && workflowProvider !== "anthropic" && workflowProvider !== "openrouter") throw new Error("BRIDGE_WORKFLOW_PROVIDER must be anthropic or openrouter.");
  const openrouter = nativeWorkflows && workflowProvider === "openrouter";
  const workflowRoute = { baseUrl: overrides.upstreamBaseUrl ?? env("BRIDGE_UPSTREAM_BASE_URL"), model: overrides.upstreamModel ?? env("BRIDGE_UPSTREAM_MODEL"), tokenEnv: overrides.upstreamTokenEnv ?? env("BRIDGE_UPSTREAM_TOKEN_ENV") };
  const workflowMaxBudgetUsd = overrides.workflowMaxBudgetUsd ?? (env("BRIDGE_WORKFLOW_MAX_BUDGET_USD") === undefined ? undefined : Number(env("BRIDGE_WORKFLOW_MAX_BUDGET_USD")));
  const workflowMaxMs = overrides.workflowMaxMs ?? (env("BRIDGE_WORKFLOW_MAX_MS") === undefined ? 30 * 60_000 : Number(env("BRIDGE_WORKFLOW_MAX_MS")));
  if (nativeWorkflows) {
    if (!openrouter && authMode !== "anthropic-api") throw new Error("Native workflows require BRIDGE_AUTH=anthropic-api; subscription fallback is forbidden.");
    if (overrides.claudePool?.length || overrides.claudeProfiles?.length || env("BRIDGE_CLAUDE_POOL") || env("BRIDGE_CLAUDE_PROFILES")) throw new Error("Native workflows cannot use Claude profiles or an account pool.");
    if (overrides.claudeExecutable || env("BRIDGE_CLAUDE_EXECUTABLE")) throw new Error("Native workflows cannot use a custom Claude executable.");
    if (!openrouter && (overrides.upstreamBaseUrl || overrides.upstreamModel || overrides.upstreamTokenEnv)) throw new Error("Native workflows cannot use upstream routing overrides.");
    if (!Number.isFinite(workflowMaxBudgetUsd) || workflowMaxBudgetUsd! <= 0) throw new Error("Native workflows require a positive finite BRIDGE_WORKFLOW_MAX_BUDGET_USD.");
    if (!Number.isSafeInteger(workflowMaxMs) || workflowMaxMs < 1_000 || workflowMaxMs > 2 * 60 * 60_000) throw new Error("BRIDGE_WORKFLOW_MAX_MS must be an integer from 1000 to 7200000.");
    if (openrouter) {
      if (authMode !== "byok" || workflowRoute.baseUrl !== "https://openrouter.ai/api" || workflowRoute.model !== "anthropic/claude-opus-5.5" || workflowRoute.tokenEnv !== "BRIDGE_OPENROUTER_API_KEY") throw new Error("OpenRouter workflows require byok with the exact approved OpenRouter endpoint, Opus model and key variable.");
      const conflicts = Object.keys(process.env).filter(key => process.env[key] && (/^ANTHROPIC_/.test(key) || /^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_|API_BASE_URL|GATEWAY_TOKEN|SUBAGENT_MODEL|WORKFLOW_SUBAGENT_MODEL)/.test(key) || key === "BRIDGE_API_KEY_HELPER" || key === "AGENT_PROXY_AUTH_TOKEN"));
      if (conflicts.length) throw new Error("OpenRouter workflows refuse conflicting authentication or model environment variables; values are not shown.");
      preflightAuth("byok", process.env, selectionFromConfig(workflowRoute));
    } else preflightAuth("anthropic-api", process.env);
  }
  const desktopProfile = overrides.desktopProfile ?? env("BRIDGE_DESKTOP") === "1";
  const desktopJobs = overrides.desktopJobs ?? env("BRIDGE_DESKTOP_JOBS") === "1";
  const desktopLifecycle = overrides.desktopLifecycle ?? env("BRIDGE_DESKTOP_LIFECYCLE") === "1";
  const ignoreMarkersRaw = env("BRIDGE_IGNORE_UNKNOWN_SESSION_MARKERS");
  if (ignoreMarkersRaw !== undefined && !["0", "1"].includes(ignoreMarkersRaw)) throw new Error("BRIDGE_IGNORE_UNKNOWN_SESSION_MARKERS must be 0 or 1.");
  if (overrides.ignoreUnknownSessionMarkers !== undefined && typeof overrides.ignoreUnknownSessionMarkers !== "boolean") throw new Error("Unknown session marker compatibility must be a boolean.");
  const ignoreUnknownSessionMarkers = overrides.ignoreUnknownSessionMarkers ?? ignoreMarkersRaw === "1";
  if (ignoreUnknownSessionMarkers && (authMode !== "claude-config" || desktopJobs || desktopLifecycle)) {
    throw new Error("Unknown session marker compatibility is restricted to legacy claude-config bridges without Desktop lifecycle or jobs.");
  }
  const desktopRuntimePath = overrides.desktopRuntimePath ?? env("BRIDGE_DESKTOP_RUNTIME_PATH");
  const desktopStateRoot = overrides.desktopStateRoot ?? env("BRIDGE_DESKTOP_STATE_ROOT");
  const desktopWorkflow = overrides.desktopWorkflow ?? env("BRIDGE_DESKTOP_WORKFLOW", "implement");
  const workerControlFile = overrides.workerControlFile ?? env("BRIDGE_WORKER_CONTROL_FILE");
  const workerMcpPrefix = overrides.workerMcpPrefix ?? env("BRIDGE_WORKER_MCP_PREFIX");
  if ((workerControlFile || workerMcpPrefix) && (!desktopProfile || !workerControlFile?.startsWith("/") || !workerMcpPrefix || !/^(?:mcp__[A-Za-z0-9_]+__|[A-Za-z0-9_-]+___)$/.test(workerMcpPrefix))) throw new Error("Worker approvals require a desktop profile, private absolute control path and exact MCP namespace.");
  if (desktopJobs && (!desktopProfile || !desktopLifecycle || !desktopRuntimePath || !desktopStateRoot || !["implement", "investigate", "release-prepare"].includes(desktopWorkflow!))) {
    throw new Error("Desktop jobs require the desktop profile, explicit lifecycle binding, runtime/state paths and a supported workflow.");
  }
  if (desktopJobs && (!desktopRuntimePath!.startsWith("/") || !desktopStateRoot!.startsWith("/"))) throw new Error("Desktop runtime and state paths must be absolute.");
  const claudeConfig = authMode === "claude-config" ? overrides.claudeConfig ?? readClaudeConfig(process.env, `${overrides.host ?? env("BRIDGE_HOST", "127.0.0.1")}:${overrides.port ?? intEnv("BRIDGE_PORT", 18787)}`, { requireSettings: desktopProfile && Boolean(process.env.CLAUDE_CONFIG_DIR) }) : undefined;
  if (claudeConfig) assertClaudeCredential(claudeConfig);
  const profileList = env("BRIDGE_CLAUDE_PROFILES");
  if (profileList && authMode !== "claude-config" && !overrides.claudeProfiles) throw new Error("BRIDGE_CLAUDE_PROFILES requires BRIDGE_AUTH=claude-config.");
  const claudeProfiles = overrides.claudeProfiles ?? (profileList
    ? loadClaudeProfiles(parseClaudeProfileList(profileList), process.env, `${overrides.host ?? env("BRIDGE_HOST", "127.0.0.1")}:${overrides.port ?? intEnv("BRIDGE_PORT", 18787)}`)
    : undefined);
  const poolList = env("BRIDGE_CLAUDE_POOL");
  if (poolList && authMode !== "claude-config" && !overrides.claudePool) throw new Error("BRIDGE_CLAUDE_POOL requires BRIDGE_AUTH=claude-config.");
  const claudePool = overrides.claudePool ?? (poolList ? parseClaudePool(poolList, (claudeProfiles ?? []).map((profile) => profile.id)) : undefined);
  const dataDir = resolve(overrides.dataDir ?? env("BRIDGE_DATA_DIR", resolve(process.cwd(), "tmp/bridge-data"))!);
  ensurePrivateDir(dataDir);
  const logDir = resolve(dataDir, "logs");
  ensurePrivateDir(logDir);
  mkdirSync(resolve(dataDir, "sessions"), { recursive: true });
  mkdirSync(resolve(dataDir, "sandbox"), { recursive: true });

  const mode = (overrides.mode ?? env("BRIDGE_MODE", "mock")) as BridgeMode;
  if (!["mock", "fake", "sdk"].includes(mode)) {
    throw new Error(`Invalid BRIDGE_MODE=${mode}. Use mock | fake | sdk.`);
  }
  const host = overrides.host ?? env("BRIDGE_HOST", "127.0.0.1")!;
  const allowRemote = overrides.allowRemote ?? env("BRIDGE_ALLOW_REMOTE") === "1";
  const allowedHosts = parseAllowedHosts(overrides.allowedHosts ?? env("BRIDGE_ALLOWED_HOSTS"));
  if (!isLoopbackHost(host)) {
    if (authMode === "subscription") {
      throw new Error("exposing a Claude subscription to other machines/people is not permitted");
    }
    if (!allowRemote) {
      throw new Error(`Refusing to listen on ${host} without BRIDGE_ALLOW_REMOTE=1.`);
    }
    // Remote clients send the LAN IP or name they dialed, never the wildcard
    // address, so without their names every request would fail the Host check.
    if (isWildcardHost(host) && allowedHosts.length === 0) {
      throw new Error(`BRIDGE_HOST=${host} listens on every interface, so the Host header remote clients send is not known. Set BRIDGE_ALLOWED_HOSTS to the comma-separated names or IPs they will use, for example 192.168.1.20,devbox.local.`);
    }
  }
  const clientToken = overrides.clientToken ?? (tokenEnv("BRIDGE_CLIENT_TOKEN") ?? randomBytes(24).toString("hex"))!;
  const adminToken = overrides.adminToken ?? (tokenEnv("BRIDGE_ADMIN_TOKEN") ?? randomBytes(24).toString("hex"))!;
  const hookToken = overrides.hookToken ?? (tokenEnv("BRIDGE_HOOK_TOKEN") ?? randomBytes(24).toString("hex"))!;
  if (adminToken === clientToken || hookToken === adminToken || hookToken === clientToken) {
    throw new Error("BRIDGE_CLIENT_TOKEN, BRIDGE_ADMIN_TOKEN and BRIDGE_HOOK_TOKEN must be different.");
  }
  const permissionRaw = overrides.permissionMode ?? env("BRIDGE_PERMISSION");
  const permissionMode = (permissionRaw === "ask" || permissionRaw === "bypass"
    ? permissionRaw
    : "ask") as "bypass" | "ask";

  if (nativeWorkflows && (mode !== "sdk" || !desktopProfile)) throw new Error("Native workflows require sdk mode and the guarded desktop profile.");
  const nativeSessionLimit = overrides.maxSessions ?? intEnv("BRIDGE_MAX_SESSIONS", 1);
  if (nativeWorkflows && (!isLoopbackHost(host) || permissionMode !== "ask" || (!desktopJobs && nativeSessionLimit !== 1) || (desktopJobs && (!Number.isSafeInteger(nativeSessionLimit) || nativeSessionLimit < 1 || nativeSessionLimit > 8)))) {
    throw new Error("Native workflows require loopback binding, ask permissions and BRIDGE_MAX_SESSIONS=1.");
  }
  const subscriptionDesktopJobs = desktopJobs && mode === "sdk" && authMode === "subscription" && !nativeWorkflows;
  if (overrides.controllerReadOnly !== undefined && typeof overrides.controllerReadOnly !== "boolean") {
    throw new Error("Controller read-only policy must be a boolean supplied by operator configuration.");
  }
  const controllerReadOnly = overrides.controllerReadOnly === true;
  if (overrides.workerPool !== undefined && typeof overrides.workerPool !== "boolean") {
    throw new Error("Worker pool policy must be a boolean supplied by operator configuration.");
  }
  const workerPool = overrides.workerPool === true;
  if (overrides.controllerPool !== undefined && typeof overrides.controllerPool !== "boolean") {
    throw new Error("Controller pool policy must be a boolean supplied by operator configuration.");
  }
  const controllerPool = overrides.controllerPool === true;
  if (overrides.controllerHostTools !== undefined && typeof overrides.controllerHostTools !== "boolean") {
    throw new Error("Controller host-tools policy must be a boolean supplied by operator configuration.");
  }
  const controllerHostTools = overrides.controllerHostTools === true;
  if (controllerHostTools && (!controllerPool || !workerPool || !subscriptionDesktopJobs || !controllerReadOnly)) {
    throw new Error("Controller host tools require the supervised subscription controller and worker pools.");
  }
  if (overrides.controllerSpawnAgents !== undefined && typeof overrides.controllerSpawnAgents !== "boolean") {
    throw new Error("Controller SpawnAgent policy must be a boolean supplied by operator configuration.");
  }
  const controllerSpawnAgents = overrides.controllerSpawnAgents === true;
  if (controllerSpawnAgents && !controllerHostTools) {
    throw new Error("Controller SpawnAgent delegation requires pooled subscription host tools.");
  }
  if (overrides.factoryNative !== undefined && typeof overrides.factoryNative !== "boolean") {
    throw new Error("Factory-native policy must be a boolean supplied by operator configuration.");
  }
  const factoryNative = overrides.factoryNative === true;
  if (factoryNative && (!controllerHostTools || !controllerSpawnAgents || overrides.nativeWorkflows)) {
    throw new Error("Factory-native mode requires pooled host tools and SpawnAgent, and excludes native workflows.");
  }
  const controllerApprovalPolicy = overrides.controllerApprovalPolicy ?? (factoryNative ? "bypass" : "ask");
  if (factoryNative && controllerApprovalPolicy !== "bypass") throw new Error("Factory-native mode delegates approval decisions to Factory; bridge confirmation must be bypass.");
  if (controllerApprovalPolicy !== "ask" && controllerApprovalPolicy !== "bypass") {
    throw new Error("Controller approval policy must be ask or bypass supplied by operator configuration.");
  }
  if (controllerApprovalPolicy === "bypass" && !controllerHostTools) {
    throw new Error("Controller approval bypass requires explicit pooled subscription host tools.");
  }
  if (controllerPool && (!workerPool || !subscriptionDesktopJobs || !controllerReadOnly)) {
    throw new Error("The controller pool requires the supervised worker pool and a read-only subscription Desktop controller.");
  }
  if (!controllerPool && overrides.subscriptionAccounts !== undefined) {
    throw new Error("Private subscription account descriptors require explicit controller pool configuration.");
  }
  let subscriptionAccounts: readonly SubscriptionAccount[] | undefined;
  if (workerPool && (!subscriptionDesktopJobs || !controllerReadOnly)) {
    throw new Error("The supervised worker pool requires a read-only subscription Desktop controller.");
  }
  if (controllerReadOnly && (!subscriptionDesktopJobs || !workerControlFile || !workerMcpPrefix)) {
    throw new Error("Read-only controllers require supervised fixed-seat subscription Desktop and its exact worker connection.");
  }
  if (desktopJobs && mode === "sdk" && !nativeWorkflows && !subscriptionDesktopJobs) throw new Error("Desktop SDK jobs require an explicit native workflow route or a fixed subscription seat.");
  if (subscriptionDesktopJobs) {
    if (!overrides.subscriptionProfile || !SUBSCRIPTION_PROFILES.includes(overrides.subscriptionProfile)
        || typeof overrides.subscriptionExpectedEmail !== "string" || !/^[^\s@]+@[^\s@]+$/.test(overrides.subscriptionExpectedEmail)) {
      throw new Error("Subscription Desktop jobs require a private fixed Team profile and expected account identity.");
    }
    if (controllerReadOnly && workerMcpPrefix !== (workerPool ? "factory-workers-pool___" : `factory-workers-${overrides.subscriptionProfile}___`)) {
      throw new Error(workerPool ? "The pooled controller requires the exact supervised pool worker namespace."
        : "The read-only controller must use its own fixed seat's worker namespace.");
    }
    if (claudeProfiles?.length || claudePool?.length || overrides.claudeExecutable || env("BRIDGE_CLAUDE_EXECUTABLE")
        || workflowRoute.baseUrl || workflowRoute.model || workflowRoute.tokenEnv || overrides.workflowProvider) {
      throw new Error("Subscription Desktop jobs cannot use an account pool, custom executable or API routing override.");
    }
    if (Object.keys(process.env).some(name => process.env[name] && (/^ANTHROPIC_|^OPENROUTER_/.test(name)
        || ["BRIDGE_API_KEY_HELPER", "BRIDGE_OPENROUTER_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name)))) {
      throw new Error("Subscription Desktop jobs refuse API, router, helper and token environment credentials; values are not shown.");
    }
    preflightAuth("subscription", process.env);
    if (controllerPool) subscriptionAccounts = validateSubscriptionAccountPool(overrides.subscriptionAccounts, {
      profile: overrides.subscriptionProfile, expectedEmail: overrides.subscriptionExpectedEmail, configDir: process.env.CLAUDE_CONFIG_DIR,
    });
  }
  if (desktopProfile && (permissionMode !== "ask" || !isLoopbackHost(host))) throw new Error("Desktop profile requires ask permissions and loopback binding.");
  const config: BridgeConfig = {
    desktopProfile,
    desktopJobs, desktopLifecycle, ignoreUnknownSessionMarkers, desktopRuntimePath, desktopStateRoot,
    desktopWorkflow: desktopWorkflow as BridgeConfig["desktopWorkflow"],
    workerControlFile, workerMcpPrefix,
    nativeWorkflows,
    ...(nativeWorkflows ? { workflowProvider: workflowProvider as "anthropic" | "openrouter" } : {}),
    ...(nativeWorkflows ? { workflowMaxBudgetUsd, workflowMaxMs } : {}),
    droidSessionsDir: overrides.droidSessionsDir ?? (desktopProfile && mode === "sdk" && authMode === "claude-config"
      ? resolve(env("FACTORY_HOME_OVERRIDE") ?? homedir(), ".factory", "sessions") : undefined),
    host,
    port: overrides.port ?? intEnv("BRIDGE_PORT", 18787),
    mode,
    clientToken,
    adminToken,
    hookToken,
    allowRemote,
    allowedHosts,
    dataDir,
    logDir,
    sandboxDir: resolve(dataDir, "sandbox"),
    maxBodyBytes: overrides.maxBodyBytes ?? intEnv("BRIDGE_MAX_BODY_BYTES", 8 * 1024 * 1024),
    maxSessions: overrides.maxSessions ?? intEnv("BRIDGE_MAX_SESSIONS", nativeWorkflows ? 1 : 32),
    maxIdleSessions: overrides.maxIdleSessions ?? intEnv("BRIDGE_MAX_IDLE_SESSIONS", 4),
    sdkStartTimeoutMs: overrides.sdkStartTimeoutMs ?? intEnv("BRIDGE_SDK_START_TIMEOUT_MS", 60_000),
    sessionMaxRecords: overrides.sessionMaxRecords ?? intEnv("BRIDGE_SESSION_MAX_RECORDS", 1000),
    sessionRetentionMs: overrides.sessionRetentionMs ?? intEnv("BRIDGE_SESSION_RETENTION_MS", 7 * 24 * 60 * 60 * 1000),
    // 0: no limit. Droid Mission workers have made over 300 model calls on one feature.
    maxTurns: overrides.maxTurns ?? intEnv("BRIDGE_MAX_TURNS", 0),
    // A Mission orchestrator can wait hours on StartMissionRun, and AskUser on a person overnight.
    toolWaitMs: overrides.toolWaitMs ?? intEnv("BRIDGE_TOOL_WAIT_MS", 14 * 24 * 60 * 60 * 1000),
    toolWaitTimeoutMs: overrides.toolWaitTimeoutMs ?? intEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", 12 * 60 * 60 * 1000),
    workerEndGraceMs: overrides.workerEndGraceMs ?? intEnv("BRIDGE_WORKER_END_GRACE_MS", 2 * 60 * 1000),
    requestTimeoutMs: overrides.requestTimeoutMs ?? intEnv("BRIDGE_REQUEST_TIMEOUT_MS", 10 * 60 * 1000),
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? intEnv("BRIDGE_APPROVAL_TIMEOUT_MS", 30 * 60 * 1000),
    turnMaxMs: overrides.turnMaxMs ?? intEnv("BRIDGE_TURN_MAX_MS", 2 * 60 * 60 * 1000),
    claudeExecutable: overrides.claudeExecutable ?? env("BRIDGE_CLAUDE_EXECUTABLE"),
    sdkCwd: canonicalWorkspacePath(overrides.sdkCwd ?? env("BRIDGE_SDK_CWD", resolve(dataDir, "sandbox"))!),
    persistSessions: overrides.persistSessions ?? env("BRIDGE_PERSIST", "1") !== "0",
    logBodies: overrides.logBodies ?? env("BRIDGE_LOG_BODIES") === "1",
    authMode,
    ...(claudePool ? { claudePool } : {}),
    permissionMode,
    upstreamBaseUrl: overrides.upstreamBaseUrl ?? env("BRIDGE_UPSTREAM_BASE_URL"),
    upstreamModel: overrides.upstreamModel ?? env("BRIDGE_UPSTREAM_MODEL"),
    upstreamTokenEnv: overrides.upstreamTokenEnv ?? env("BRIDGE_UPSTREAM_TOKEN_ENV"),
    models: openrouter && overrides.models === undefined && !env("BRIDGE_MODELS") ? [{ id: "claude-opus-5-5", model: "anthropic/claude-opus-5.5", displayName: "Opus 5.5 via OpenRouter" }] : overrides.models !== undefined ? validateModels(overrides.models)
      : mergeModelCatalog(
        withProfiles(env("BRIDGE_MODELS") ? modelsFromIds(parseModelIds(env("BRIDGE_MODELS")!), authMode) : claudeConfig ? claudeConfigModels(claudeConfig).models : undefined,
          [...(claudeProfiles ?? []), ...(claudePool ? [{ id: POOL_PROFILE }] : [])]),
        readCursorMenu(env("BRIDGE_CURSOR_MODELS_FILE")),
      ),
  };
  for (const [name, value, minimum] of [
    ["BRIDGE_MAX_SESSIONS", config.maxSessions, 1], ["BRIDGE_MAX_IDLE_SESSIONS", config.maxIdleSessions, 0],
    ["BRIDGE_SDK_START_TIMEOUT_MS", config.sdkStartTimeoutMs, 1], ["BRIDGE_SESSION_MAX_RECORDS", config.sessionMaxRecords, 1],
    ["BRIDGE_SESSION_RETENTION_MS", config.sessionRetentionMs, 1],
  ] as const) {
    if (value === undefined || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  if (openrouter && (config.models?.length !== 1 || config.models[0]?.id !== "claude-opus-5-5" || config.models[0]?.model !== "anthropic/claude-opus-5.5" || config.models[0]?.claudeProfile || config.models[0]?.provider === "cursor")) throw new Error("OpenRouter workflows require the exact approved Opus model catalog.");
  if (nativeWorkflows && !openrouter && config.models?.some((model) => model.id.includes("/") || model.model.includes("/") || model.claudeProfile || model.provider === "cursor" || !/^(?:claude-[a-z0-9.-]+|opus|sonnet|haiku)$/.test(model.model))) {
    throw new Error("Native workflows require unprefixed Anthropic model routes, without account or Cursor selection.");
  }
  if (subscriptionDesktopJobs && (config.models?.length !== 1 || config.models[0]?.id !== "claude-opus-5-5"
      || config.models[0]?.model !== "claude-opus-5-5" || config.models[0]?.claudeProfile || config.models[0]?.provider === "cursor")) {
    throw new Error("Subscription Desktop jobs require the fixed unprefixed Opus 5.5 model route.");
  }
  if (claudeConfig) Object.defineProperty(config, "claudeConfig", { value: claudeConfig });
  if (claudeProfiles?.length) Object.defineProperty(config, "claudeProfiles", { value: claudeProfiles });
  if (overrides.subscriptionExpectedEmail) Object.defineProperty(config, "subscriptionExpectedEmail", { value: overrides.subscriptionExpectedEmail });
  if (overrides.subscriptionProfile) Object.defineProperty(config, "subscriptionProfile", { value: overrides.subscriptionProfile });
  Object.defineProperty(config, "controllerReadOnly", { value: controllerReadOnly, enumerable: true });
  Object.defineProperty(config, "workerPool", { value: workerPool, enumerable: true });
  Object.defineProperty(config, "controllerPool", { value: controllerPool, enumerable: true });
  Object.defineProperty(config, "controllerHostTools", { value: controllerHostTools, enumerable: true });
  Object.defineProperty(config, "controllerSpawnAgents", { value: controllerSpawnAgents, enumerable: true });
  Object.defineProperty(config, "factoryNative", { value: factoryNative, enumerable: true });
  Object.defineProperty(config, "controllerApprovalPolicy", { value: controllerApprovalPolicy, enumerable: true });
  if (subscriptionAccounts) Object.defineProperty(config, "subscriptionAccounts", { value: subscriptionAccounts });
  return config;
}
