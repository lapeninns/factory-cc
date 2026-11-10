import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { NativeGenerationEvidence, SubscriptionProfile } from "../runtime/desktop-jobs.js";
import type { RetainedCheckpoint, SessionRecord, UpstreamCheckpointRecovery } from "../sessions/state.js";
import { BridgeError, type Json } from "../types.js";
import { inspectRecoverySiblings, relatedRecoveryRecords, verifyRecoverySessionInactive, type NativeCheckpointRecoveryContext } from "./native-recovery.js";

interface LogEvent { at: string; event: string; data: Record<string, unknown> }
export interface UpstreamFailureEvidence { sha256: string; failedAt: string; coolingUntil: string }
export interface UpstreamRecoveryContext extends NativeCheckpointRecoveryContext {
  checkpoint(record: SessionRecord): string;
  evidence(record: SessionRecord, sdkSessionId: string, sourceGeneration: number): UpstreamFailureEvidence;
  restoreCooldown(account: string, until: string): void;
}
interface RecoveryRequest {
  operationId: string;
  bridgeSessionId: string;
  factorySessionId: string;
  account: string;
  sdkSessionId: string;
  nativeGeneration: number;
  expectedUpdatedAt: string;
  checkpointSha256?: string;
  evidenceSha256?: string;
  dryRun: boolean;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["operationId", "bridgeSessionId", "factorySessionId", "account", "sdkSessionId", "nativeGeneration", "expectedUpdatedAt", "checkpointSha256", "evidenceSha256", "dryRun"];

function parseRequest(input: unknown): RecoveryRequest {
  const invalid = (): never => { throw new BridgeError(400, "invalid_control_request", "Explicit upstream checkpoint recovery identity and record version are required. Apply also requires both evidence hashes."); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !FIELDS.includes(key))) return invalid();
  for (const key of ["operationId", "bridgeSessionId", "factorySessionId", "account", "sdkSessionId"]) {
    if (typeof body[key] !== "string" || !ID.test(body[key] as string)) return invalid();
  }
  if (typeof body.nativeGeneration !== "number" || !Number.isSafeInteger(body.nativeGeneration) || body.nativeGeneration < 1 || body.nativeGeneration > 1_000_000
      || typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))
      || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) return invalid();
  for (const key of ["checkpointSha256", "evidenceSha256"]) {
    if ((body[key] !== undefined || body.dryRun !== true) && (typeof body[key] !== "string" || !HASH.test(body[key] as string))) return invalid();
  }
  return { ...body, dryRun: body.dryRun === true } as unknown as RecoveryRequest;
}

export async function restoreUpstreamCheckpoint(context: UpstreamRecoveryContext, input: unknown): Promise<Record<string, Json>> {
  const request = parseRequest(input);
  const prior = priorRecovery(context, request);
  if (prior) return prior;
  const record = eligibleRecord(context, request);
  const related = structuredClone(relatedRecoveryRecords(context.store, request.factorySessionId));
  const snapshot = JSON.stringify(related);
  const sourceGeneration = request.nativeGeneration - 1;
  const evidence = context.evidence(record, request.sdkSessionId, sourceGeneration);
  const checkpointRecord = { ...record, sdkSessionId: request.sdkSessionId };
  const checkpointSha256 = context.checkpoint(checkpointRecord);
  if (request.checkpointSha256 !== undefined && request.checkpointSha256 !== checkpointSha256) refuse("checkpoint_digest_mismatch");
  if (request.evidenceSha256 !== undefined && request.evidenceSha256 !== evidence.sha256) refuse("upstream_evidence_changed");
  const leases = await context.inspect({ factorySessionId: request.factorySessionId, bridgeSessionId: `${request.bridgeSessionId}:g${sourceGeneration}`,
    cwd: record.factoryCwd!, subscriptionProfile: request.account as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: request.sdkSessionId });
  verifySettledSource(leases, sourceGeneration, true, evidence.failedAt, request.expectedUpdatedAt);
  await inspectRecoverySiblings(context, request.factorySessionId, related.filter(item => item.bridgeSessionId !== request.bridgeSessionId));
  const checkedAgain = await context.inspect({ factorySessionId: request.factorySessionId, bridgeSessionId: `${request.bridgeSessionId}:g${sourceGeneration}`,
    cwd: record.factoryCwd!, subscriptionProfile: request.account as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: request.sdkSessionId });
  if (JSON.stringify(checkedAgain) !== JSON.stringify(leases)) refuse("lease_changed_during_recovery");
  const repeated = priorRecovery(context, request);
  if (repeated) return repeated;
  const current = eligibleRecord(context, request);
  if (JSON.stringify(relatedRecoveryRecords(context.store, request.factorySessionId)) !== snapshot
      || context.checkpoint({ ...current, sdkSessionId: request.sdkSessionId }) !== checkpointSha256
      || context.evidence(current, request.sdkSessionId, sourceGeneration).sha256 !== evidence.sha256) refuse("changed_during_recovery");
  if (request.dryRun) return { ok: true, eligible: true, recovered: false, operationId: request.operationId, bridgeSessionId: request.bridgeSessionId,
    nativeGeneration: request.nativeGeneration, checkpointSha256, evidenceSha256: evidence.sha256, coolingUntil: evidence.coolingUntil };
  const at = (context.now?.() ?? new Date()).toISOString();
  const proof: RetainedCheckpoint = { sdkSessionId: request.sdkSessionId, account: request.account, checkpointSha256,
    sourceGeneration, preparedAt: at, coolingUntil: evidence.coolingUntil, origin: "operator-restored" };
  const audit: UpstreamCheckpointRecovery = { operationId: request.operationId, at, recordUpdatedAt: request.expectedUpdatedAt,
    nativeGeneration: request.nativeGeneration, proof, evidenceSha256: evidence.sha256,
    before: { sdkSessionId: current.sdkSessionId, retryableRequestKind: current.retryableRequestKind,
      retryableRequestHash: current.retryableRequestHash, accountCooldowns: current.accountCooldowns ? structuredClone(current.accountCooldowns) : undefined } };
  context.store.update(request.bridgeSessionId, { sdkSessionId: request.sdkSessionId, retryableRequestKind: "native-upstream", retainedCheckpoint: proof, checkpointRetryBlocked: undefined,
    accountCooldowns: extendCooldowns(current.accountCooldowns, request.account, evidence.coolingUntil),
    upstreamCheckpointRecoveries: [...(current.upstreamCheckpointRecoveries ?? []), audit],
    notes: [...current.notes, `upstream-checkpoint-restored:${request.operationId}`] });
  context.restoreCooldown(request.account, evidence.coolingUntil);
  return { ok: true, recovered: true, operationId: request.operationId, bridgeSessionId: request.bridgeSessionId,
    nativeGeneration: request.nativeGeneration, coolingUntil: evidence.coolingUntil };
}

function priorRecovery(context: UpstreamRecoveryContext, request: RecoveryRequest): Record<string, Json> | undefined {
  const record = context.store.get(request.bridgeSessionId);
  const audit = record?.upstreamCheckpointRecoveries?.find(item => item.operationId === request.operationId);
  if (!record || !audit) return;
  if (record.factorySessionId !== request.factorySessionId || record.claudeAccount !== request.account || audit.proof.sdkSessionId !== request.sdkSessionId
      || audit.recordUpdatedAt !== request.expectedUpdatedAt || audit.nativeGeneration !== request.nativeGeneration
      || request.checkpointSha256 !== undefined && request.checkpointSha256 !== audit.proof.checkpointSha256
      || request.evidenceSha256 !== undefined && request.evidenceSha256 !== audit.evidenceSha256) refuse("operation_identity_mismatch");
  if (record.sdkSessionId !== request.sdkSessionId || record.cancelRequested || record.state === "FAILED" || record.state === "CANCELLED"
      || record.hostEnded === "terminal" || record.hostEnded === "interrupted") refuse("recovery_no_longer_active");
  return { ok: true, alreadyRecovered: true, recovered: false, operationId: request.operationId,
    bridgeSessionId: request.bridgeSessionId, nativeGeneration: record.nativeGeneration ?? null };
}

function eligibleRecord(context: UpstreamRecoveryContext, request: RecoveryRequest): SessionRecord {
  const record = context.store.get(request.bridgeSessionId);
  if (!record) refuse("session_not_found");
  if (record.factorySessionId !== request.factorySessionId) refuse("factory_session_mismatch");
  if (record.claudeAccount !== request.account || !context.accounts.includes(request.account)) refuse("account_mismatch");
  if (record.nativeGeneration !== request.nativeGeneration) refuse("generation_mismatch");
  if (record.updatedAt !== request.expectedUpdatedAt) refuse("record_changed");
  if (record.state !== "IDLE" || record.sdkSessionId !== undefined || record.retryableRequestKind !== "upstream"
      || !record.retryableRequestHash || !HASH.test(record.retryableRequestHash)) refuse("not_clean_upstream_retry");
  if (record.cancelRequested || record.cancellation || record.hostEnded !== undefined || record.pendingToolIds.length
      || record.endedToolIds?.length || record.hostCompletionReceipts?.length || record.pendingHostRecovery) refuse("unresolved_or_ended_session");
  if (!record.factoryCwd || record.provider === "cursor" || !record.historyMessageHashes?.length) refuse("checkpoint_identity_unproven");
  if (!record.completedHostRecoveries?.some(item => item.sdkSessionId === request.sdkSessionId && item.reconciledAt)) refuse("checkpoint_audit_missing");
  if ((record.upstreamCheckpointRecoveries?.length ?? 0) >= 32) refuse("recovery_audit_full");
  if (context.store.list().some(other => other.bridgeSessionId !== record.bridgeSessionId && other.sdkSessionId === request.sdkSessionId)) refuse("duplicate_checkpoint_lineage");
  verifyRecoverySessionInactive(context, record);
  return record;
}

/** A purpose-built proof can survive disposal of its in-memory SDK object. */
export async function verifyRetainedHostCheckpoint(context: UpstreamRecoveryContext, record: SessionRecord): Promise<boolean> {
  const proof = record.retainedCheckpoint;
  if (!proof || record.state !== "IDLE" || record.checkpointRetryBlocked || record.cancelRequested || record.cancellation || record.hostEnded !== undefined
      || record.retryableRequestKind !== "native-upstream" || !["clean-upstream", "operator-restored"].includes(proof.origin)
      || record.pendingToolIds.length || record.endedToolIds?.length || record.hostCompletionReceipts?.length || record.pendingHostRecovery
      || record.sdkSessionId !== proof.sdkSessionId || record.claudeAccount !== proof.account || !context.accounts.includes(proof.account)
      || !record.factorySessionId || !record.factoryCwd || !Number.isSafeInteger(record.nativeGeneration)
      || !Number.isSafeInteger(proof.sourceGeneration) || proof.sourceGeneration < 0
      || record.nativeGeneration! <= proof.sourceGeneration || !HASH.test(proof.checkpointSha256)
      || !Number.isFinite(Date.parse(proof.preparedAt))) return false;
  const before = JSON.stringify(record);
  const related = JSON.stringify(relatedRecoveryRecords(context.store, record.factorySessionId));
  verifyRecoverySessionInactive(context, record);
  if (context.checkpoint(record) !== proof.checkpointSha256) return false;
  const leases = await context.inspect({ factorySessionId: record.factorySessionId,
    bridgeSessionId: `${record.bridgeSessionId}:g${proof.sourceGeneration}`, cwd: record.factoryCwd,
    subscriptionProfile: proof.account as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: proof.sdkSessionId });
  verifySettledSource(leases, proof.sourceGeneration, false, undefined, proof.preparedAt);
  await inspectRecoverySiblings(context, record.factorySessionId,
    relatedRecoveryRecords(context.store, record.factorySessionId).filter(item => item.bridgeSessionId !== record.bridgeSessionId).map(item => structuredClone(item)));
  const checkedAgain = await context.inspect({ factorySessionId: record.factorySessionId,
    bridgeSessionId: `${record.bridgeSessionId}:g${proof.sourceGeneration}`, cwd: record.factoryCwd,
    subscriptionProfile: proof.account as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: proof.sdkSessionId });
  verifyRecoverySessionInactive(context, record);
  return JSON.stringify(record) === before && JSON.stringify(relatedRecoveryRecords(context.store, record.factorySessionId)) === related
    && JSON.stringify(checkedAgain) === JSON.stringify(leases) && context.checkpoint(record) === proof.checkpointSha256;
}

function verifySettledSource(evidence: NativeGenerationEvidence[], generation: number, requireDeadOwners: boolean, failedAt?: string, updatedAt?: string): void {
  const source = evidence.filter(item => item.generation === generation);
  if (source.length !== 1 || source[0]!.checkpointMatches !== true || evidence.some(item => !item.bindingMatches || item.generation > generation)) refuse("lease_identity_unproven");
  if (source[0]!.state !== "failed" || source[0]!.endedBy !== "session_update") refuse("source_lease_not_failed");
  if (evidence.some(item => !["failed", "cancelled", "completed", "interrupted"].includes(item.state)
      || !item.cleanupVerified || item.externalCleanupRequired || item.hostActionReservation
      || requireDeadOwners && (item.ownerAlive || item.supervisorAlive))) refuse("lease_unsettled");
  const ended = Date.parse(source[0]!.endedAt ?? "");
  if (!Number.isFinite(ended) || failedAt && ended < Date.parse(failedAt) || updatedAt && ended > Date.parse(updatedAt)) refuse("lease_time_mismatch");
}

export function extendCooldowns(previous: Record<string, string> | undefined, account: string, until: string): Record<string, string> {
  return { ...previous, [account]: Date.parse(previous?.[account] ?? "") > Date.parse(until) ? previous![account]! : until };
}

export function persistedCooldowns(logDir: string, members: readonly string[], records: readonly SessionRecord[]): Record<string, string> {
  let result: Record<string, string> = {};
  for (const row of records) for (const [account, until] of Object.entries(row.accountCooldowns ?? {})) {
    if (!members.includes(account)) continue;
    if (typeof until !== "string" || !Number.isFinite(Date.parse(until))) refuse("cooldown_metadata_unavailable");
    result = extendCooldowns(result, account, until);
  }
  for (const row of readLogs(logDir)) {
    const cooling = coolingEvent(row);
    if (cooling && members.includes(cooling.account)) result = extendCooldowns(result, cooling.account, cooling.until);
  }
  return result;
}

export function readUpstreamFailureEvidence(logDir: string, record: SessionRecord, sdkSessionId: string, sourceGeneration: number,
  records: readonly SessionRecord[] = [record]): UpstreamFailureEvidence {
  const rows = readLogs(logDir);
  const failures = rows.filter(row => row.event === "sdk_session_failed" && row.data.sessionId === record.bridgeSessionId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const failure = failures[0];
  if (failure && failures.some(row => row.at === failure.at && JSON.stringify(row) !== JSON.stringify(failure))) refuse("upstream_failure_ambiguous");
  if (!failure || failure.data.sdkSessionId !== sdkSessionId || failure.data.nativeGeneration !== sourceGeneration
      || failure.data.code !== "rate_limit_error" || failure.data.status !== 429 || failure.data.retryFromHistory !== true
      || Date.parse(failure.at) > Date.parse(record.updatedAt)) refuse("upstream_failure_unproven");
  const matching = rows.filter(row => row.event === "claude_account_cooling" && row.data.sessionId === record.bridgeSessionId
      && row.data.account === record.claudeAccount && Date.parse(row.at) >= Date.parse(failure.at) && Date.parse(row.at) <= Date.parse(record.updatedAt))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const cooling = matching[0], parsed = cooling && coolingEvent(cooling);
  if (!parsed) refuse("upstream_cooldown_unproven");
  const until = persistedCooldowns(logDir, [record.claudeAccount!], records)[record.claudeAccount!] ?? parsed.until;
  const evidence = { failure, cooling, coolingUntil: until };
  return { sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), failedAt: failure.at, coolingUntil: until };
}

function coolingEvent(row: LogEvent): { account: string; until: string } | undefined {
  const seconds = row.data.seconds;
  if (row.event !== "claude_account_cooling" || typeof row.data.account !== "string" || typeof seconds !== "number"
      || !Number.isFinite(seconds) || seconds <= 0 || seconds > 31 * 24 * 3600) return;
  return { account: row.data.account, until: new Date(Date.parse(row.at) + seconds * 1000).toISOString() };
}

/** Only fixed files in the configured, owned log directory are inspected. */
function readLogs(logDir: string): LogEvent[] {
  let directory: string;
  try { directory = realpathSync(logDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; return refuse("log_evidence_unavailable"); }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) refuse("log_evidence_unavailable");
  const rows: LogEvent[] = [];
  for (const name of ["bridge.jsonl.1", "bridge.jsonl"]) {
    let fd: number | undefined;
    try {
      fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022) refuse("log_evidence_unavailable");
      const length = Math.min(info.size, 16 * 1024 * 1024), buffer = Buffer.allocUnsafe(length);
      const bytes = readSync(fd, buffer, 0, length, info.size - length);
      const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
      if (length < info.size) lines.shift();
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as LogEvent;
          if (row && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) && typeof row.event === "string"
              && row.data && typeof row.data === "object" && !Array.isArray(row.data)) rows.push(row);
        } catch { if (line.trim()) refuse("log_evidence_unavailable"); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse("log_evidence_unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return rows;
}

function refuse(reason: string): never {
  throw new BridgeError(409, "upstream_checkpoint_recovery_refused", "The upstream checkpoint was not restored. No change was made.", { reason });
}
