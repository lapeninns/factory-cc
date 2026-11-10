import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SubscriptionAccount } from "../config.js";
import type { NativeGenerationEvidence, SubscriptionProfile } from "../runtime/desktop-jobs.js";
import { StableDroidToolNames } from "../runtime/droid-mcp-catalog.js";
import type { RuntimeHostCompletion } from "../runtime/types.js";
import { MAX_RECOVERY_CONTEXT_BYTES, recoveredHostContext } from "../runtime/host-recovery.js";
import { sameToolInput } from "../sessions/compaction.js";
import type { CompletedHostRecovery, SessionRecord } from "../sessions/state.js";
import { BridgeError, type Json } from "../types.js";
import { inspectRecoverySiblings, relatedRecoveryRecords, verifyRecoverySessionInactive, type NativeCheckpointRecoveryContext } from "./native-recovery.js";

interface CompletedHostRecoveryRequest {
  operationId: string;
  bridgeSessionId: string;
  factorySessionId: string;
  sdkSessionId: string;
  nativeGeneration: number;
  expectedUpdatedAt: string;
  checkpointSha256?: string;
  receiptsSha256?: string;
  acknowledgeHistoricalDisconnect: boolean;
  dryRun: boolean;
}

export interface CompletedHostRecoveryContext extends NativeCheckpointRecoveryContext {
  checkpoint(record: SessionRecord, receipts: RuntimeHostCompletion[]): string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["operationId", "bridgeSessionId", "factorySessionId", "sdkSessionId", "nativeGeneration", "expectedUpdatedAt",
  "checkpointSha256", "receiptsSha256", "acknowledgeHistoricalDisconnect", "dryRun"];

function parseRequest(input: unknown): CompletedHostRecoveryRequest {
  const invalid = (): never => { throw new BridgeError(400, "invalid_control_request", "Explicit recovery identity, operation ID, generation and expectedUpdatedAt are required. Apply also requires both evidence hashes."); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !FIELDS.includes(key))) return invalid();
  for (const key of ["operationId", "bridgeSessionId", "factorySessionId", "sdkSessionId"]) {
    if (typeof body[key] !== "string" || !ID.test(body[key] as string)) return invalid();
  }
  if (typeof body.nativeGeneration !== "number" || !Number.isSafeInteger(body.nativeGeneration) || body.nativeGeneration < 0 || body.nativeGeneration >= 1_000_000
      || typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))
      || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
      || (body.acknowledgeHistoricalDisconnect !== undefined && typeof body.acknowledgeHistoricalDisconnect !== "boolean")) return invalid();
  for (const key of ["checkpointSha256", "receiptsSha256"]) {
    if ((body[key] !== undefined || body.dryRun !== true) && (typeof body[key] !== "string" || !HASH.test(body[key] as string))) return invalid();
  }
  return { ...body, dryRun: body.dryRun === true, acknowledgeHistoricalDisconnect: body.acknowledgeHistoricalDisconnect === true } as unknown as CompletedHostRecoveryRequest;
}

/** Separate from pre-prompt recovery. Every completed action remains in the audit. */
export async function recoverCompletedHostCheckpoint(context: CompletedHostRecoveryContext, input: unknown): Promise<Record<string, Json>> {
  const request = parseRequest(input);
  const prior = priorRecovery(context, request);
  if (prior) return prior;
  const record = eligibleRecord(context, request);
  const related = structuredClone(relatedRecoveryRecords(context.store, request.factorySessionId));
  const snapshot = JSON.stringify(related);
  const receipts = structuredClone(record.hostCompletionReceipts!);
  const receiptsSha256 = receiptDigest(receipts);
  if (request.receiptsSha256 !== undefined && receiptsSha256 !== request.receiptsSha256) refuse("receipt_digest_mismatch");
  const checkpointSha256 = context.checkpoint(record, receipts);
  if (request.checkpointSha256 !== undefined && checkpointSha256 !== request.checkpointSha256) refuse("checkpoint_digest_mismatch");
  const evidence = await context.inspect({ factorySessionId: request.factorySessionId,
    bridgeSessionId: `${request.bridgeSessionId}:g${request.nativeGeneration}`, cwd: record.factoryCwd!,
    subscriptionProfile: record.claudeAccount as SubscriptionProfile, workspacePolicy: context.workspacePolicy, sdkSessionId: request.sdkSessionId });
  const leaseEndedAt = verifyCancelledLineage(evidence, request.nativeGeneration);
  await inspectRecoverySiblings(context, request.factorySessionId, related.filter(item => item.bridgeSessionId !== request.bridgeSessionId));
  const repeated = priorRecovery(context, request);
  if (repeated) return repeated;
  const current = eligibleRecord(context, request);
  if (JSON.stringify(relatedRecoveryRecords(context.store, request.factorySessionId)) !== snapshot
      || context.checkpoint(current, receipts) !== checkpointSha256) refuse("changed_during_recovery");
  const nextGeneration = request.nativeGeneration + 1;
  if (request.dryRun) return { ok: true, eligible: true, recovered: false, operationId: request.operationId,
    bridgeSessionId: request.bridgeSessionId, nextGeneration, checkpointSha256, receiptsSha256, receiptCount: receipts.length };
  const at = (context.now?.() ?? new Date()).toISOString();
  const recovery: CompletedHostRecovery = { operationId: request.operationId, at, sdkSessionId: request.sdkSessionId,
    fromGeneration: request.nativeGeneration, toGeneration: nextGeneration, recordUpdatedAt: request.expectedUpdatedAt,
    ...(current.cancellation ? { cancelledAt: current.cancellation.at } : {}),
    cancellationSource: current.cancellation ? "client-disconnect" : "unknown-operator-attested", checkpointSha256, receiptsSha256, leaseEndedAt,
    original: { cancelRequested: current.cancelRequested, cancellation: current.cancellation ? structuredClone(current.cancellation) : undefined,
      hostEnded: current.hostEnded, endedToolIds: [...current.endedToolIds!], notes: [...current.notes] }, receipts };
  context.store.update(request.bridgeSessionId, { state: "IDLE", nativeGeneration: nextGeneration,
    cancelRequested: false, hostEnded: undefined, endedToolIds: [], hostCompletionReceipts: [], cancellation: undefined,
    retryableRequestHash: undefined, retryableRequestKind: undefined,
    completedHostRecoveries: [...(current.completedHostRecoveries ?? []), recovery], pendingHostRecovery: { operationId: request.operationId },
    notes: [...current.notes, `completed-host-recovered:${request.operationId}:g${request.nativeGeneration}->g${nextGeneration}`] });
  return { ok: true, recovered: true, operationId: request.operationId, bridgeSessionId: request.bridgeSessionId, nativeGeneration: nextGeneration };
}

function priorRecovery(context: CompletedHostRecoveryContext, request: CompletedHostRecoveryRequest): Record<string, Json> | undefined {
  const record = context.store.get(request.bridgeSessionId);
  const prior = record?.completedHostRecoveries?.find(item => item.operationId === request.operationId);
  if (!record || !prior) return undefined;
  if (record.factorySessionId !== request.factorySessionId || prior.sdkSessionId !== request.sdkSessionId
      || prior.fromGeneration !== request.nativeGeneration || prior.recordUpdatedAt !== request.expectedUpdatedAt
      || (request.checkpointSha256 !== undefined && prior.checkpointSha256 !== request.checkpointSha256)
      || (request.receiptsSha256 !== undefined && prior.receiptsSha256 !== request.receiptsSha256)) refuse("operation_identity_mismatch");
  if (record.state === "CANCELLED" || record.state === "FAILED" || record.cancelRequested || record.hostEnded === "terminal" || record.hostEnded === "interrupted") refuse("recovery_no_longer_active");
  return { ok: true, recovered: false, alreadyRecovered: true, operationId: request.operationId,
    bridgeSessionId: request.bridgeSessionId, nativeGeneration: prior.toGeneration, recoveredAt: prior.at };
}

function eligibleRecord(context: CompletedHostRecoveryContext, request: CompletedHostRecoveryRequest): SessionRecord {
  const record = context.store.get(request.bridgeSessionId);
  if (!record) refuse("session_not_found");
  if (record.provider === "cursor") refuse("unsupported_provider");
  if (record.factorySessionId !== request.factorySessionId) refuse("factory_session_mismatch");
  if (!record.factoryCwd) refuse("workspace_unknown");
  if (record.sdkSessionId !== request.sdkSessionId) refuse("checkpoint_mismatch");
  if (record.nativeGeneration !== request.nativeGeneration) refuse("generation_mismatch");
  if (!record.claudeAccount || !context.accounts.includes(record.claudeAccount)) refuse("account_mismatch");
  if (record.state !== "CANCELLED" || !record.cancelRequested) refuse("not_cancelled");
  if (record.updatedAt !== request.expectedUpdatedAt) refuse("cancellation_changed");
  if (record.cancellation ? record.cancellation.source !== "client-disconnect" : !request.acknowledgeHistoricalDisconnect) refuse("disconnect_not_authorized");
  if (record.hostEnded !== undefined || record.pendingHostRecovery) refuse("session_ended");
  if (!record.historyMessageHashes?.length) refuse("no_completed_turn");
  if (record.pendingToolIds.length || !record.endedToolIds?.length || record.endedToolIds.length > 128) refuse("unresolved_tools");
  const receipts = record.hostCompletionReceipts;
  if (!receipts || receipts.length !== record.endedToolIds.length || new Set(record.endedToolIds).size !== record.endedToolIds.length) refuse("receipt_set_incomplete");
  if ((record.completedHostRecoveries?.length ?? 0) >= 32
      || Buffer.byteLength(JSON.stringify([record.completedHostRecoveries ?? [], receipts])) > 16 * 1024 * 1024) refuse("recovery_audit_full");
  const signatures = new Set<string>();
  for (const id of record.endedToolIds) {
    const matches = receipts.filter(receipt => receipt.toolUseId === id);
    if (matches.length !== 1) refuse("receipt_set_incomplete");
    const receipt = matches[0]!;
    if (receipt.isError || receipt.terminal || !receipt.toolName || receipt.input === undefined
        || !(typeof receipt.content === "string" || Array.isArray(receipt.content)
          && receipt.content.every(block => block !== null && typeof block === "object" && typeof block.type === "string"))) refuse("receipt_not_successful");
    const signature = canonical({ toolName: receipt.toolName, input: receipt.input });
    if (signatures.has(signature)) refuse("receipt_action_ambiguous");
    signatures.add(signature);
  }
  if (Buffer.byteLength(recoveredHostContext(receipts)) > MAX_RECOVERY_CONTEXT_BYTES) refuse("recovery_context_too_large");
  verifyRecoverySessionInactive(context, record);
  return record;
}

function verifyCancelledLineage(evidence: NativeGenerationEvidence[], generation: number): string {
  const matching = evidence.filter(item => item.generation === generation && item.bindingMatches);
  if (matching.length !== 1 || evidence.some(item => !item.bindingMatches)) refuse("lease_evidence_missing");
  const target = matching[0]!;
  if (evidence.some(item => item.generation > generation)) refuse("newer_generation_exists");
  if (target.state !== "cancelled" || target.endedBy !== "session_update" || !Number.isFinite(Date.parse(target.endedAt ?? ""))) refuse("lease_not_closed");
  if (target.checkpointMatches !== true) refuse("lease_checkpoint_mismatch");
  if (evidence.some(item => !["completed", "failed", "cancelled", "interrupted"].includes(item.state)
      || !item.cleanupVerified || item.externalCleanupRequired || item.hostActionReservation)) refuse("lease_cleanup_unproven");
  if (evidence.some(item => item.ownerAlive || item.supervisorAlive)) refuse("lease_owner_alive");
  return target.endedAt!;
}

export function receiptDigest(receipts: RuntimeHostCompletion[]): string {
  return createHash("sha256").update(canonical([...receipts].sort((a, b) => a.toolUseId.localeCompare(b.toolUseId)))).digest("hex");
}

/** Read only the exact configured account/project/checkpoint, with no path input from the operator. */
export function inspectCompletedHostCheckpoint(accounts: readonly SubscriptionAccount[], record: SessionRecord, receipts: RuntimeHostCompletion[],
  expectedSettledToolIds: readonly string[] = []): string {
  const account = accounts.find(item => item.profile === record.claudeAccount);
  const root = account?.env.CLAUDE_CONFIG_DIR;
  if (!root || !isAbsolute(root) || !record.factoryCwd || !record.sdkSessionId
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.sdkSessionId)) refuse("checkpoint_path_unproven");
  const project = record.factoryCwd.replace(/[^A-Za-z0-9]/g, "-");
  if (project.length > 200) refuse("checkpoint_path_unproven");
  const directory = join(root, "projects", project);
  let fd: number | undefined;
  try {
    for (const path of [root, join(root, "projects"), directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || realpathSync(path) !== resolve(path)) refuse("checkpoint_path_unproven");
    }
    fd = openSync(join(directory, record.sdkSessionId + ".jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size <= 0 || before.size > 64 * 1024 * 1024) refuse("checkpoint_file_unproven");
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) refuse("checkpoint_changed");
    verifyCheckpointActions(bytes.toString("utf8"), record.sdkSessionId, receipts, expectedSettledToolIds);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    return refuse("checkpoint_file_unproven");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function verifyCheckpointActions(text: string, sdkSessionId: string, receipts: RuntimeHostCompletion[], expectedSettledToolIds: readonly string[]): void {
  const calls = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, { isError: boolean; content: unknown }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: { sessionId?: unknown; message?: { role?: unknown; content?: unknown } };
    try { row = JSON.parse(line) as typeof row; } catch { refuse("checkpoint_format_unproven"); }
    if (!row || typeof row !== "object") refuse("checkpoint_format_unproven");
    if (!row.message || !Array.isArray(row.message.content)) continue;
    if (row.sessionId !== undefined && row.sessionId !== sdkSessionId) refuse("checkpoint_identity_mismatch");
    for (const block of row.message.content as Array<Record<string, unknown>>) {
      if (row.message.role === "assistant" && block?.type === "tool_use") {
        if (typeof block.id !== "string" || typeof block.name !== "string" || block.input === undefined) refuse("checkpoint_format_unproven");
        const call = { name: block.name, input: block.input };
        if (calls.has(block.id) && !sameToolInput(calls.get(block.id), call)) refuse("checkpoint_conflicting_tool");
        calls.set(block.id, call);
      } else if (row.message.role === "user" && block?.type === "tool_result") {
        if (typeof block.tool_use_id !== "string") refuse("checkpoint_format_unproven");
        const result = { isError: block.is_error === true, content: block.content };
        if (results.has(block.tool_use_id) && !sameToolInput(results.get(block.tool_use_id), result)) refuse("checkpoint_conflicting_result");
        results.set(block.tool_use_id, result);
      }
    }
  }
  if ([...calls.keys()].some(id => !results.has(id))) refuse("checkpoint_has_pending_tools");
  if ([...results.keys()].some(id => !calls.has(id))) refuse("checkpoint_has_unmatched_results");
  if (expectedSettledToolIds.some(id => !calls.has(id) || !results.has(id))) refuse("checkpoint_completion_missing");
  const recoveredIds = new Set(receipts.map(receipt => receipt.toolUseId));
  const orderedIds = [...calls.keys()];
  const firstRecovered = orderedIds.findIndex(id => recoveredIds.has(id));
  if (firstRecovered >= 0 && orderedIds.slice(firstRecovered).some(id => !recoveredIds.has(id))) refuse("checkpoint_has_later_tools");
  const names = new StableDroidToolNames();
  for (const receipt of receipts) {
    const call = calls.get(receipt.toolUseId);
    if (!call || call.name !== `mcp__droid__${names.toMcp(receipt.toolName)}` || !sameToolInput(call.input, receipt.input)) refuse("checkpoint_action_mismatch");
    if (results.get(receipt.toolUseId)?.isError !== true) refuse("checkpoint_cancellation_unproven");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function refuse(reason: string): never {
  throw new BridgeError(409, "completed_host_recovery_refused", "The completed host checkpoint was not recovered. No change was made.", { reason });
}
