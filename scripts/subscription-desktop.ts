import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareSubscription } from "../src/workers/subscription-auth.js";
import { loadConfig, validateSubscriptionAccountPool, type SubscriptionAccount } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { installShutdownHandlers } from "../src/index.js";
import { SUBSCRIPTION_PROFILES, validateDesktopJobBinding, type SubscriptionProfile } from "../src/runtime/desktop-jobs.js";

export function parseSubscriptionDesktop(argv: string[]) {
  const values = new Map<string, string>(); let check = false, workerPool = false, controllerPool = false, hostTools = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name === "--check") { check = true; continue; }
    if (name === "--worker-pool") {
      if (workerPool) throw new Error("Duplicate worker pool option.");
      workerPool = true; continue;
    }
    if (name === "--controller-pool") {
      if (controllerPool) throw new Error("Duplicate controller pool option.");
      controllerPool = true; continue;
    }
    if (name === "--host-tools") {
      if (hostTools) throw new Error("Duplicate host-tools option.");
      hostTools = true; continue;
    }
    if (!["--profile", "--project", "--data-dir", "--port", "--runtime-path", "--state-root", "--worker-control", "--worker-mcp-prefix", "--approval-policy"].includes(name) || values.has(name) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error("Invalid subscription Desktop arguments.");
    values.set(name, argv[++i]!);
  }
  if (controllerPool && !workerPool) throw new Error("The controller pool requires --worker-pool.");
  if (hostTools && (!controllerPool || !workerPool)) throw new Error("Host tools require --controller-pool and --worker-pool.");
  const approvalPolicy = values.get("--approval-policy") ?? "ask";
  if (approvalPolicy !== "ask" && approvalPolicy !== "bypass") throw new Error("Approval policy must be ask or bypass.");
  if (approvalPolicy === "bypass" && !hostTools) throw new Error("Approval bypass requires explicit --host-tools.");
  const profile = values.get("--profile");
  if (!SUBSCRIPTION_PROFILES.includes(profile as SubscriptionProfile)) throw new Error("Select one assigned Team profile.");
  const project = values.get("--project"), dataDir = values.get("--data-dir");
  if (!project || !dataDir || !isAbsolute(project) || !isAbsolute(dataDir)) throw new Error("Absolute project and private data directories are required.");
  const runtimePath = values.get("--runtime-path"), stateRoot = values.get("--state-root");
  if (!runtimePath || !stateRoot || !isAbsolute(runtimePath) || !isAbsolute(stateRoot)) throw new Error("Absolute shared runtime and state paths are required.");
  const worktree = validateDesktopJobBinding({ sessionId: "subscription-desktop-preflight", cwd: project,
    subscriptionProfile: profile as SubscriptionProfile, workspacePolicy: hostTools ? "controller-host" : "controller-readonly" }).cwd;
  const port = Number(values.get("--port") ?? 18790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 18787) throw new Error("Use a separate local validation port.");
  const workerControlFile = values.get("--worker-control"), workerMcpPrefix = values.get("--worker-mcp-prefix");
  if (!workerControlFile || !isAbsolute(workerControlFile) || !workerMcpPrefix || !/^(?:mcp__[A-Za-z0-9_]+__|[A-Za-z0-9_-]+___)$/.test(workerMcpPrefix)) {
    throw new Error("The read-only controller requires its absolute worker-control path and exact MCP namespace.");
  }
  if (workerMcpPrefix !== (workerPool ? "factory-workers-pool___" : `factory-workers-${profile}___`)) {
    throw new Error(workerPool ? "The pooled controller requires the exact supervised pool worker namespace."
      : "The read-only controller must use its own fixed seat's worker namespace.");
  }
  return { check, workerPool, controllerPool, hostTools, approvalPolicy: approvalPolicy as "ask" | "bypass", profile: profile as SubscriptionProfile, project: worktree, dataDir: resolve(dataDir), runtimePath: resolve(runtimePath), stateRoot: resolve(stateRoot), port, workerControlFile: resolve(workerControlFile), workerMcpPrefix };
}

function privateFile(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 16 * 1024) throw new Error("Unsafe private subscription state file.");
  return readFileSync(path, "utf8");
}

function readState(args: ReturnType<typeof parseSubscriptionDesktop>): Record<string, string> {
  const credentials: Record<string, string> = {};
  if (existsSync(args.dataDir)) {
    const info = lstatSync(args.dataDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error("Unsafe private data path.");
    if (readdirSync(args.dataDir).length === 0) return credentials;
    const marker = JSON.parse(privateFile(join(args.dataDir, "subscription-desktop.json")));
    if (marker.profile !== args.profile || marker.project !== args.project) throw new Error("This state belongs to another profile or project.");
    if ((marker.workerPool ?? false) !== args.workerPool || (marker.controllerPool ?? false) !== args.controllerPool
        || (marker.hostTools ?? false) !== args.hostTools
        || (marker.approvalPolicy ?? "ask") !== args.approvalPolicy
        || (marker.workerMcpPrefix !== undefined && marker.workerMcpPrefix !== args.workerMcpPrefix)
        || (marker.workerControlFile !== undefined && marker.workerControlFile !== args.workerControlFile)
        || (args.workerPool && (marker.workerMcpPrefix === undefined || marker.workerControlFile === undefined))) {
      throw new Error("This state belongs to another worker connection or pool policy.");
    }
    if ((marker.runtimePath !== undefined && marker.runtimePath !== args.runtimePath)
        || (marker.stateRoot !== undefined && marker.stateRoot !== args.stateRoot)) throw new Error("This state belongs to another shared runtime.");
    for (const name of ["client", "admin", "hook"]) {
      credentials[name] = privateFile(join(args.dataDir, name + "-token")).trim();
      if (!/^[a-f0-9]{48,128}$/.test(credentials[name]!)) throw new Error("Invalid local service token.");
    }
  }
  return credentials;
}

export async function runSubscriptionDesktop(argv = process.argv.slice(2)): Promise<void> {
  const args = parseSubscriptionDesktop(argv);
  const credentials = readState(args);
  const preparedAccounts = args.controllerPool
    ? await Promise.all(SUBSCRIPTION_PROFILES.map(profile => prepareSubscription(profile)))
    : [await prepareSubscription(args.profile)];
  const prepared = preparedAccounts.find(account => account.expectedIdentity.profile === args.profile);
  if (!prepared) throw new Error("The configured initial subscription profile did not pass its native preflight.");
  const subscriptionAccounts: readonly SubscriptionAccount[] | undefined = args.controllerPool
    ? validateSubscriptionAccountPool(preparedAccounts.map((account, index) => ({ profile: account.expectedIdentity.profile,
      expectedEmail: account.expectedIdentity.email, env: account.env, weight: index < 4 ? 5 : 1 })),
    { profile: args.profile, expectedEmail: prepared.expectedIdentity.email, configDir: prepared.env.CLAUDE_CONFIG_DIR })
    : undefined;
  if (args.check) {
    console.log(JSON.stringify({ profile: args.profile, workerPool: args.workerPool, controllerPool: args.controllerPool, hostTools: args.hostTools, approvalPolicy: args.approvalPolicy,
      ...(subscriptionAccounts ? { controllerProfiles: subscriptionAccounts.map(account => account.profile) } : {}),
      authentication: "subscription", apiCredentialsUsed: false, preflightVerified: true, desktopJobs: true, port: args.port, modelRequestsMade: false }));
    return;
  }
  // Ambient process environment starts on the configured initial subscription.
  // Other preflighted native accounts are private immutable descriptors only.
  for (const name of Object.keys(process.env)) if (/^ANTHROPIC_|^CLAUDE_|^BRIDGE_|^AWS_|^GOOGLE_|^OPENROUTER_/.test(name)) delete process.env[name];
  Object.assign(process.env, prepared.env);
  const config = loadConfig({ mode: "sdk", authMode: "subscription", desktopProfile: true, desktopLifecycle: true, desktopJobs: true,
    controllerReadOnly: true, workerPool: args.workerPool, controllerPool: args.controllerPool, controllerHostTools: args.hostTools, controllerApprovalPolicy: args.approvalPolicy, subscriptionAccounts,
    desktopRuntimePath: args.runtimePath, desktopStateRoot: args.stateRoot,
    host: "127.0.0.1", port: args.port, dataDir: args.dataDir, sdkCwd: args.project, permissionMode: "ask", maxSessions: 16,
    clientToken: credentials.client ?? randomBytes(32).toString("hex"), adminToken: credentials.admin ?? randomBytes(32).toString("hex"), hookToken: credentials.hook ?? randomBytes(32).toString("hex"),
    subscriptionExpectedEmail: prepared.expectedIdentity.email, subscriptionProfile: args.profile, workerControlFile: args.workerControlFile, workerMcpPrefix: args.workerMcpPrefix,
    models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: `${args.profile} Opus 5.5 subscription` }] });
  mkdirSync(args.dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(args.dataDir, "subscription-desktop.json"))) {
    writeFileSync(join(args.dataDir, "subscription-desktop.json"), JSON.stringify({ profile: args.profile, project: args.project, runtimePath: args.runtimePath, stateRoot: args.stateRoot,
      workerPool: args.workerPool, controllerPool: args.controllerPool, hostTools: args.hostTools, approvalPolicy: args.approvalPolicy, workerMcpPrefix: args.workerMcpPrefix, workerControlFile: args.workerControlFile }) + "\n", { mode: 0o600, flag: "wx" });
    for (const [name, value] of [["client", config.clientToken], ["admin", config.adminToken], ["hook", config.hookToken]]) writeFileSync(join(args.dataDir, name + "-token"), value + "\n", { mode: 0o600, flag: "wx" });
  }
  const logger = createLogger(config.logDir), app = createBridgeApp(config, logger, join(config.sandboxDir, "CANARY.txt"));
  installShutdownHandlers(app, logger); await listen(app, config);
  console.log(JSON.stringify({ ready: true, profile: args.profile, workerPool: args.workerPool, controllerPool: args.controllerPool, hostTools: args.hostTools, approvalPolicy: args.approvalPolicy,
    url: app.url, authentication: "subscription", apiCredentialsUsed: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runSubscriptionDesktop().catch(() => { console.error("Subscription Desktop startup failed; no API or alternate account fallback was used."); process.exitCode = 1; });
}
