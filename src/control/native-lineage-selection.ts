import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { BridgeError, type Json } from "../types.js";
import type { NativeGenerationEvidence, SubscriptionProfile } from "../runtime/desktop-jobs.js";
import { lineageReconciliationContext, MAX_LINEAGE_CONTEXT_BYTES } from "../runtime/host-recovery.js";
import { sameToolInput } from "../sessions/compaction.js";
import { isEnded, type LineageCancellation, type NativeLineageHistoricalDisposition, type NativeLineageBranchProof, type NativeLineageCheckpoint, type NativeLineageSelection, type SessionRecord } from "../sessions/state.js";
import { recoverySessionActive, type NativeCheckpointRecoveryContext } from "./native-recovery.js";

interface Identity { bridgeSessionId: string; sdkSessionId: string; account: string; nativeGeneration: number; expectedUpdatedAt: string }
interface SelectionRequest {
  operationId: string;
  factorySessionId: string;
  factoryCwd: string;
  selected: Identity;
  sources: Identity[];
  proofSha256?: string;
  approval?: NativeLineageSelection["approval"];
  historicalDispositions?: NativeLineageHistoricalDisposition[];
  dryRun: boolean;
}
export interface NativeLineageSelectionContext extends NativeCheckpointRecoveryContext {
  lineageCheckpoint(record: SessionRecord): NativeLineageCheckpoint;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];
export function lineageDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Explicitly requested before admin cancellation. The first pre-cancel version is retained. */
export function lineageCancellationSnapshot(record: SessionRecord): LineageCancellation {
  const { bridgeSessionId, factorySessionId, factoryCwd, sdkSessionId, claudeAccount, nativeGeneration, provider,
    controllerWorkspacePolicy, contextHash, state, cancelRequested, cancellation, hostEnded, pendingToolIds,
    endedToolIds, hostCompletionReceipts, updatedAt } = record;
  return structuredClone({ before: { bridgeSessionId, factorySessionId, factoryCwd, sdkSessionId, claudeAccount,
    nativeGeneration, provider, controllerWorkspacePolicy, contextHash, state, cancelRequested, cancellation,
    hostEnded, pendingToolIds, endedToolIds, hostCompletionReceipts, updatedAt },
    historySha256: lineageDigest([record.historyMessageHashes, record.requestMessageHashes]) });
}

/** Source records remain immutable; this one owner audit is the routing authority. */
export async function selectNativeLineage(context: NativeLineageSelectionContext, input: unknown): Promise<Record<string, Json>> {
  const request = parse(input);
  const requestSha256 = lineageDigest({ ...request, dryRun: false });
  const prior = priorSelection(context, request, requestSha256);
  if (prior) return prior;
  const selected = eligible(context, request);
  const scope = selectionScope(context.store.list(), selected);
  const inventory = scopeInventory(context.store.list(), selected);
  if (inventory.length > 64) refuse("scope_too_large");
  const snapshot = JSON.stringify(inventory);
  const historical: NativeLineageSelection["historical"] = [];
  const inactive: NativeLineageSelection["inactive"] = [];
  for (const record of context.store.list().filter(record => inventory.some(item => item.bridgeSessionId === record.bridgeSessionId) && !record.sdkSessionId)) {
    inactive.push({ record: structuredClone(record), evidence: await inspect(context, record, true) });
  }
  const proofs: NativeLineageBranchProof[] = [];
  const selectedCheckpoint = context.lineageCheckpoint(selected);
  const requiredDispositions: Array<Omit<NativeLineageHistoricalDisposition, "approvalReference" | "approvedAt">> = [];
  for (const record of scope) {
    const checkpoint = context.lineageCheckpoint(record);
    const evidence = await inspect(context, record);
    if (isHistorical(record, selected)) {
      if (evidence.some(item => Date.parse(item.endedAt!) >= Date.parse(selected.createdAt))) refuse("historical_lease_after_baseline");
      const outcomesSha256 = lineageDigest(checkpoint.outcomes);
      const requiresDisposition = checkpoint.outcomes.some(outcome => !selectedCheckpoint.outcomes.some(known => sameToolInput(known, outcome)));
      const expected = { bridgeSessionId: record.bridgeSessionId, sdkSessionId: record.sdkSessionId!, checkpointSha256: checkpoint.checkpointSha256,
        outcomesSha256, selected: request.selected, disposition: "archive-superseded" as const };
      if (requiresDisposition) requiredDispositions.push(expected);
      const disposition = request.historicalDispositions?.find(item => item.bridgeSessionId === record.bridgeSessionId);
      if (disposition && (!requiresDisposition || !sameToolInput({ ...disposition, approvalReference: undefined, approvedAt: undefined }, expected))) refuse("historical_disposition_changed");
      historical.push({ record: structuredClone(record), checkpointSha256: checkpoint.checkpointSha256, outcomesSha256, evidence,
        ...(disposition ? { disposition } : {}) });
    }
    else proofs.push({ record: structuredClone(record), checkpoint, evidence });
  }
  const chosen = proofs.find(item => item.record.bridgeSessionId === selected.bridgeSessionId)!;
  const sources = proofs.filter(item => item !== chosen);
  if (request.historicalDispositions?.some(item => !requiredDispositions.some(expected => expected.bridgeSessionId === item.bridgeSessionId))) refuse("historical_disposition_changed");
  const dispositionMissing = requiredDispositions.some(expected => !request.historicalDispositions?.some(item => item.bridgeSessionId === expected.bridgeSessionId));
  if (dispositionMissing && !request.dryRun) refuse("historical_outcome_unreconciled");
  const proofSha256 = lineageDigest({ proofs, historical: historical.map(({ disposition: _disposition, ...proof }) => proof), inactive, inventory });
  if (request.proofSha256 !== undefined && request.proofSha256 !== proofSha256) refuse("proof_changed");
  const audit: NativeLineageSelection = { operationId: request.operationId, at: (context.now?.() ?? new Date()).toISOString(),
    requestSha256, proofSha256, approval: request.approval!, selected: chosen, sources, historical, inactive, scopeInventory: inventory };
  if (Buffer.byteLength(lineageReconciliationContext(audit)) > MAX_LINEAGE_CONTEXT_BYTES
      || Buffer.byteLength(JSON.stringify(audit)) > 16 * 1024 * 1024) refuse("reconciliation_context_too_large");
  for (const proof of proofs) {
    if (!sameToolInput(await inspect(context, proof.record), proof.evidence)
        || !sameToolInput(context.lineageCheckpoint(proof.record), proof.checkpoint)) refuse("proof_changed");
  }
  for (const proof of historical) {
    const checkpoint = context.lineageCheckpoint(proof.record);
    if (!sameToolInput(await inspect(context, proof.record), proof.evidence) || checkpoint.checkpointSha256 !== proof.checkpointSha256
        || lineageDigest(checkpoint.outcomes) !== proof.outcomesSha256) refuse("proof_changed");
  }
  for (const proof of inactive) if (!sameToolInput(await inspect(context, proof.record, true), proof.evidence)) refuse("proof_changed");
  const repeated = priorSelection(context, request, requestSha256);
  if (repeated) return repeated;
  eligible(context, request);
  if (JSON.stringify(scopeInventory(context.store.list(), selected)) !== snapshot) refuse("scope_changed");
  if (request.dryRun) return { ok: true, eligible: !dispositionMissing, selected: false, proofSha256,
    requiresHistoricalDisposition: dispositionMissing, requiredHistoricalDispositions: requiredDispositions,
    sourceBridgeSessionIds: sources.map(source => source.record.bridgeSessionId),
    historicalBridgeSessionIds: historical.map(source => source.record.bridgeSessionId), scopeInventory: inventory };
  context.store.updateAtomic(selected.bridgeSessionId, { nativeLineageSelection: audit,
    pendingLineageReconciliation: request.operationId,
    nativeGeneration: selected.nativeGeneration! + 1,
    notes: [...selected.notes, `native-lineage-selected:${request.operationId}`].slice(-128) });
  return { ok: true, selected: true, operationId: request.operationId, bridgeSessionId: selected.bridgeSessionId };
}

function priorSelection(context: NativeLineageSelectionContext, request: SelectionRequest, requestSha256: string): Promise<Record<string, Json>> | undefined {
  const owner = context.store.get(request.selected.bridgeSessionId);
  const prior = owner?.nativeLineageSelection;
  if (!owner || !prior) return;
  if (prior.requestSha256 !== requestSha256 || owner.cancelRequested || isEnded(owner)) refuse("operation_identity_changed");
  return verifySelectedLineage(context, owner).then(() => ({ ok: true, selected: false, alreadySelected: true, operationId: prior.operationId }));
}

/** Exact archived source records are excluded only by their selected owner's durable audit. */
export function selectedLineageSources(records: SessionRecord[], owner: SessionRecord): Set<string> {
  const audit = owner.nativeLineageSelection;
  if (!audit) return new Set();
  const original = audit.selected.record;
  if (owner.sdkSessionId !== original.sdkSessionId || owner.claudeAccount !== original.claudeAccount
      || owner.factorySessionId !== original.factorySessionId || owner.factoryCwd !== original.factoryCwd
      || owner.contextHash !== original.contextHash || owner.model !== original.model || owner.role !== original.role
      || !Number.isSafeInteger(owner.nativeGeneration) || owner.nativeGeneration! > 1_000_000
      || owner.nativeGeneration! <= original.nativeGeneration! || owner.cancelRequested || isEnded(owner)) refuse("selected_owner_changed");
  const inventory = scopeInventory(records, owner);
  if (inventory.length !== audit.scopeInventory.length || inventory.some(item => item.bridgeSessionId !== owner.bridgeSessionId
      && !audit.scopeInventory.some(prior => sameToolInput(prior, item)))
      || !inventory.some(item => item.bridgeSessionId === owner.bridgeSessionId)) refuse("scope_changed");
  for (const source of audit.sources) {
    const current = records.find(record => record.bridgeSessionId === source.record.bridgeSessionId);
    if (!sameToolInput(current, source.record)) refuse("source_record_changed");
  }
  return new Set(audit.scopeInventory.filter(item => item.bridgeSessionId !== owner.bridgeSessionId).map(item => item.bridgeSessionId));
}

export async function verifySelectedLineage(context: NativeLineageSelectionContext, owner: SessionRecord): Promise<void> {
  const observed = JSON.stringify(context.store.list());
  selectedLineageSources(context.store.list(), owner);
  for (const source of owner.nativeLineageSelection?.sources ?? []) {
    if (!sameToolInput(context.lineageCheckpoint(source.record), source.checkpoint)
        || !sameToolInput(await inspect(context, source.record), source.evidence)
        || !sameToolInput(context.lineageCheckpoint(source.record), source.checkpoint)) refuse("source_proof_changed");
  }
  for (const source of owner.nativeLineageSelection?.historical ?? []) {
    const checkpoint = context.lineageCheckpoint(source.record);
    if (checkpoint.checkpointSha256 !== source.checkpointSha256 || lineageDigest(checkpoint.outcomes) !== source.outcomesSha256
        || !sameToolInput(await inspect(context, source.record), source.evidence)
        || context.lineageCheckpoint(source.record).checkpointSha256 !== source.checkpointSha256) refuse("source_proof_changed");
  }
  for (const proof of owner.nativeLineageSelection?.inactive ?? []) {
    if (!sameToolInput(await inspect(context, proof.record, true), proof.evidence)) refuse("source_proof_changed");
  }
  if (owner.pendingLineageReconciliation) {
    const proof = owner.nativeLineageSelection!.selected.checkpoint;
    const checkpoint = context.lineageCheckpoint(owner);
    const retained = owner.retainedCheckpoint;
    if (retained) {
      if (retained.sdkSessionId !== owner.sdkSessionId || retained.account !== owner.claudeAccount
          || retained.checkpointSha256 !== checkpoint.checkpointSha256) refuse("selected_checkpoint_changed");
    } else if (!sameToolInput(checkpoint, proof)) refuse("selected_checkpoint_changed");
  }
  if (JSON.stringify(context.store.list()) !== observed) refuse("scope_changed");
}

function scopeInventory(records: SessionRecord[], owner: SessionRecord) {
  return records.filter(record => record.factorySessionId === owner.factorySessionId && record.factoryCwd === owner.factoryCwd && record.toolNames.length > 0)
    .map(record => ({ bridgeSessionId: record.bridgeSessionId, sha256: lineageDigest(record) }))
    .sort((a, b) => a.bridgeSessionId.localeCompare(b.bridgeSessionId));
}
function isHistorical(record: SessionRecord, owner: SessionRecord): boolean {
  return record !== owner && Date.parse(record.createdAt) < Date.parse(owner.createdAt) && isEnded(record)
    && !record.pendingToolIds.length && !record.endedToolIds?.length && !record.hostCompletionReceipts?.length;
}
function selectionScope(records: SessionRecord[], owner: SessionRecord): SessionRecord[] {
  return records.filter(record => record.factorySessionId === owner.factorySessionId && record.factoryCwd === owner.factoryCwd
    && record.sdkSessionId && record.toolNames.length > 0).sort((a, b) => a.bridgeSessionId.localeCompare(b.bridgeSessionId));
}
function eligible(context: NativeLineageSelectionContext, request: SelectionRequest): SessionRecord {
  const owner = context.store.require(request.selected.bridgeSessionId);
  if (owner.factorySessionId !== request.factorySessionId || owner.factoryCwd !== request.factoryCwd
      || owner.state !== "IDLE" || owner.cancelRequested || owner.cancellation
      || owner.hostEnded && owner.hostEnded !== "resumable" || owner.pendingToolIds.length || owner.endedToolIds?.length
      || owner.hostCompletionReceipts?.length || owner.pendingHostRecovery || owner.pendingLineageReconciliation
      || owner.nativeLineageSelection || owner.checkpointRetryBlocked || !owner.historyMessageHashes?.length) refuse("selected_owner_unavailable");
  const all = context.store.list().filter(record => record.factorySessionId === owner.factorySessionId && record.factoryCwd === owner.factoryCwd);
  if (all.some(record => !record.sdkSessionId && (!isEnded(record) || record.historyMessageHashes?.length || record.pendingToolIds.length || record.endedToolIds?.length
      || record.hostCompletionReceipts?.length || recoverySessionActive(context, record.bridgeSessionId)))) refuse("unresolved_scope_record");
  const nativeScope = selectionScope(context.store.list(), owner);
  if (nativeScope.some(record => !record.claudeAccount || !context.accounts.includes(record.claudeAccount)
      || record.provider === "cursor" || record.contextHash !== owner.contextHash || record.model !== owner.model
      || record.role !== owner.role || record.reasoning !== owner.reasoning || !Number.isSafeInteger(record.nativeGeneration)
      || record.nativeGeneration! < 0 || record.nativeGeneration! >= 1_000_000
      || !Number.isFinite(Date.parse(record.createdAt)) || recoverySessionActive(context, record.bridgeSessionId))) refuse("record_identity_or_activity_changed");
  const scope = nativeScope.filter(record => !isHistorical(record, owner));
  const identities = [request.selected, ...request.sources];
  if (!request.sources.length || identities.length !== scope.length || new Set(identities.map(item => item.bridgeSessionId)).size !== identities.length) refuse("source_set_incomplete");
  for (const record of scope) {
    const identity = identities.find(item => item.bridgeSessionId === record.bridgeSessionId);
    if (!identity || record.sdkSessionId !== identity.sdkSessionId || record.claudeAccount !== identity.account
        || record.nativeGeneration !== identity.nativeGeneration || record.updatedAt !== identity.expectedUpdatedAt
        || !context.accounts.includes(identity.account) || record.provider === "cursor"
        || record.contextHash !== owner.contextHash || record.model !== owner.model || record.role !== owner.role
        || record.reasoning !== owner.reasoning || record.pendingToolIds.length || record.pendingHostRecovery
        || record.pendingLineageReconciliation || recoverySessionActive(context, record.bridgeSessionId)) refuse("record_identity_or_activity_changed");
    if (record === owner) continue;
    if (!isEnded(record) || record.state !== "CANCELLED" || record.cancellation?.source !== "admin"
        || !record.lineageCancellation || record.lineageCancellation.historySha256 !== lineageDigest([record.historyMessageHashes, record.requestMessageHashes])) refuse("source_not_explicitly_drained");
    const before = record.lineageCancellation.before;
    if (before.bridgeSessionId !== record.bridgeSessionId || before.sdkSessionId !== record.sdkSessionId
        || before.claudeAccount !== record.claudeAccount || before.nativeGeneration !== record.nativeGeneration
        || before.factorySessionId !== record.factorySessionId || before.factoryCwd !== record.factoryCwd
        || before.contextHash !== record.contextHash || before.pendingToolIds.length
        || !sameToolInput(before.hostCompletionReceipts, record.hostCompletionReceipts)
        || !sameToolInput(before.endedToolIds, record.endedToolIds)) refuse("source_snapshot_changed");
  }
  return owner;
}
async function inspect(context: NativeLineageSelectionContext, record: SessionRecord, checkpointOptional = false): Promise<NativeGenerationEvidence[]> {
  const generation = record.nativeGeneration!;
  const evidence = await context.inspect({ factorySessionId: record.factorySessionId!, bridgeSessionId: `${record.bridgeSessionId}:g${generation}`,
    cwd: record.factoryCwd!, subscriptionProfile: record.claudeAccount as SubscriptionProfile, useRecordedWorkspacePolicy: true, sdkSessionId: record.sdkSessionId! });
  const latest = evidence.filter(item => item.generation === Math.max(...evidence.map(item => item.generation)));
  if (!evidence.length || evidence.length > 128 || new Set(evidence.map(item => item.generation)).size !== evidence.length
      || evidence.some(item => !item.bindingMatches || !Number.isSafeInteger(item.generation) || item.generation > generation || item.generation < 0)
      || latest.length !== 1 || !checkpointOptional && !latest[0]!.checkpointMatches || latest[0]!.generation < generation - 1
      || evidence.some(item => !TERMINAL.includes(item.state) || !item.cleanupVerified || item.externalCleanupRequired
        || item.hostActionReservation || item.ownerAlive || item.supervisorAlive || !Number.isFinite(Date.parse(item.endedAt ?? "")))) refuse("lease_unsettled");
  if (recoverySessionActive(context, record.bridgeSessionId)) refuse("record_identity_or_activity_changed");
  return evidence.sort((a, b) => a.generation - b.generation);
}
function parse(input: unknown): SelectionRequest {
  const invalid = (): never => { throw new BridgeError(400, "invalid_control_request", "Exact native lineage identities, versions, proof digest and scoped approval are required."); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const body = input as SelectionRequest;
  if (Object.keys(body).some(key => !["operationId", "factorySessionId", "factoryCwd", "selected", "sources", "proofSha256", "approval", "historicalDispositions", "dryRun"].includes(key))
      || typeof body.operationId !== "string" || !ID.test(body.operationId) || typeof body.factorySessionId !== "string" || !ID.test(body.factorySessionId)
      || typeof body.factoryCwd !== "string" || !isAbsolute(body.factoryCwd)
      || !Array.isArray(body.sources) || body.sources.length > 32 || body.dryRun !== undefined && typeof body.dryRun !== "boolean") return invalid();
  for (const identity of [body.selected, ...body.sources]) {
    if (!identity || Object.keys(identity).some(key => !["bridgeSessionId", "sdkSessionId", "account", "nativeGeneration", "expectedUpdatedAt"].includes(key))
        || ![identity.bridgeSessionId, identity.sdkSessionId, identity.account].every(value => typeof value === "string" && ID.test(value))
        || !Number.isSafeInteger(identity.nativeGeneration) || identity.nativeGeneration < 0 || identity.nativeGeneration >= 1_000_000
        || !Number.isFinite(Date.parse(identity.expectedUpdatedAt))) return invalid();
  }
  if ((body.proofSha256 !== undefined || body.dryRun !== true) && !HASH.test(body.proofSha256 ?? "")) return invalid();
  if (body.historicalDispositions !== undefined) {
    if (!Array.isArray(body.historicalDispositions) || body.historicalDispositions.length > 32
        || new Set(body.historicalDispositions.map(item => item?.bridgeSessionId)).size !== body.historicalDispositions.length) return invalid();
    for (const item of body.historicalDispositions) {
      if (!item || Object.keys(item).some(key => !["bridgeSessionId", "sdkSessionId", "checkpointSha256", "outcomesSha256", "selected", "disposition", "approvalReference", "approvedAt"].includes(key))
          || typeof item.bridgeSessionId !== "string" || !ID.test(item.bridgeSessionId) || typeof item.sdkSessionId !== "string" || !ID.test(item.sdkSessionId)
          || !HASH.test(item.checkpointSha256) || !HASH.test(item.outcomesSha256) || !sameToolInput(item.selected, body.selected)
          || item.disposition !== "archive-superseded" || typeof item.approvalReference !== "string" || !item.approvalReference.trim()
          || item.approvalReference.length > 256 || !Number.isFinite(Date.parse(item.approvedAt))) return invalid();
    }
  }
  const approval = body.approval;
  if (body.dryRun !== true && (!approval || Object.keys(approval).some(key => !["reference", "approvedAt", "selectedBridgeSessionId", "selectedSdkSessionId", "sourceBridgeSessionIds"].includes(key))
      || typeof approval.reference !== "string" || !approval.reference.trim() || approval.reference.length > 256
      || !Number.isFinite(Date.parse(approval.approvedAt)) || approval.selectedBridgeSessionId !== body.selected.bridgeSessionId
      || approval.selectedSdkSessionId !== body.selected.sdkSessionId
      || body.historicalDispositions?.some(item => item.approvalReference === approval.reference)
      || !Array.isArray(approval.sourceBridgeSessionIds)
      || !sameToolInput([...approval.sourceBridgeSessionIds].sort(), body.sources.map(item => item.bridgeSessionId).sort()))) return invalid();
  return { ...body, dryRun: body.dryRun === true };
}
function refuse(reason: string): never {
  throw new BridgeError(409, "native_lineage_selection_refused", "Native lineage selection could not be verified.", { reason });
}
