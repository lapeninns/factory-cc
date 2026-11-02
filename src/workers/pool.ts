import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SUBSCRIPTION_PROFILES, type SubscriptionProfile } from "../runtime/desktop-jobs.js";
import { decideWorkerApproval, readPendingWorkerApprovals, type PendingWorkerApproval } from "../runtime/worker-permission-client.js";
import { approvalDigest, approvalSummary } from "./control.js";
import { privateDirectory } from "./worker-state.js";

export interface PoolSeatConfig { profile: SubscriptionProfile; weight: number; configFile: string }
export interface PoolConfig { version: 1; enabled: boolean; stateRoot: string; port: number; clientTokenFile: string; seats: PoolSeatConfig[] }
export interface PoolWorkerInput { repository: string; task: string; workflow: "implement" | "investigate" | "release-prepare" }
export interface PoolBackend {
  profile: SubscriptionProfile;
  weight: number;
  /** Stable route binding, not a credential. Reconfiguration cannot retarget old jobs. */
  identity: string;
  health(signal?: AbortSignal): Promise<boolean>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  pending(id: string, signal: AbortSignal): Promise<PendingWorkerApproval[]>;
  decide(id: string, approval: PendingWorkerApproval, decision: "allow" | "deny", signal: AbortSignal): Promise<void>;
}

interface PoolRoute {
  id: string; ownerHash: string; profile: SubscriptionProfile; backendId?: string;
  phase: "dispatching" | "attached" | "unknown"; createdAt: string; updatedAt: string; requestDigest: string;
  cooldownApplied?: boolean;
}
interface PoolState {
  version: 1;
  seats: Array<{ profile: SubscriptionProfile; identity: string; weight: number }>;
  current: Record<string, number>;
  coolUntil: Record<string, number>;
  routes: PoolRoute[];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validWorker = (value: unknown): value is string => typeof value === "string" && /^worker-[a-f0-9-]{36}$/.test(value);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function readPoolPrivateFile(path: string, limit = 128 * 1024): string {
  if (!isAbsolute(path)) throw new Error("An absolute private pool file is required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > limit) throw new Error();
    return readFileSync(fd, "utf8");
  } catch { throw new Error("Unsafe private pool file."); }
  finally { closeSync(fd); }
}

export function readPoolConfig(path: string): PoolConfig {
  const value: unknown = JSON.parse(readPoolPrivateFile(path));
  if (!object(value) || value.version !== 1 || typeof value.enabled !== "boolean"
      || Object.keys(value).some(key => !["version", "enabled", "stateRoot", "port", "clientTokenFile", "seats"].includes(key))
      || typeof value.stateRoot !== "string" || !isAbsolute(value.stateRoot)
      || typeof value.clientTokenFile !== "string" || !isAbsolute(value.clientTokenFile)
      || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || value.port === 18787
      || !Array.isArray(value.seats) || value.seats.length !== SUBSCRIPTION_PROFILES.length) throw new Error("Invalid subscription pool configuration.");
  const seen = new Set<string>(), files = new Set<string>();
  const seats = value.seats.map(entry => {
    if (!object(entry) || !SUBSCRIPTION_PROFILES.includes(entry.profile as SubscriptionProfile)
        || !Number.isInteger(entry.weight) || Number(entry.weight) < 1 || Number(entry.weight) > 9999
        || typeof entry.configFile !== "string" || !isAbsolute(entry.configFile)
        || seen.has(String(entry.profile)) || files.has(resolve(entry.configFile))) throw new Error("Pool requires eight distinct fixed subscription connections.");
    seen.add(String(entry.profile)); files.add(resolve(entry.configFile));
    return { profile: entry.profile as SubscriptionProfile, weight: Number(entry.weight), configFile: resolve(entry.configFile) };
  });
  return { version: 1, enabled: value.enabled, stateRoot: resolve(value.stateRoot), port: Number(value.port), clientTokenFile: resolve(value.clientTokenFile), seats };
}

export function poolClientToken(config: PoolConfig): string {
  const token = readPoolPrivateFile(config.clientTokenFile, 1024).trim();
  if (!hex(token)) throw new Error("Invalid local pool client token.");
  return token;
}

/** Uses only the existing local worker capability, never a provider credential. */
export function createPoolBackends(config: PoolConfig): PoolBackend[] {
  const ports = new Set<number>(), roots = new Set<string>();
  return config.seats.map(seat => {
    const value: unknown = JSON.parse(readPoolPrivateFile(seat.configFile));
    if (!object(value) || value.provider !== "subscription" || value.subscriptionProfile !== seat.profile || value.enabled !== true
        || value.approvalGuardVerified !== true || value.apiKeyFile !== undefined || value.maxBudgetUsd !== undefined || value.approvalCommand !== undefined
        || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || value.port === config.port || value.port === 18787
        || typeof value.clientTokenFile !== "string" || !isAbsolute(value.clientTokenFile)
        || typeof value.stateRoot !== "string" || !isAbsolute(value.stateRoot)
        || ports.has(Number(value.port)) || roots.has(resolve(value.stateRoot))) throw new Error("Pool backend must be a distinct enabled fixed subscription worker.");
    ports.add(Number(value.port)); roots.add(resolve(value.stateRoot));
    const tokenFile = value.clientTokenFile, stateRoot = resolve(value.stateRoot), port = Number(value.port);
    const control = join(stateRoot, "approval-control.json");
    const token = () => {
      const result = readPoolPrivateFile(tokenFile, 1024).trim();
      if (!/^[a-f0-9]{48,128}$/.test(result)) throw new Error("Invalid backend capability.");
      return result;
    };
    // Bind to the declared fixed connection and account mapping, without reading OAuth state.
    const identity = digest(JSON.stringify({ profile: seat.profile, configFile: seat.configFile, port, stateRoot,
      clientTokenFile: resolve(tokenFile), profileMappingPath: value.profileMappingPath ?? null, workspaceRoot: value.workspaceRoot ?? null }));
    return {
      profile: seat.profile, weight: seat.weight, identity,
      health: async signal => {
        try {
          const response = await fetch("http://127.0.0.1:" + port + "/health", { headers: { authorization: "Bearer " + token() },
            signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(1500)]), redirect: "error" });
          return response.ok;
        } catch { return false; }
      },
      call: async (name, args, signal) => {
        const client = new Client({ name: "factory-subscription-pool", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), {
            requestInit: { headers: { authorization: "Bearer " + token() }, redirect: "error" },
          }), { signal, timeout: 5000 });
          const timeout = name === "factory_worker_start" ? 90_000 : name === "factory_worker_cancel" ? 45_000 : name === "factory_worker_wait" ? 25_000 : 10_000;
          const response = await client.callTool({ name, arguments: args }, undefined, { signal, timeout });
          if (response.isError || !Array.isArray(response.content) || response.content.length !== 1 || response.content[0]?.type !== "text"
              || typeof response.content[0].text !== "string" || response.content[0].text.length > 2 * 1024 * 1024) throw new Error();
          return JSON.parse(response.content[0].text);
        } catch { throw new Error("Fixed subscription worker operation was not confirmed."); }
        finally { await client.close().catch(() => {}); }
      },
      pending: (id, signal) => readPendingWorkerApprovals(control, id, signal),
      decide: (id, approval, decision, signal) => decideWorkerApproval(control, id, approval, decision, signal),
    };
  });
}

/** Routing is chosen once before start; after possible delivery, no fallback is attempted. */
export class SubscriptionWorkerPool {
  readonly stateRoot: string;
  private readonly statePath: string;
  private readonly backends: Map<SubscriptionProfile, PoolBackend>;
  private state: PoolState;
  private serial: Promise<void> = Promise.resolve();

  constructor(root: string, backends: PoolBackend[], private readonly now = () => Date.now()) {
    if (backends.length !== 8 || new Set(backends.map(item => item.profile)).size !== 8
        || backends.some(item => !SUBSCRIPTION_PROFILES.includes(item.profile) || !hex(item.identity) || !Number.isInteger(item.weight) || item.weight < 1 || item.weight > 9999)) throw new Error("Eight unique fixed pool backends are required.");
    this.stateRoot = privateDirectory(root); this.statePath = join(this.stateRoot, "pool-state.json");
    this.backends = new Map(backends.map(item => [item.profile, item]));
    const seats = backends.map(({ profile, identity, weight }) => ({ profile, identity, weight }));
    this.state = { version: 1, seats, current: {}, coolUntil: {}, routes: [] };
    if (existsSync(this.statePath)) {
      const value: unknown = JSON.parse(readPoolPrivateFile(this.statePath, 4 * 1024 * 1024));
      if (!object(value) || value.version !== 1 || JSON.stringify(value.seats) !== JSON.stringify(seats) || !object(value.current) || !object(value.coolUntil)
          || !Array.isArray(value.routes) || value.routes.length > 2000) throw new Error("Pool state belongs to another routing configuration.");
      const ids = new Set<string>();
      for (const route of value.routes) {
        if (!object(route) || !validWorker(route.id) || ids.has(route.id) || !hex(route.ownerHash) || !this.backends.has(route.profile as SubscriptionProfile)
            || !["dispatching", "attached", "unknown"].includes(String(route.phase)) || !hex(route.requestDigest)
            || typeof route.createdAt !== "string" || typeof route.updatedAt !== "string"
            || (route.cooldownApplied !== undefined && typeof route.cooldownApplied !== "boolean")
            || (route.phase === "attached" ? !validWorker(route.backendId) : route.backendId !== undefined)) throw new Error("Invalid pool route record.");
        ids.add(route.id);
      }
      for (const [key, counter] of Object.entries(value.current)) if (!this.backends.has(key as SubscriptionProfile) || typeof counter !== "number" || !Number.isSafeInteger(counter)) throw new Error("Invalid pool scheduler state.");
      for (const [key, until] of Object.entries(value.coolUntil)) if (!this.backends.has(key as SubscriptionProfile) || typeof until !== "number" || !Number.isSafeInteger(until) || until < 0) throw new Error("Invalid pool cooldown state.");
      this.state = value as unknown as PoolState;
      // A process stopped after possible delivery: retain uncertainty, never replay the request.
      for (const route of this.state.routes) if (route.phase === "dispatching") { route.phase = "unknown"; route.updatedAt = new Date(this.now()).toISOString(); }
    }
    this.save();
  }

  private save(): void {
    const temporary = join(this.stateRoot, ".pool-state-" + randomBytes(12).toString("hex"));
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state) + "\n"); } finally { closeSync(fd); }
    try { renameSync(temporary, this.statePath); } finally { rmSync(temporary, { force: true }); }
  }

  private scope(value: string): string {
    if (!hex(value)) throw new Error("Invalid private pool scope.");
    return digest(value);
  }
  private route(id: string, scope?: string): PoolRoute {
    if (!validWorker(id)) throw new Error("Invalid worker identifier.");
    const route = this.state.routes.find(item => item.id === id);
    if (!route || (scope !== undefined && route.ownerHash !== this.scope(scope))) throw new Error("Worker does not belong to this connection.");
    return route;
  }
  private unknown(route: PoolRoute): Record<string, unknown> {
    return { id: route.id, state: "unknown", subscriptionProfile: route.profile, createdAt: route.createdAt,
      reason: "Worker start delivery was not confirmed. Do not retry automatically; inspect the assigned fixed-seat service before starting replacement work.",
      cleanupVerified: null, pendingApprovalCount: 0, approvals: [], poolRoute: "pinned" };
  }
  private view(route: PoolRoute, value: unknown): Record<string, unknown> {
    if (!object(value) || value.id !== route.backendId || (value.subscriptionProfile !== undefined && value.subscriptionProfile !== route.profile)) throw new Error("Fixed worker identity did not match its pinned route.");
    const backoff = value.backoff;
    if (!route.cooldownApplied && ["failed", "unknown"].includes(String(value.state)) && object(backoff)
        && ["rate_limit", "usage_limit", "overloaded"].includes(String(backoff.kind))
        && typeof backoff.retryAfterSeconds === "number" && Number.isInteger(backoff.retryAfterSeconds)
        && backoff.retryAfterSeconds >= 1 && backoff.retryAfterSeconds <= 86400) {
      route.cooldownApplied = true;
      const currentTime = this.now();
      const endedAt = typeof value.endedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.endedAt) ? Date.parse(value.endedAt) : NaN;
      // A status first read long after completion must not renew an expired
      // provider cooldown. Unusable or implausibly future timestamps fail safe.
      const anchor = Number.isFinite(endedAt) && endedAt >= 0 && endedAt <= currentTime + 300_000
        && new Date(endedAt).toISOString() === value.endedAt ? Math.min(endedAt, currentTime) : currentTime;
      this.state.coolUntil[route.profile] = Math.max(this.state.coolUntil[route.profile] ?? 0, anchor + backoff.retryAfterSeconds * 1000); this.save();
    }
    return { ...value, id: route.id, subscriptionProfile: route.profile, poolRoute: "pinned" };
  }
  private async select(signal?: AbortSignal): Promise<PoolBackend> {
    const backends = [...this.backends.values()];
    const healthy = await Promise.all(backends.map(async backend => {
      if ((this.state.coolUntil[backend.profile] ?? 0) > this.now()) return false;
      try { return await backend.health(signal); } catch { return false; }
    }));
    const ready = backends.filter((_, index) => healthy[index]);
    if (!ready.length) throw new Error("No healthy pool seat is currently available. No task was dispatched.");
    const total = ready.reduce((sum, item) => sum + item.weight, 0);
    let best = ready[0]!;
    for (const backend of ready) {
      this.state.current[backend.profile] = (this.state.current[backend.profile] ?? 0) + backend.weight;
      if (this.state.current[backend.profile]! > this.state.current[best.profile]!) best = backend;
    }
    this.state.current[best.profile]! -= total;
    return best;
  }
  async start(scope: string, input: PoolWorkerInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const ownerHash = this.scope(scope);
    if (!input || typeof input.repository !== "string" || !isAbsolute(input.repository) || typeof input.task !== "string" || !input.task.trim()
        || input.task.length > 100_000 || !["implement", "investigate", "release-prepare"].includes(input.workflow)) throw new Error("Invalid pooled worker request.");
    // Serialise only admission; independent worker execution is left to the fixed services and shared leases.
    let release!: () => void;
    const previous = this.serial; this.serial = new Promise<void>(resolve => { release = resolve; });
    let route!: PoolRoute, backend!: PoolBackend;
    try {
      await previous;
      if (signal?.aborted) throw new Error("Pool request was cancelled before dispatch.");
      if (this.state.routes.length >= 2000) throw new Error("Pool routing ledger is full; archive it after all owned work is resolved.");
      backend = await this.select(signal);
      const at = new Date(this.now()).toISOString();
      route = { id: "worker-" + randomUUID(), ownerHash, profile: backend.profile, phase: "dispatching", createdAt: at, updatedAt: at,
        requestDigest: digest(JSON.stringify(input)) };
      this.state.routes.push(route); this.save();
    } finally { release(); }
    try {
      const result = await backend.call("factory_worker_start", input as unknown as Record<string, unknown>, signal);
      if (!object(result) || !validWorker(result.id) || (result.subscriptionProfile !== undefined && result.subscriptionProfile !== backend.profile)) throw new Error("Unconfirmed worker identity.");
      if (this.state.routes.some(item => item !== route && item.profile === backend.profile && item.backendId === result.id)) throw new Error("Worker was already routed to another request.");
      route.backendId = result.id; route.phase = "attached"; route.updatedAt = new Date(this.now()).toISOString(); this.save();
      return this.view(route, result);
    } catch {
      // Do not move to a new account, even if the exception was a connection timeout.
      route.phase = "unknown"; delete route.backendId; route.updatedAt = new Date(this.now()).toISOString(); this.save();
      return this.unknown(route);
    }
  }
  async status(scope: string, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const route = this.route(id, scope);
    if (route.phase !== "attached") return this.unknown(route);
    return this.view(route, await this.backends.get(route.profile)!.call("factory_worker_status", { id: route.backendId! }, signal));
  }
  async list(scope: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const owner = this.scope(scope);
    return Promise.all(this.state.routes.filter(route => route.ownerHash === owner).map(async route => {
      try { return await this.status(scope, route.id, signal); }
      catch { return { id: route.id, state: "unknown", subscriptionProfile: route.profile, poolRoute: "pinned", reason: "The assigned fixed-seat service is unavailable. No account switch was attempted." }; }
    }));
  }
  async cancel(scope: string, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const route = this.route(id, scope);
    if (route.phase !== "attached") return this.unknown(route);
    return this.view(route, await this.backends.get(route.profile)!.call("factory_worker_cancel", { id: route.backendId! }, signal));
  }
  async pending(id: string, signal: AbortSignal): Promise<PendingWorkerApproval[]> {
    const route = this.route(id);
    if (route.phase !== "attached") return [];
    return this.backends.get(route.profile)!.pending(route.backendId!, signal);
  }
  async decide(input: { id: string; approvalId: string; actionDigest: string; summary: string; decision: "allow" | "deny" }, signal: AbortSignal): Promise<void> {
    const route = this.route(input.id);
    if (route.phase !== "attached" || !["allow", "deny"].includes(input.decision)) throw new Error("Worker is not ready for a decision.");
    const backend = this.backends.get(route.profile)!, pending = await backend.pending(route.backendId!, signal);
    const approval = pending.find(item => item.id === input.approvalId);
    if (!approval || approvalDigest(approval.input) !== input.actionDigest || approvalSummary(approval) !== input.summary || input.summary.length > 4000) throw new Error("Worker approval changed or is no longer pending.");
    await backend.decide(route.backendId!, approval, input.decision, signal);
  }
}
