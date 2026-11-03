import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { APIWorkerService, type WorkerApprovalPolicy, type WorkerRepositoryPolicy } from "../src/workers/service.js";
import { startWorkerControl } from "../src/workers/control.js";
import { acquireDesktopJobLease, updateDesktopJobRecord, SUBSCRIPTION_PROFILES, type SubscriptionProfile } from "../src/runtime/desktop-jobs.js";
import { startWorkerMcp } from "../src/workers/http.js";
import { prepareSubscription } from "../src/workers/subscription-auth.js";
import { WorkerStartRejected } from "../src/workers/start-rejection.js";

export interface WorkerServerConfig {
  enabled: boolean;
  provider: "anthropic" | "openrouter" | "subscription";
  subscriptionProfile?: SubscriptionProfile;
  profileMappingPath?: string;
  apiKeyFile?: string;
  stateRoot: string;
  workspaceRoot: string;
  allowedRepositories: string[];
  repositoryPolicy?: WorkerRepositoryPolicy;
  approvalPolicy?: WorkerApprovalPolicy;
  nativeRuntimePath: string;
  sharedStateRoot: string;
  approvalCommand?: string;
  port: number;
  clientTokenFile: string;
  /** Set only after the actual Factory native AskUser approval flow has been verified. */
  approvalGuardVerified: boolean;
  maxBudgetUsd?: number;
  maxMs: number;
  maxTurns: number;
}

function privateFile(path: string, limit = 64 * 1024): string {
  if (!isAbsolute(path)) throw new Error("An absolute private file is required.");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()) || info.size > limit) throw new Error("Unsafe private configuration file.");
  return readFileSync(path, "utf8");
}

export function readWorkerServerConfig(path: string): WorkerServerConfig {
  const value = JSON.parse(privateFile(path)) as WorkerServerConfig;
  if (!value || typeof value.enabled !== "boolean" || typeof value.approvalGuardVerified !== "boolean" || !["anthropic", "openrouter", "subscription"].includes(value.provider)) throw new Error("Invalid worker service configuration.");
  if ((value.approvalPolicy !== undefined && !["ask", "bypass"].includes(value.approvalPolicy))
      || (value.approvalPolicy === "bypass" && value.provider !== "subscription")) throw new Error("Automatic worker approvals require an explicit subscription policy.");
  if (value.repositoryPolicy !== undefined && !["allowlist", "owned-git"].includes(value.repositoryPolicy)) throw new Error("Invalid worker repository policy.");
  if (value.repositoryPolicy === "owned-git" && value.provider !== "subscription") throw new Error("Owned Git repository access requires subscription authentication.");
  for (const key of ["stateRoot", "workspaceRoot", "nativeRuntimePath", "sharedStateRoot", "clientTokenFile"] as const) if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new Error("Worker paths must be absolute.");
  if (value.approvalCommand !== undefined && !isAbsolute(value.approvalCommand)) throw new Error("An approval helper path must be absolute.");
  if (value.provider === "subscription") {
    if (!SUBSCRIPTION_PROFILES.includes(value.subscriptionProfile as SubscriptionProfile) || value.apiKeyFile !== undefined || value.maxBudgetUsd !== undefined || value.approvalCommand !== undefined) throw new Error("Subscription workers require one fixed Team profile and forbid API key/budget or shell-approval configuration.");
    if (value.profileMappingPath !== undefined && !isAbsolute(value.profileMappingPath)) throw new Error("Profile mapping path must be absolute.");
  } else if (typeof value.apiKeyFile !== "string" || !isAbsolute(value.apiKeyFile) || !Number.isFinite(value.maxBudgetUsd) || value.maxBudgetUsd! <= 0) throw new Error("API workers require an explicit key file and budget.");
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.port === 18787) throw new Error("Use a dedicated local worker port.");
  if (!Array.isArray(value.allowedRepositories) || (value.repositoryPolicy !== "owned-git" && !value.allowedRepositories.length) || value.allowedRepositories.some(path => typeof path !== "string" || !isAbsolute(path))) throw new Error("An explicit repository allowlist is required.");
  if (!Number.isInteger(value.maxMs) || value.maxMs < 1000 || value.maxMs > 7200000 || !Number.isInteger(value.maxTurns) || value.maxTurns < 1 || value.maxTurns > 500) throw new Error("Finite worker deadline and turn bounds are required.");
  return value;
}

export async function runFactoryWorkers(argv = process.argv.slice(2), options: { subscriptionOnly?: boolean } = {}): Promise<void> {
  const check = argv.includes("--check");
  const serve = argv.includes("--serve");
  const filtered = argv.filter(value => value !== "--check" && value !== "--serve");
  if (filtered.length !== 2 || filtered[0] !== "--config") throw new Error("Use --config /absolute/private/config.json [--check].");
  const config = readWorkerServerConfig(filtered[1]!);
  if (options.subscriptionOnly && config.provider !== "subscription") throw new Error("This entry point accepts subscription authentication only.");
  let key: string | undefined;
  let subscriptionLoginVerified = false;
  if (config.provider === "subscription" && (check || serve)) {
    try { await prepareSubscription(config.subscriptionProfile!, { mappingPath: config.profileMappingPath }); subscriptionLoginVerified = true; }
    catch { if (config.enabled) throw new Error("The fixed Team subscription login is not ready."); }
  } else if (check || serve) {
    try { key = privateFile(config.apiKeyFile!, 16384).trim() || undefined; } catch { if (config.enabled) throw new Error("Configured API credential is unavailable or unsafe."); }
  }
  if (check) {
    console.log(JSON.stringify({ configured: true, enabled: config.enabled, provider: config.provider, subscriptionProfile: config.subscriptionProfile, subscriptionLoginVerified, apiCredentialUsed: Boolean(key), approvalGuardVerified: config.approvalGuardVerified, approvalPolicy: config.approvalPolicy ?? "ask", repositoryPolicy: config.repositoryPolicy ?? "allowlist", repositoryCount: config.allowedRepositories.length, modelRequestsMade: false }));
    return;
  }
  const clientToken = privateFile(config.clientTokenFile, 1024).trim();
  if (!/^[a-f0-9]{48,128}$/.test(clientToken)) throw new Error("Invalid local worker client token.");
  if (!serve) {
    // Factory starts one stdio adapter per session; all adapters use one daemon.
    const client = new Client({ name: "factory-worker-adapter", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${clientToken}` } } }));
    const proxy = new Server({ name: "factory-supervised-workers", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Delegate independent implementation to factory_worker_start, then poll status/wait and report the result. Workers use separate worktrees. Do not use built-in SpawnAgent for work that requires this isolation." });
    proxy.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
    proxy.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params));
    process.stdin.once("end", () => { void client.close(); void proxy.close(); });
    await proxy.connect(new StdioServerTransport());
    return;
  }
  const sourceEnv = { ...process.env };
  for (const name of Object.keys(sourceEnv)) if (/^ANTHROPIC_|^CLAUDE_CODE_(?:OAUTH|USE_|API_BASE_URL|GATEWAY_TOKEN)|^BRIDGE_OPENROUTER_API_KEY$/.test(name)) delete sourceEnv[name];
  if (key) sourceEnv[config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "BRIDGE_OPENROUTER_API_KEY"] = key;
  const runtime = realpathSync(config.nativeRuntimePath);
  const policy = readFileSync(join(runtime, "policies/team-policy.md"), "utf8");
  const workflows = Object.fromEntries(["implement", "investigate", "release-prepare"].map(name => [name, readFileSync(join(runtime, "workflows", name + ".md"), "utf8")]));
  const leases = { pythonExecutable: "/usr/bin/python3", runtimePackagePath: runtime, stateRoot: config.sharedStateRoot, maxRunning: 2 };
  const makeService = () => new APIWorkerService({ stateRoot: config.stateRoot, workspaceRoot: config.workspaceRoot,
    allowedRepositories: config.allowedRepositories, repositoryPolicy: config.repositoryPolicy, approvalPolicy: config.approvalPolicy, provider: config.provider === "subscription" ? { kind: "subscription", profile: config.subscriptionProfile!, mappingPath: config.profileMappingPath } : { kind: config.provider }, maxConcurrent: 2,
    maxBudgetUsd: config.maxBudgetUsd, maxMs: config.maxMs, maxTurns: config.maxTurns, sourceEnv,
    policyText: policy, workflowText: workflows,
    acquireLease: (worker, signal) => acquireDesktopJobLease(leases, { factorySessionId: worker.id, bridgeSessionId: worker.id, cwd: worker.worktree, role: "worker", ...(config.subscriptionProfile ? { subscriptionProfile: config.subscriptionProfile } : {}) }, signal),
    finalizeLease: (worker, result) => updateDesktopJobRecord(leases, { factorySessionId: worker.id, bridgeSessionId: worker.id, cwd: worker.worktree, role: "worker", ...(config.subscriptionProfile ? { subscriptionProfile: config.subscriptionProfile } : {}) }, result),
  });
  let service: APIWorkerService;
  const guarded = {
    start: (input: Parameters<APIWorkerService["start"]>[0]) => {
      if (!config.enabled || !config.approvalGuardVerified) throw new WorkerStartRejected("service_unavailable");
      if (config.provider === "subscription" ? !subscriptionLoginVerified : !key) {
        throw new WorkerStartRejected(config.provider === "subscription" ? "subscription_preflight_failed" : "service_unavailable");
      }
      return service.start(input);
    },
    status: (id: string) => service.status(id), list: () => service.list(), cancel: (id: string) => service.cancel(id),
  };
  const { server } = await startWorkerMcp(() => { service = makeService(); return guarded; }, { port: config.port, token: clientToken, approvalCommand: config.approvalCommand });
  let control;
  try { control = await startWorkerControl(service!, join(config.stateRoot, "approval-control.json")); }
  catch (error) { server.close(); await service!.close(); throw error; }
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { await service.close(); await control.close(); await new Promise<void>(resolve => server.close(() => resolve())); })();
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runFactoryWorkers().catch(() => { console.error("Factory worker service could not start. Check its private configuration, runtime and approval setup."); process.exitCode = 1; });
}
