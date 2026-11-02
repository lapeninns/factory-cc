import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { installShutdownHandlers } from "../src/index.js";
import { assertNativeWorkflowSupport } from "../src/runtime/native-workflow-support.js";

export function parseApiWorkflowArgs(argv: string[]): { check: boolean; dataDir: string; project: string; port: number; apiKeyFile?: string; provider: "anthropic" | "openrouter" } {
  let check = false, port = 18788, dataDir = "", project = "", apiKeyFile: string | undefined;
  let provider: "anthropic" | "openrouter" = "anthropic";
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--check") { check = true; continue; }
    if (!["--data-dir", "--project", "--port", "--api-key-file", "--provider"].includes(flag) || seen.has(flag)) throw new Error("Use --check --data-dir PATH --project PATH [--port PORT] [--api-key-file PATH] [--provider anthropic|openrouter]. Credential values must not appear in arguments.");
    seen.add(flag);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--provider") {
      if (value !== "anthropic" && value !== "openrouter") throw new Error("Provider must be anthropic or openrouter.");
      provider = value;
    } else if (flag === "--port") {
      if (!/^\d+$/.test(value)) throw new Error("Port must be an integer from 1024 to 65535.");
      port = Number(value);
    } else if (flag === "--api-key-file") apiKeyFile = resolve(value);
    else if (flag === "--project") project = realpathSync(resolve(value));
    else dataDir = resolve(value);
  }
  if (!dataDir || !project) throw new Error("Explicit --data-dir and --project are required; existing desktop state is not reused.");
  if (port < 1024 || port > 65535 || port === 18787) throw new Error("Use a separate port from 1024 to 65535; the existing bridge port 18787 is reserved.");
  if (dataDir === project || project.startsWith(dataDir + "/") || dataDir.startsWith(project + "/")) throw new Error("Keep API workflow state outside the project.");
  return { check, dataDir, project, port, apiKeyFile, provider };
}

export async function runApiWorkflows(argv = process.argv.slice(2)): Promise<void> {
  const args = parseApiWorkflowArgs(argv);
  const keyEnv = args.provider === "openrouter" ? "BRIDGE_OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  const previousKey = process.env[keyEnv];
  let completed = false;
  if (args.apiKeyFile) {
    let key: string;
    try {
      const info = lstatSync(args.apiKeyFile);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 16384 || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe");
      key = readFileSync(args.apiKeyFile, "utf8").trim();
      if (!key || /[\r\n\0]/.test(key)) throw new Error("invalid");
    } catch { throw new Error("API key file must be an owned private regular file containing one nonempty credential."); }
    process.env[keyEnv] = key;
  }
  try {
    await runConfiguredApiWorkflows(args);
    completed = true;
  } finally {
    if (args.apiKeyFile && (args.check || !completed)) {
      if (previousKey === undefined) delete process.env[keyEnv];
      else process.env[keyEnv] = previousKey;
    }
  }
}

async function runConfiguredApiWorkflows(args: ReturnType<typeof parseApiWorkflowArgs>): Promise<void> {
  const marker = join(args.dataDir, "api-workflows.json");
  if (existsSync(args.dataDir)) {
    if (!existsSync(marker) || lstatSync(args.dataDir).isSymbolicLink() || lstatSync(marker).isSymbolicLink()) throw new Error("Refusing existing state not owned by the API workflow launcher.");
    const saved = JSON.parse(readFileSync(marker, "utf8"));
    if (saved.mode !== "api-native-workflows" || saved.project !== args.project || (saved.provider ?? "anthropic") !== args.provider) throw new Error("Existing API workflow state belongs to another target.");
  }
  const credentials: Record<string, string> = {};
  if (!args.check) {
    for (const name of ["client", "admin", "hook"]) {
      const path = join(args.dataDir, `${name}-token`);
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Existing service token must be a private regular file.");
      const value = readFileSync(path, "utf8").trim();
      if (!/^[a-f0-9]{48,128}$/i.test(value)) throw new Error("Existing service token is invalid.");
      credentials[name] = value;
    }
  }
  const config = loadConfig({ mode: "sdk", nativeWorkflows: true, workflowProvider: args.provider, authMode: args.provider === "openrouter" ? "byok" : "anthropic-api", desktopProfile: true,
    ...(args.provider === "openrouter" ? { upstreamBaseUrl: "https://openrouter.ai/api", upstreamModel: "anthropic/claude-opus-5.5", upstreamTokenEnv: "BRIDGE_OPENROUTER_API_KEY" } : {}),
    host: "127.0.0.1", port: args.port, dataDir: args.dataDir, sdkCwd: args.project, permissionMode: "ask", maxSessions: 1,
    clientToken: credentials.client ?? randomBytes(24).toString("hex"),
    adminToken: credentials.admin ?? randomBytes(24).toString("hex"),
    hookToken: credentials.hook ?? randomBytes(24).toString("hex"),
    models: [{ id: "claude-opus-5-5", model: args.provider === "openrouter" ? "anthropic/claude-opus-5.5" : "claude-opus-5-5", displayName: "Opus 5.5 API workflows" }] });
  const support = assertNativeWorkflowSupport();
  const report = { mode: "api-native-workflows", provider: args.provider, host: config.host, port: config.port, project: args.project,
    dataDir: config.dataDir, maxSessions: config.maxSessions, workflowMaxBudgetUsd: config.workflowMaxBudgetUsd,
    workflowMaxMs: config.workflowMaxMs, credentialConfigured: true, credentialValidated: false,
    runtime: { sdkVersion: support.sdkVersion, cliVersion: support.cliVersion, sha256: support.sha256 },
    activation: args.check ? "check-only; no server or model request" : "start" };
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ mode: report.mode, project: args.project, provider: args.provider }) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
  if (args.check) return;
  // Refuse to borrow desktop tokens; each service instance has separate local client credentials.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  for (const [name, token] of [["client", config.clientToken], ["admin", config.adminToken], ["hook", config.hookToken]]) {
    if (credentials[name!]) continue;
    writeFileSync(join(config.dataDir, `${name}-token`), `${token}\n`, { mode: 0o600, flag: "wx" });
  }
  const logger = createLogger(config.logDir);
  const app = createBridgeApp(config, logger, join(config.sandboxDir, "CANARY.txt"));
  const cleanup = installShutdownHandlers(app, logger);
  try { await listen(app, config); }
  catch (error) { cleanup(); await app.close(); throw error; }
  console.log(`API workflow bridge listening on ${app.url}; client credentials remain in the private data directory.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runApiWorkflows().catch((error) => { console.error(error instanceof Error ? error.message : "API workflow startup failed."); process.exitCode = 1; });
}
