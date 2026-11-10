import type { NativeGenerationEvidence } from "../runtime/desktop-jobs.js";
import type { ModelProvider } from "../models.js";
import type { RoleTag, SessionState } from "../types.js";
import type { RuntimeHostCompletion } from "../runtime/types.js";

export interface SessionRecord {
  bridgeSessionId: string;
  droidSessionId?: string;
  factorySessionId?: string;
  factoryCwd?: string;
  sdkSessionId?: string;
  /** Persisted purpose is independent of the latest mutable host tool catalog. */
  nativePurpose?: "interactive" | "auxiliary";
  /** Exact accepted request that failed upstream after all host work settled. */
  retryableRequestHash?: string;
  /** Admission retries retain the native checkpoint instead of cold-importing it. */
  retryableRequestKind?: "upstream" | "native-upstream" | "admission";
  /** Durable minimum waits observed from provider failures, independent of routing. */
  accountCooldowns?: Record<string, string>;
  /** Minted only after a clean upstream failure and verified native retirement. */
  retainedCheckpoint?: RetainedCheckpoint;
  /** Retained identity exists, but a failed preparation has no safe resume proof. */
  checkpointRetryBlocked?: boolean;
  upstreamCheckpointRecoveries?: UpstreamCheckpointRecovery[];
  dormantCheckpointRetirement?: DormantCheckpointRetirement;
  lineageCancellation?: LineageCancellation;
  nativeLineageSelection?: NativeLineageSelection;
  pendingLineageReconciliation?: string;
  /** Current execution settings admitted after the immutable baseline selection. */
  nativeLineageContext?: { model: string; contextHash?: string; reasoning?: string };
  /** Authenticated host receipts retained until an admitted turn consumes them. */
  hostCompletionReceipts?: RuntimeHostCompletion[];
  /** Runtime that owns sdkSessionId. Absent on Claude sessions created before Cursor coexisted. */
  provider?: ModelProvider;
  /** Claude account running this session (`personal` or a profile id). Set by the pool or after a limit moved it; absent means the model entry's own account. */
  claudeAccount?: string;
  /** Monotonic native lease generation for an explicitly enabled controller pool. */
  nativeGeneration?: number;
  /** Operator-selected workspace capability associated with the native generation. */
  controllerWorkspacePolicy?: "controller-readonly" | "controller-host";
  /** Operator recoveries of a failed pre-prompt continuation; the failure stays recorded here. */
  checkpointRecoveries?: NativeCheckpointRecovery[];
  /** Cancellation origin is recorded separately from the terminal state. */
  cancellation?: { at: string; source: "client-disconnect" | "admin" | "host" };
  /** Operator reconciliation of completed actions after a lost transport. */
  completedHostRecoveries?: CompletedHostRecovery[];
  /** Present only while the first recovered native turn is being reconciled. */
  pendingHostRecovery?: { operationId: string; notified?: boolean };
  /** Persist replay safety independently of process-local callback state. */
  hostEnded?: "resumable" | "terminal" | "interrupted";
  role: RoleTag;
  state: SessionState;
  model: string;
  historyHash?: string;
  /** Stable execution configuration, excluding dynamic host context and tools. */
  contextHash?: string;
  /** Selector level last applied. Absent when the request carried no level. */
  reasoning?: string;
  /** Message fingerprints of the request currently being handled. */
  requestMessageHashes?: string[];
  /** Completed client-visible transcript, including the assistant response. */
  historyMessageHashes?: string[];
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
  pendingToolIds: string[];
  /** IDs that were pending when the session ended. Never matched as owners; kept so a retried result gets a clear 409. */
  endedToolIds?: string[];
  cancelRequested: boolean;
  notes: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    estimated: boolean;
  };
}

export interface NativeCheckpointRecovery {
  at: string;
  sdkSessionId: string;
  fromGeneration: number;
  toGeneration: number;
  /** Last change to the failed record before recovery. */
  failedAt: string;
  leaseEndedAt: string;
}

export interface CompletedHostRecovery {
  operationId: string;
  at: string;
  sdkSessionId: string;
  fromGeneration: number;
  toGeneration: number;
  recordUpdatedAt: string;
  cancelledAt?: string;
  cancellationSource: "client-disconnect" | "unknown-operator-attested";
  checkpointSha256: string;
  receiptsSha256: string;
  leaseEndedAt: string;
  original: { cancelRequested: boolean; cancellation?: SessionRecord["cancellation"]; hostEnded?: SessionRecord["hostEnded"]; endedToolIds: string[]; notes: string[] };
  receipts: RuntimeHostCompletion[];
  reconciledAt?: string;
}

export interface SettledToolResult {
  toolUseId: string;
  resultSha256: string;
}

export interface RetainedCheckpoint {
  sdkSessionId: string;
  account: string;
  checkpointSha256: string;
  sourceGeneration: number;
  preparedAt: string;
  coolingUntil?: string;
  origin: "clean-upstream" | "operator-restored";
  settledToolIds?: string[];
  settledToolResults?: SettledToolResult[];
}

export interface UpstreamCheckpointRecovery {
  operationId: string;
  at: string;
  recordUpdatedAt: string;
  nativeGeneration: number;
  proof: RetainedCheckpoint;
  evidenceSha256: string;
  receiptsSha256?: string;
  before: { sdkSessionId?: string; retryableRequestKind?: SessionRecord["retryableRequestKind"]; retryableRequestHash?: string; accountCooldowns?: Record<string, string>; hostCompletionReceipts?: RuntimeHostCompletion[] };
}

/** A session in this condition can never resume or complete another tool round trip. */
export function isEnded(session: Pick<SessionRecord, "state" | "hostEnded">): boolean {
  return session.state === "CANCELLED" || session.state === "FAILED"
    || session.hostEnded === "terminal" || session.hostEnded === "interrupted";
}

/**
 * Release the tool IDs of an ended session. Factory keeps the matching
 * tool_result in its history, so a pending ID left behind would route every
 * later request of that conversation to a session that can only answer 409.
 */
export function retirePendingTools(record: SessionRecord): SessionRecord {
  if (!isEnded(record) || record.pendingToolIds.length === 0) return record;
  record.endedToolIds = [...new Set([...(record.endedToolIds ?? []), ...record.pendingToolIds])];
  record.pendingToolIds = [];
  return record;
}

export function transition(record: SessionRecord, next: SessionState): SessionRecord {
  const allowed: Record<SessionState, SessionState[]> = {
    NEW: ["GENERATING", "CANCELLED", "FAILED"],
    GENERATING: ["WAITING_DROID_TOOL", "IDLE", "CANCELLED", "FAILED"],
    WAITING_DROID_TOOL: ["RESUMING", "IDLE", "CANCELLED", "FAILED"],
    RESUMING: ["GENERATING", "WAITING_DROID_TOOL", "IDLE", "CANCELLED", "FAILED"],
    IDLE: ["GENERATING", "CANCELLED", "FAILED"],
    CANCELLED: [],
    FAILED: [],
  };
  if (!allowed[record.state].includes(next) && record.state !== next) {
    record.notes.push(`illegal transition ${record.state} -> ${next}`);
  }
  record.state = next;
  record.updatedAt = new Date().toISOString();
  return retirePendingTools(record);
}

export interface DormantCheckpointRetirement {
  operationId: string;
  at: string;
  before: Omit<SessionRecord, "dormantCheckpointRetirement">;
  targetBridgeSessionId: string;
  targetCreatedAt: string;
  targetRecordUpdatedAt: string;
  targetAccount: string;
  targetNativeGeneration: number;
  checkpointSha256: string;
  evidenceSha256: string;
  evidence: NativeGenerationEvidence[];
}


export interface NativeLineageOutcome {
  toolUseId: string;
  toolName: string;
  input: unknown;
  content: unknown;
  isError: boolean;
}
export interface NativeLineageCheckpoint {
  checkpointSha256: string;
  outcomes: NativeLineageOutcome[];
  settledToolResults: SettledToolResult[];
}
export interface LineageCancellation {
  before: Pick<SessionRecord, "bridgeSessionId" | "factorySessionId" | "factoryCwd" | "sdkSessionId" | "claudeAccount" | "nativeGeneration" | "provider" | "controllerWorkspacePolicy" | "contextHash" | "state" | "cancelRequested" | "cancellation" | "hostEnded" | "pendingToolIds" | "endedToolIds" | "hostCompletionReceipts" | "updatedAt">;
  historySha256: string;
}
export interface NativeLineageBranchProof {
  record: SessionRecord;
  checkpoint: NativeLineageCheckpoint;
  evidence: NativeGenerationEvidence[];
}
export interface NativeLineageSelection {
  operationId: string;
  at: string;
  requestSha256: string;
  proofSha256: string;
  approval: { reference: string; approvedAt: string; selectedBridgeSessionId: string; selectedSdkSessionId: string; sourceBridgeSessionIds: string[] };
  selected: NativeLineageBranchProof;
  sources: NativeLineageBranchProof[];
  historical: Array<{ record: SessionRecord; checkpointSha256: string; outcomesSha256: string; evidence: NativeGenerationEvidence[];
    disposition?: NativeLineageHistoricalDisposition }>;
  scopeInventory: Array<{ bridgeSessionId: string; sha256: string }>;
  inactive: Array<{ record: SessionRecord; evidence: NativeGenerationEvidence[] }>;
  reconciledAt?: string;
}

export interface NativeLineageHistoricalDisposition {
  bridgeSessionId: string;
  sdkSessionId: string;
  checkpointSha256: string;
  outcomesSha256: string;
  selected: { bridgeSessionId: string; sdkSessionId: string; account: string; nativeGeneration: number; expectedUpdatedAt: string };
  disposition: "archive-superseded";
  approvalReference: string;
  approvedAt: string;
}

/** Missing legacy provenance remains a possible interactive owner. */
export function nativePurpose(record: Pick<SessionRecord, "nativePurpose" | "toolNames">): "interactive" | "auxiliary" | "unknown" {
  if (record.nativePurpose === "interactive" || record.nativePurpose === "auxiliary") return record.nativePurpose;
  return record.toolNames.length ? "interactive" : "unknown";
}
