import type { DesktopWorkspacePolicy, NativeGenerationEvidence, NativeGenerationInspection, SubscriptionProfile } from "../runtime/desktop-jobs.js";
import type { BridgeRuntime } from "../runtime/types.js";
import { isEnded, type SessionRecord } from "../sessions/state.js";
import type { SessionStore } from "../sessions/store.js";
import { BridgeError, type Json } from "../types.js";

export interface NativeCheckpointRecoveryRequest {
  bridgeSessionId: string;
  factorySessionId: string;
  sdkSessionId: string;
  /** The failed generation; the recovered record continues under the next one. */
  nativeGeneration: number;
  dryRun: boolean;
}

export interface NativeCheckpointRecoveryContext {
  store: SessionStore;
  runtime: BridgeRuntime;
  /** Exact configured subscription profiles. */
  accounts: readonly string[];
  workspacePolicy: DesktopWorkspacePolicy;
  /** An HTTP request or permission prompt currently owns the session. */
  busy(sessionId: string): boolean;
  inspect(request: NativeGenerationInspection): Promise<NativeGenerationEvidence[]>;
  now?: () => Date;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FIELDS = ["bridgeSessionId", "factorySessionId", "sdkSessionId", "nativeGeneration", "dryRun"];
const INTERRUPTED_NOTES = ["bridge-restarted-during-generation", "bridge-restarted-while-waiting-for-tool", "request-timeout-interrupted"];
const TERMINAL_LEASES = ["completed", "failed", "cancelled", "interrupted"];

export function parseNativeCheckpointRecovery(input: unknown): NativeCheckpointRecoveryRequest {
  const invalid = (): BridgeError => new BridgeError(400, "invalid_control_request",
    "bridgeSessionId, factorySessionId, sdkSessionId and nativeGeneration are required; dryRun is optional.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !FIELDS.includes(key))) throw invalid();
  const { bridgeSessionId, factorySessionId, sdkSessionId, nativeGeneration, dryRun } = body;
  if (![bridgeSessionId, factorySessionId, sdkSessionId].every(value => typeof value === "string" && ID.test(value))
      || typeof nativeGeneration !== "number" || !Number.isSafeInteger(nativeGeneration) || nativeGeneration < 0 || nativeGeneration >= 1_000_000
      || (dryRun !== undefined && typeof dryRun !== "boolean")) throw invalid();
  return { bridgeSessionId: bridgeSessionId as string, factorySessionId: factorySessionId as string, sdkSessionId: sdkSessionId as string,
    nativeGeneration, dryRun: dryRun === true };
}

/**
 * Return one failed continuation to its retained native checkpoint under a new
 * lease generation. Only a failure that happened after its generation's lease
 * was closed at the session level qualifies: no model phase could have run in
 * between, so the failure occurred before any prompt reached the checkpoint.
 */
export async function recoverNativeCheckpoint(context: NativeCheckpointRecoveryContext, input: unknown): Promise<Record<string, Json>> {
  const request = parseNativeCheckpointRecovery(input);
  const settled = priorRecovery(context.store, request);
  if (settled) return settled;
  const record = eligibleRecord(context, request);
  // Inspect a stable set of persisted identities. A sibling can acquire work
  // while the read-only lease queries await their shared-state lock.
  const related = relatedRecoveryRecords(context.store, request.factorySessionId);
  const observed = JSON.stringify(related);
  const siblings = related.filter(item => item.bridgeSessionId !== request.bridgeSessionId).map(item => structuredClone(item));
  // The store hands out its live record; keep the observed failure version.
  const failedAt = record.updatedAt;
  const evidence = await context.inspect({ factorySessionId: request.factorySessionId,
    bridgeSessionId: `${request.bridgeSessionId}:g${request.nativeGeneration}`, cwd: record.factoryCwd!,
    subscriptionProfile: record.claudeAccount as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: request.sdkSessionId });
  const leaseEndedAt = verifyLineage(evidence, request.nativeGeneration, failedAt);
  await inspectRecoverySiblings(context, request.factorySessionId, siblings);
  // Inspection is asynchronous. A concurrent recovery or write may have won.
  const repeated = priorRecovery(context.store, request);
  if (repeated) return repeated;
  const current = eligibleRecord(context, request);
  if (current.updatedAt !== failedAt || JSON.stringify(relatedRecoveryRecords(context.store, request.factorySessionId)) !== observed) {
    refuse("changed_during_recovery");
  }
  const nextGeneration = request.nativeGeneration + 1;
  if (request.dryRun) {
    return { ok: true, eligible: true, recovered: false, bridgeSessionId: request.bridgeSessionId,
      nativeGeneration: request.nativeGeneration, nextGeneration };
  }
  const at = (context.now?.() ?? new Date()).toISOString();
  context.store.update(request.bridgeSessionId, { state: "IDLE", nativeGeneration: nextGeneration,
    retryableRequestHash: undefined, retryableRequestKind: undefined,
    notes: [...current.notes, `native-checkpoint-recovered:g${request.nativeGeneration}->g${nextGeneration}`],
    checkpointRecoveries: [...(current.checkpointRecoveries ?? []), { at, sdkSessionId: request.sdkSessionId,
      fromGeneration: request.nativeGeneration, toGeneration: nextGeneration, failedAt, leaseEndedAt }] });
  return { ok: true, recovered: true, bridgeSessionId: request.bridgeSessionId, nativeGeneration: nextGeneration };
}

export async function inspectRecoverySiblings(context: NativeCheckpointRecoveryContext, factorySessionId: string, siblings: SessionRecord[]): Promise<void> {
  for (const sibling of siblings) {
    const generation = sibling.nativeGeneration;
    if (!sibling.factoryCwd || !sibling.claudeAccount || !context.accounts.includes(sibling.claudeAccount)
        || sibling.provider === "cursor" || typeof generation !== "number" || !Number.isSafeInteger(generation)
        || generation < 0 || generation > 1_000_000
        || (sibling.sdkSessionId != null && (typeof sibling.sdkSessionId !== "string" || !ID.test(sibling.sdkSessionId)))) {
      refuse("sibling_identity_unproven");
    }
    const siblingEvidence = await context.inspect({ factorySessionId,
      bridgeSessionId: `${sibling.bridgeSessionId}:g${generation}`, cwd: sibling.factoryCwd,
      subscriptionProfile: sibling.claudeAccount as SubscriptionProfile, useRecordedWorkspacePolicy: true,
      ...(sibling.sdkSessionId == null ? {} : { sdkSessionId: sibling.sdkSessionId }) });
    verifySiblingLineage(siblingEvidence, generation, sibling.sdkSessionId != null);
  }
}

function priorRecovery(store: SessionStore, request: NativeCheckpointRecoveryRequest): Record<string, Json> | undefined {
  const record = store.get(request.bridgeSessionId);
  const receipt = record?.checkpointRecoveries?.find(item => item.sdkSessionId === request.sdkSessionId
    && item.fromGeneration === request.nativeGeneration);
  if (!record || !receipt) return undefined;
  if (record.factorySessionId !== request.factorySessionId) refuse("factory_session_mismatch");
  // Later work on the recovered record is never rewritten by a repeated call.
  return { ok: true, recovered: false, alreadyRecovered: true, bridgeSessionId: request.bridgeSessionId,
    nativeGeneration: receipt.toGeneration, recoveredAt: receipt.at };
}

export function relatedRecoveryRecords(store: SessionStore, factorySessionId: string): SessionRecord[] {
  return store.list().filter(record => record.factorySessionId === factorySessionId);
}

function eligibleRecord(context: NativeCheckpointRecoveryContext, request: NativeCheckpointRecoveryRequest): SessionRecord {
  const { store } = context;
  const record = store.get(request.bridgeSessionId);
  if (!record) refuse("session_not_found");
  if (record.provider === "cursor") refuse("unsupported_provider");
  if (record.factorySessionId !== request.factorySessionId) refuse("factory_session_mismatch");
  if (!record.factoryCwd) refuse("workspace_unknown");
  if (record.sdkSessionId !== request.sdkSessionId) refuse("checkpoint_mismatch");
  if (record.nativeGeneration !== request.nativeGeneration) refuse("generation_mismatch");
  if (!record.claudeAccount || !context.accounts.includes(record.claudeAccount)) refuse("account_mismatch");
  if (record.state !== "FAILED") refuse("not_failed");
  if (record.cancelRequested || record.hostEnded !== undefined) refuse("session_ended");
  if (record.pendingToolIds.length || record.endedToolIds?.length || record.hostCompletionReceipts?.length) refuse("unresolved_tools");
  if (record.notes.some(note => INTERRUPTED_NOTES.includes(note))) refuse("interrupted_generation");
  if (!record.historyMessageHashes?.length) refuse("no_completed_turn");
  verifyRecoverySessionInactive(context, record);
  return record;
}

export function verifyRecoverySessionInactive(context: NativeCheckpointRecoveryContext, record: SessionRecord): void {
  const { runtime, store } = context;
  const id = record.bridgeSessionId;
  const active = (sessionId: string): boolean => context.busy(sessionId) || runtime.ownsNativeSession?.(sessionId) === true
    || runtime.isSessionUsable?.(sessionId) === true || Boolean(runtime.protectedSessionIds?.().includes(sessionId))
    || Boolean(runtime.pendingHostCalls?.(sessionId).length);
  if (active(id)) refuse("session_active");
  for (const sibling of store.list()) {
    if (sibling.bridgeSessionId === id || sibling.factorySessionId !== record.factorySessionId) continue;
    if (active(sibling.bridgeSessionId)) refuse("sibling_active");
    // A completed turn elsewhere is either live work or newer than this
    // checkpoint. Reviving the older checkpoint would fork the conversation.
    if (sibling.historyMessageHashes?.length && (!isEnded(sibling) || Date.parse(sibling.createdAt) > Date.parse(record.createdAt))) {
      refuse("later_work_exists");
    }
  }
}

function verifyLineage(evidence: NativeGenerationEvidence[], generation: number, failedAt: string): string {
  const matching = evidence.filter(item => item.generation === generation && item.bindingMatches);
  if (matching.length !== 1) refuse("lease_evidence_missing");
  const target = matching[0]!;
  if (evidence.some(item => item.generation > generation)) refuse("newer_generation_exists");
  if (target.state !== "cancelled" || target.endedBy !== "session_update") refuse("lease_not_closed");
  if (target.externalCleanupRequired || target.hostActionReservation || !target.cleanupVerified) refuse("lease_cleanup_unproven");
  if (target.ownerAlive || target.supervisorAlive) refuse("lease_owner_alive");
  if (target.checkpointMatches !== true) refuse("lease_checkpoint_mismatch");
  const ended = Date.parse(target.endedAt ?? ""), failed = Date.parse(failedAt);
  if (!Number.isFinite(ended) || !Number.isFinite(failed) || ended >= failed) refuse("failure_precedes_lease_end");
  if (evidence.some(item => item !== target && (!TERMINAL_LEASES.includes(item.state) || item.externalCleanupRequired
      || item.hostActionReservation || item.ownerAlive || item.supervisorAlive))) refuse("predecessor_unresolved");
  return target.endedAt!;
}

function verifySiblingLineage(evidence: NativeGenerationEvidence[], generation: number, checkpointExpected: boolean): void {
  const matching = evidence.filter(item => item.generation === generation);
  if (matching.length !== 1 || evidence.some(item => !item.bindingMatches || item.generation > generation)
      || (checkpointExpected && matching[0]!.checkpointMatches !== true)) refuse("sibling_lease_evidence_unproven");
  if (evidence.some(item => !TERMINAL_LEASES.includes(item.state) || !item.cleanupVerified
      || item.externalCleanupRequired || item.hostActionReservation || item.ownerAlive || item.supervisorAlive)) {
    refuse("sibling_lease_unsettled");
  }
}

function refuse(reason: string): never {
  throw new BridgeError(409, "native_recovery_refused", "The native checkpoint was not recovered. No change was made.", { reason });
}
