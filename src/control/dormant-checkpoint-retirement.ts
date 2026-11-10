import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { NativeGenerationEvidence, SubscriptionProfile } from "../runtime/desktop-jobs.js";
import type { DormantCheckpointRetirement, SessionRecord } from "../sessions/state.js";
import { sameToolInput } from "../sessions/compaction.js";
import { BridgeError, type Json } from "../types.js";
import { recoverySessionActive, relatedRecoveryRecords, type NativeCheckpointRecoveryContext } from "./native-recovery.js";

export interface DormantRetirementContext extends NativeCheckpointRecoveryContext {
  retiredCheckpoint(record: SessionRecord): string;
}
interface RetirementRequest {
  operationId: string;
  bridgeSessionId: string;
  factorySessionId: string;
  sdkSessionId: string;
  account: string;
  factoryCwd: string;
  nativeGeneration: number;
  expectedUpdatedAt: string;
  targetBridgeSessionId: string;
  targetExpectedUpdatedAt: string;
  checkpointSha256?: string;
  evidenceSha256?: string;
  confirmNonResumable: true;
  dryRun: boolean;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["operationId", "bridgeSessionId", "factorySessionId", "sdkSessionId", "account", "factoryCwd", "nativeGeneration",
  "expectedUpdatedAt", "targetBridgeSessionId", "targetExpectedUpdatedAt", "checkpointSha256", "evidenceSha256", "confirmNonResumable", "dryRun"];
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

function parseRequest(input: unknown): RetirementRequest {
  const invalid = (): never => { throw new BridgeError(400, "invalid_control_request", "Exact dormant checkpoint and target identities, record versions and explicit non-resumable confirmation are required."); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !FIELDS.includes(key))) return invalid();
  for (const key of ["operationId", "bridgeSessionId", "factorySessionId", "sdkSessionId", "account", "targetBridgeSessionId"]) {
    if (typeof body[key] !== "string" || !ID.test(body[key] as string)) return invalid();
  }
  for (const key of ["expectedUpdatedAt", "targetExpectedUpdatedAt"]) if (typeof body[key] !== "string" || !Number.isFinite(Date.parse(body[key] as string))) return invalid();
  if (typeof body.factoryCwd !== "string" || !isAbsolute(body.factoryCwd) || body.confirmNonResumable !== true
      || typeof body.nativeGeneration !== "number" || !Number.isSafeInteger(body.nativeGeneration) || body.nativeGeneration < 1 || body.nativeGeneration > 1_000_000
      || body.dryRun !== undefined && typeof body.dryRun !== "boolean") return invalid();
  for (const key of ["checkpointSha256", "evidenceSha256"]) {
    if ((body[key] !== undefined || body.dryRun !== true) && (typeof body[key] !== "string" || !HASH.test(body[key] as string))) return invalid();
  }
  return { ...body, dryRun: body.dryRun === true } as unknown as RetirementRequest;
}

/** Explicitly retire one unused successor. Its history and checkpoint remain preserved. */
export async function retireDormantCheckpoint(context: DormantRetirementContext, input: unknown): Promise<Record<string, Json>> {
  const request = parseRequest(input);
  const prior = priorRetirement(context, request);
  if (prior) return prior;
  const record = eligibleRecord(context, request);
  const before = structuredClone(record);
  const target = context.store.require(request.targetBridgeSessionId);
  const snapshot = JSON.stringify(relatedRecoveryRecords(context.store, request.factorySessionId));
  const checkpointSha256 = context.retiredCheckpoint(record);
  if (request.checkpointSha256 !== undefined && request.checkpointSha256 !== checkpointSha256) refuse("checkpoint_digest_mismatch");
  const evidence = await inspectLineage(context, record);
  const evidenceSha256 = digest(evidence);
  if (request.evidenceSha256 !== undefined && request.evidenceSha256 !== evidenceSha256) refuse("lease_evidence_changed");
  const checkedAgain = await inspectLineage(context, record);
  const repeated = priorRetirement(context, request);
  if (repeated) return repeated;
  eligibleRecord(context, request);
  if (JSON.stringify(relatedRecoveryRecords(context.store, request.factorySessionId)) !== snapshot
      || !sameToolInput(evidence, checkedAgain) || context.retiredCheckpoint(record) !== checkpointSha256) refuse("changed_during_retirement");
  if (request.dryRun) return { ok: true, eligible: true, retired: false, bridgeSessionId: request.bridgeSessionId,
    targetBridgeSessionId: request.targetBridgeSessionId, operationId: request.operationId, checkpointSha256, evidenceSha256 };
  const at = (context.now?.() ?? new Date()).toISOString();
  const audit: DormantCheckpointRetirement = { operationId: request.operationId, at, before,
    targetBridgeSessionId: request.targetBridgeSessionId, targetCreatedAt: target.createdAt, targetRecordUpdatedAt: request.targetExpectedUpdatedAt,
    checkpointSha256, evidenceSha256, evidence };
  if (Buffer.byteLength(JSON.stringify(audit)) > 16 * 1024 * 1024) refuse("retirement_audit_full");
  context.store.updateAtomic(request.bridgeSessionId, { ...terminalPatch(audit), dormantCheckpointRetirement: audit });
  return { ok: true, retired: true, bridgeSessionId: request.bridgeSessionId, targetBridgeSessionId: request.targetBridgeSessionId,
    operationId: request.operationId, nativeGeneration: request.nativeGeneration };
}

function priorRetirement(context: DormantRetirementContext, request: RetirementRequest): Promise<Record<string, Json>> | undefined {
  const existing = context.store.get(request.bridgeSessionId)?.dormantCheckpointRetirement;
  if (!existing) return;
  if (!sameRequest(existing, request)) refuse("operation_identity_mismatch");
  return inspectRetiredSibling(context, context.store.require(request.bridgeSessionId), request.targetBridgeSessionId).then(() =>
    ({ ok: true, retired: false, alreadyRetired: true, bridgeSessionId: request.bridgeSessionId, operationId: request.operationId }));
}

function eligibleRecord(context: DormantRetirementContext, request: RetirementRequest): SessionRecord {
  const record = context.store.get(request.bridgeSessionId), target = context.store.get(request.targetBridgeSessionId);
  if (!record || !target || record === target) refuse("session_identity_unproven");
  if (record.factorySessionId !== request.factorySessionId || target.factorySessionId !== request.factorySessionId
      || record.sdkSessionId !== request.sdkSessionId || record.claudeAccount !== request.account || !context.accounts.includes(request.account)
      || record.factoryCwd !== request.factoryCwd || target.factoryCwd !== request.factoryCwd || record.nativeGeneration !== request.nativeGeneration
      || record.updatedAt !== request.expectedUpdatedAt || target.updatedAt !== request.targetExpectedUpdatedAt) refuse("record_identity_changed");
  if (record.state !== "IDLE" || record.cancelRequested || record.cancellation || record.hostEnded !== undefined || record.provider === "cursor"
      || record.pendingToolIds.length || record.endedToolIds?.length || record.hostCompletionReceipts?.length || record.pendingHostRecovery
      || record.dormantCheckpointRetirement || !record.historyMessageHashes?.length) refuse("not_dormant");
  if (target.state !== "IDLE" || target.sdkSessionId !== undefined || target.retryableRequestKind !== "upstream"
      || !target.historyMessageHashes?.length || target.cancelRequested || target.cancellation || target.hostEnded !== undefined
      || target.pendingToolIds.length || target.endedToolIds?.length || target.pendingHostRecovery
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(target.createdAt))
      || Date.parse(record.createdAt) >= Date.parse(target.createdAt) || Date.parse(record.updatedAt) > Date.parse(target.createdAt)) refuse("target_identity_unproven");
  if (relatedRecoveryRecords(context.store, request.factorySessionId).some(item => recoverySessionActive(context, item.bridgeSessionId))) refuse("session_active");
  return record;
}

/** The exception is an exact, terminal audited disposition, revalidated for this target. */
export async function inspectRetiredSibling(context: NativeCheckpointRecoveryContext, record: SessionRecord, targetBridgeSessionId?: string): Promise<void> {
  const audit = record.dormantCheckpointRetirement;
  const target = targetBridgeSessionId && context.store.get(targetBridgeSessionId);
  if (!audit || !target || !context.retiredCheckpoint || target.bridgeSessionId !== audit.targetBridgeSessionId
      || target.createdAt !== audit.targetCreatedAt || target.factorySessionId !== record.factorySessionId || target.factoryCwd !== record.factoryCwd
      || record.bridgeSessionId !== audit.before.bridgeSessionId || record.factorySessionId !== audit.before.factorySessionId
      || !Number.isFinite(Date.parse(audit.at)) || !sameToolInput(context.store.get(record.bridgeSessionId), record)
      || recoverySessionActive(context, record.bridgeSessionId)) refuse("retirement_proof_unavailable");
  const { updatedAt: _updated, dormantCheckpointRetirement: _audit, ...current } = record;
  const { updatedAt: _beforeUpdated, ...original } = audit.before;
  if (!sameToolInput(current, { ...original, ...terminalPatch(audit) }) || !HASH.test(audit.checkpointSha256)
      || digest(audit.evidence) !== audit.evidenceSha256) refuse("retirement_record_changed");
  const observed = JSON.stringify(record);
  const targetIdentity = JSON.stringify([target.bridgeSessionId, target.createdAt, target.factorySessionId, target.factoryCwd]);
  const evidence = await inspectLineage(context, record);
  if (!sameToolInput(evidence, audit.evidence) || context.retiredCheckpoint(record) !== audit.checkpointSha256
      || JSON.stringify(context.store.get(record.bridgeSessionId)) !== observed || recoverySessionActive(context, record.bridgeSessionId)
      || JSON.stringify([target.bridgeSessionId, target.createdAt, target.factorySessionId, target.factoryCwd]) !== targetIdentity) refuse("retirement_proof_changed");
}

function sameRequest(audit: DormantCheckpointRetirement, request: RetirementRequest): boolean {
  const old = audit.before;
  return audit.operationId === request.operationId && old.bridgeSessionId === request.bridgeSessionId
    && old.factorySessionId === request.factorySessionId && old.sdkSessionId === request.sdkSessionId && old.claudeAccount === request.account
    && old.factoryCwd === request.factoryCwd && old.nativeGeneration === request.nativeGeneration && old.updatedAt === request.expectedUpdatedAt
    && audit.targetBridgeSessionId === request.targetBridgeSessionId && audit.targetRecordUpdatedAt === request.targetExpectedUpdatedAt
    && (request.checkpointSha256 === undefined || request.checkpointSha256 === audit.checkpointSha256)
    && (request.evidenceSha256 === undefined || request.evidenceSha256 === audit.evidenceSha256);
}

function terminalPatch(audit: DormantCheckpointRetirement): Pick<SessionRecord, "state" | "cancelRequested" | "hostEnded" | "cancellation" | "notes"> {
  return { state: "CANCELLED", cancelRequested: true, hostEnded: "interrupted", cancellation: { at: audit.at, source: "admin" },
    notes: [...audit.before.notes, `dormant-checkpoint-retired:${audit.operationId}`].slice(-128) };
}

async function inspectLineage(context: NativeCheckpointRecoveryContext, record: SessionRecord): Promise<NativeGenerationEvidence[]> {
  const generation = record.nativeGeneration!;
  const evidence = await context.inspect({ factorySessionId: record.factorySessionId!, bridgeSessionId: `${record.bridgeSessionId}:g${generation}`,
    cwd: record.factoryCwd!, subscriptionProfile: record.claudeAccount as SubscriptionProfile, useRecordedWorkspacePolicy: true, sdkSessionId: record.sdkSessionId! });
  const previous = evidence.filter(item => item.generation === generation - 1);
  if (previous.length !== 1 || !previous[0]!.checkpointMatches || !evidence.length
      || new Set(evidence.map(item => item.generation)).size !== evidence.length
      || evidence.some(item => !item.bindingMatches || !Number.isSafeInteger(item.generation) || item.generation < 0 || item.generation >= generation)) refuse("unused_successor_unproven");
  if (evidence.some(item => !TERMINAL.includes(item.state) || !item.cleanupVerified || item.externalCleanupRequired
      || item.hostActionReservation || item.ownerAlive || item.supervisorAlive)) refuse("lease_unsettled");
  if (evidence.some(item => !Number.isFinite(Date.parse(item.endedAt ?? ""))
      || Date.parse(item.endedAt!) > Date.parse(record.dormantCheckpointRetirement?.before.updatedAt ?? record.updatedAt))) refuse("lease_time_unproven");
  return evidence.sort((a, b) => a.generation - b.generation);
}

function digest(evidence: NativeGenerationEvidence[]): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
function refuse(reason: string): never {
  throw new BridgeError(409, "dormant_retirement_refused", "The dormant checkpoint retirement could not be verified.", { reason });
}
