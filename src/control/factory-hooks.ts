import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, fstatSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FACTORY_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd", "Notification", "Stop", "SubagentStop"] as const;
const MAX_HOOK_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_SETTINGS_BYTES = 128 * 1024;
const CONFIG_FLAG = "--factory-cc-hook-config";
const DESKTOP_FLAG = "--factory-cc-desktop-lifecycle";
const DEFAULT_BINDING_ENV = "BRIDGE_FACTORY_BINDING";
const BINDING_ENV_NAMES = new Set([DEFAULT_BINDING_ENV, "BRIDGE_FACTORY_BINDING_POOL", "BRIDGE_FACTORY_BINDING_NATIVE", ...Array.from({ length: 8 }, (_, index) => `BRIDGE_FACTORY_BINDING_TEAM${index + 1}`)]);

type JsonObject = Record<string, unknown>;
export interface FactoryHookModelScope { modelIds: string[]; sessionsDir: string }
interface HookConfig { url: string; hookToken?: string; command?: string; desktopLifecycle?: boolean; bindingEnv?: string; modelScope?: FactoryHookModelScope }
export interface FactoryHookInstallOptions {
  hooksPath: string;
  configPath: string;
  url: string;
  hookToken: string;
  /** Override only for packaged installations with their own executable. No credentials belong here. */
  command?: string;
  /** Explicitly bind sessions started by Factory Desktop without a CLI wrapper. */
  desktopLifecycle?: boolean;
  /** Keep each fixed-seat controller's lifecycle generation separate. */
  bindingEnv?: string;
  /** Apply this hook only to sessions whose persisted selected model matches. */
  modelScope?: FactoryHookModelScope;
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bindingEnvironment(value: unknown = DEFAULT_BINDING_ENV): string {
  if (typeof value !== "string" || !BINDING_ENV_NAMES.has(value)) {
    throw new Error("Invalid Factory binding environment name");
  }
  return value;
}

function modelScope(value: unknown): FactoryHookModelScope {
  if (!object(value) || typeof value.sessionsDir !== "string" || !isAbsolute(value.sessionsDir)
      || !Array.isArray(value.modelIds) || value.modelIds.length === 0 || value.modelIds.length > 64
      || value.modelIds.some(id => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 512)
      || new Set(value.modelIds).size !== value.modelIds.length) {
    throw new Error("Invalid Factory hook model scope");
  }
  return { sessionsDir: resolve(value.sessionsDir), modelIds: [...value.modelIds] as string[] };
}

/** Droid saves this small settings file before SessionStart. Never inspect transcript content. */
function sessionSettings(scope: FactoryHookModelScope, event: unknown): JsonObject | undefined {
  if (!object(event) || typeof event.session_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(event.session_id)
      || typeof event.transcript_path !== "string" || !isAbsolute(event.transcript_path)
      || event.transcript_path !== resolve(event.transcript_path)
      || basename(event.transcript_path) !== event.session_id + ".jsonl") return undefined;
  let fd: number | undefined;
  try {
    const root = realpathSync(scope.sessionsDir);
    const parent = realpathSync(dirname(event.transcript_path));
    const within = relative(root, parent);
    if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) return undefined;
    fd = openSync(join(parent, event.session_id + ".settings.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || info.mode & 0o022
        || info.size > MAX_SESSION_SETTINGS_BYTES) return undefined;
    const bytes = Buffer.alloc(MAX_SESSION_SETTINGS_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_SESSION_SETTINGS_BYTES) return undefined;
    const settings: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    return object(settings) && typeof settings.model === "string" && scope.modelIds.includes(settings.model) ? settings : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Only Factory's small, owned settings metadata supplies Workstream roles. */
function nativeWorkstreamSettings(settings: JsonObject | undefined): { workstreamId: string; role: "orchestrator" | "agent" } | undefined {
  if (!settings || !Array.isArray(settings.tags)) return;
  const tags = settings.tags.filter(tag => object(tag) && tag.name === "mission-v2");
  if (tags.length !== 1) return;
  const metadata = (tags[0] as JsonObject).metadata;
  if (!object(metadata) || (metadata.kind !== "orchestrator" && metadata.kind !== "agent")
      || typeof metadata.missionId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(metadata.missionId)) return;
  return { workstreamId: metadata.missionId, role: metadata.kind };
}

export function factoryHookEndpoint(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("Factory hooks require a loopback HTTP bridge URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Factory hooks require a loopback HTTP bridge URL");
  }
  return new URL("/internal/host-events", url).href;
}

function privateWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function defaultCommand(configPath: string, desktopLifecycle = false): string {
  const current = fileURLToPath(import.meta.url);
  // A built distribution runs this module directly; source checkout commands
  // use the installed TS loader and the small documented script entrypoint.
  const invocation = current.endsWith(".ts")
    ? [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), resolve(dirname(current), "../../scripts/factory-hook.ts")]
    : [process.execPath, current];
  return [...invocation, CONFIG_FLAG, configPath, ...(desktopLifecycle ? [DESKTOP_FLAG] : [])].map(quote).join(" ");
}

function readHooks(path: string): JsonObject {
  try {
    let value: unknown;
    if (existsSync(path)) value = JSON.parse(readFileSync(path, "utf8"));
    else {
      const settingsPath = join(dirname(path), "settings.json");
      if (!existsSync(settingsPath)) return {};
      const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!object(settings)) throw new Error();
      value = settings.hooks ?? {};
    }
    if (!object(value) || Object.values(value).some((groups) => !Array.isArray(groups))) throw new Error();
    return value;
  } catch { throw new Error("Invalid Factory hooks JSON; hooks were not changed"); }
}

function withoutCommand(groups: unknown[], command: string): unknown[] {
  return groups.flatMap((group) => {
    if (!object(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !object(hook) || hook.type !== "command" || hook.command !== command);
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

/** Merge the adapter into official hook configuration without replacing user hooks. */
export function installFactoryHooks(options: FactoryHookInstallOptions): { hooksPath: string; configPath: string; events: readonly string[] } {
  factoryHookEndpoint(options.url);
  const bindingEnv = bindingEnvironment(options.bindingEnv);
  const scope = options.modelScope === undefined ? undefined : modelScope(options.modelScope);
  if (!options.hookToken.trim()) throw new Error("Factory hooks require a nonempty hook token");
  if (!isAbsolute(options.hooksPath) || !isAbsolute(options.configPath)) throw new Error("Factory hook paths must be absolute");
  if (resolve(options.hooksPath) === resolve(options.configPath)) throw new Error("Factory hooks and private configuration require separate paths");
  const hooks = readHooks(options.hooksPath);
  const command = options.command ?? defaultCommand(options.configPath, options.desktopLifecycle);
  let previousCommand: string | undefined;
  if (existsSync(options.configPath)) {
    const previous = readConfig(options.configPath);
    previousCommand = previous.command;
  }
  for (const event of FACTORY_HOOK_EVENTS) {
    let groups = (hooks[event] ?? []) as unknown[];
    if (previousCommand) groups = withoutCommand(groups, previousCommand);
    groups = withoutCommand(groups, command);
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: 15 }] }];
  }
  // Credentials never occur in hooks.json, process argv, or the return value.
  privateWrite(options.configPath, `${JSON.stringify({ url: options.url, hookToken: options.hookToken, command,
    ...(options.bindingEnv === undefined ? {} : { bindingEnv }),
    ...(scope === undefined ? {} : { modelScope: scope }),
    ...(options.desktopLifecycle ? { desktopLifecycle: true } : {}) })}\n`);
  privateWrite(options.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  return { hooksPath: options.hooksPath, configPath: options.configPath, events: FACTORY_HOOK_EVENTS };
}

/** Remove only this installation, retaining hooks added by users after installation. */
export function removeFactoryHooks(options: { hooksPath: string; configPath: string }): { removed: boolean } {
  if (!existsSync(options.configPath)) return { removed: false };
  const config = readConfig(options.configPath);
  if (!config.command) throw new Error("Factory hook configuration has no installation command");
  const hooks = readHooks(options.hooksPath);
  for (const event of FACTORY_HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = withoutCommand(hooks[event] as unknown[], config.command);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (existsSync(options.hooksPath)) privateWrite(options.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  rmSync(options.configPath, { force: true });
  return { removed: true };
}

function readConfig(path: string): HookConfig {
  let config: unknown;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Cannot read private Factory hook configuration"); }
  if (!object(config) || typeof config.url !== "string" || (config.command !== undefined && typeof config.command !== "string")
      || (config.desktopLifecycle !== undefined && typeof config.desktopLifecycle !== "boolean")) {
    throw new Error("Invalid private Factory hook configuration");
  }
  if (config.bindingEnv !== undefined) bindingEnvironment(config.bindingEnv);
  const scope = config.modelScope === undefined ? undefined : modelScope(config.modelScope);
  const hookToken = typeof config.hookToken === "string" && config.hookToken.trim() ? config.hookToken : undefined;
  const legacyAdmin = typeof config.adminToken === "string" && config.adminToken.trim();
  const command = typeof config.command === "string" ? config.command : undefined;
  // Old installations stored adminToken. Removal only needs command, so that file must still parse.
  if (!hookToken && !legacyAdmin && !command) throw new Error("Invalid private Factory hook configuration");
  factoryHookEndpoint(config.url);
  // Keep existing installations private even if an external editor broadened permissions.
  chmodSync(path, 0o600);
  return { url: config.url, hookToken, command, desktopLifecycle: config.desktopLifecycle === true,
    ...(config.bindingEnv === undefined ? {} : { bindingEnv: config.bindingEnv as string }),
    ...(scope === undefined ? {} : { modelScope: scope }) };
}

export async function forwardFactoryHook(
  config: { url: string; hookToken: string }, event: unknown,
  options: { fetch?: typeof fetch; eventId?: string; timeoutMs?: number; bindingToken?: string; launchId?: string; desktopLifecycle?: boolean } = {},
): Promise<{ additionalContext?: string; bindingToken?: string }> {
  if (!object(event) || typeof event.hook_event_name !== "string" || typeof event.session_id !== "string" || !event.session_id
      || !FACTORY_HOOK_EVENTS.includes(event.hook_event_name as typeof FACTORY_HOOK_EVENTS[number])) throw new Error("Invalid Factory lifecycle hook event");
  if (!config.hookToken.trim()) throw new Error("Factory hooks require a nonempty hook token");
  const url = factoryHookEndpoint(config.url);
  const body = JSON.stringify({ eventId: options.eventId ?? randomUUID(), event, ...(options.bindingToken !== undefined ? { bindingToken: options.bindingToken } : {}),
    ...(event.hook_event_name === "SessionStart" && options.desktopLifecycle ? { desktopLifecycle: true } : {}),
    ...(["SessionStart", "SessionEnd"].includes(event.hook_event_name) && options.launchId ? { launchId: options.launchId } : {}) });
  if (Buffer.byteLength(body) > MAX_HOOK_BYTES) throw new Error("Factory lifecycle hook event exceeds size limit");
  const send = options.fetch ?? fetch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await send(url, { method: "POST", headers: { authorization: `Bearer ${config.hookToken}`, "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000), redirect: "error" });
      if (!response.ok) {
        if (response.status >= 500 && attempt < 2) { await response.body?.cancel(); continue; }
        await response.body?.cancel();
        throw new HookRejectedError();
      }
      const result: unknown = await response.json();
      if (!object(result) || result.ok !== true || (result.additionalContext !== undefined && typeof result.additionalContext !== "string")) throw new HookRejectedError();
      if (result.bindingToken !== undefined && (typeof result.bindingToken !== "string" || !/^[a-f0-9]{64}$/.test(result.bindingToken))) throw new HookRejectedError();
      return event.hook_event_name === "SessionStart"
        ? { ...(typeof result.additionalContext === "string" ? { additionalContext: result.additionalContext } : {}), ...(typeof result.bindingToken === "string" ? { bindingToken: result.bindingToken } : {}) }
        : event.hook_event_name === "UserPromptSubmit" && typeof result.additionalContext === "string"
          ? { additionalContext: result.additionalContext } : {};
    } catch (error) {
      if (error instanceof HookRejectedError || attempt === 2) throw new Error("Factory lifecycle event was not accepted by the bridge");
    }
  }
  throw new Error("Factory lifecycle event was not accepted by the bridge");
}
class HookRejectedError extends Error {}

/** Fixed diagnostics only: hook inputs, response bodies and errors may contain secrets. */
export function factoryHookFailureMessage(_error: unknown): string {
  return "Factory lifecycle bridge unavailable; event delivery failed.";
}

/** Factory loads this official SessionStart environment file for later hooks. */
export function persistFactoryBinding(event: unknown, bindingToken: string, bindingEnv = DEFAULT_BINDING_ENV): void {
  const name = bindingEnvironment(bindingEnv);
  if (!object(event) || event.hook_event_name !== "SessionStart" || typeof event.CLAUDE_ENV_FILE !== "string"
      || !isAbsolute(event.CLAUDE_ENV_FILE) || !/^[a-f0-9]{64}$/.test(bindingToken)) {
    throw new Error("Factory SessionStart requires its official environment file and generation binding");
  }
  const fd = openSync(event.CLAUDE_ENV_FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `\nexport ${name}='${bindingToken}'\n`); }
  finally { closeSync(fd); }
}

export async function factoryHookMain(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Unconfigured hooks still ignore sessions outside run-droid/local. Direct
  // Desktop binding needs an explicit command flag plus private config opt-in.
  const launchId = env.BRIDGE_FACTORY_LAUNCH_ID;
  const desktopFlag = argv.includes(DESKTOP_FLAG);
  if (!launchId?.trim() && !desktopFlag) return;
  const index = argv.indexOf(CONFIG_FLAG);
  const path = index < 0 ? undefined : argv[index + 1];
  if (!path || !isAbsolute(path)) throw new Error("Factory hook requires an absolute private configuration path");
  const config = readConfig(path);
  if (desktopFlag && !config.desktopLifecycle) throw new Error("Direct Desktop lifecycle is not enabled in private hook configuration");
  const desktopLifecycle = desktopFlag && !launchId?.trim();
  if (!config.hookToken) throw new Error("Factory hooks require a nonempty hook token");
  const hookToken = config.hookToken;
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_BYTES) throw new Error("Factory lifecycle hook event exceeds size limit");
    chunks.push(buffer);
  }
  let event: unknown;
  try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid Factory lifecycle hook JSON"); }
  const bindingEnv = bindingEnvironment(config.bindingEnv);
  const bindingToken = env[bindingEnv];
  // A global hook must leave other model connections untouched, including
  // legacy sessions with no binding for this bridge. A previously owned end
  // event may still settle its generation after the selected model changes.
  const ownedSessionEnd = object(event) && event.hook_event_name === "SessionEnd"
    && typeof bindingToken === "string" && /^[a-f0-9]{64}$/.test(bindingToken);
  const scopedSettings = config.modelScope ? sessionSettings(config.modelScope, event) : undefined;
  if (config.modelScope && !scopedSettings && !ownedSessionEnd) return;
  if (desktopLifecycle && object(event) && event.hook_event_name === "SessionStart"
      && (typeof event.CLAUDE_ENV_FILE !== "string" || !isAbsolute(event.CLAUDE_ENV_FILE))) {
    throw new Error("Direct Desktop SessionStart requires its official environment file");
  }
  const clientSessionEnd = !desktopLifecycle && object(event) && event.hook_event_name === "SessionEnd" && bindingToken === undefined;
  if (object(event) && event.hook_event_name !== "SessionStart" && !clientSessionEnd && (!bindingToken || !/^[a-f0-9]{64}$/.test(bindingToken))) {
    throw new Error("Factory lifecycle event has no SessionStart generation binding");
  }
  // Never accept role hints in hook/tool content. Enrich the authenticated
  // envelope only from the same bounded settings file used for model scope.
  if (object(event)) {
    delete event.bridgeNativeWorkstream;
    const native = nativeWorkstreamSettings(scopedSettings);
    if (native) event.bridgeNativeWorkstream = native;
  }
  const result = await forwardFactoryHook({ url: config.url, hookToken }, event, { bindingToken,
    ...(launchId?.trim() ? { launchId } : {}), desktopLifecycle });
  if (object(event) && event.hook_event_name === "SessionStart") {
    if (!result.bindingToken || !result.additionalContext) throw new Error("Factory SessionStart received no generation binding");
    persistFactoryBinding(event, result.bindingToken, bindingEnv);
  }
  if (result.additionalContext) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: object(event) ? event.hook_event_name : "SessionStart", additionalContext: result.additionalContext }, suppressOutput: true })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  factoryHookMain().catch((error: unknown) => {
    process.stderr.write(`${factoryHookFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
