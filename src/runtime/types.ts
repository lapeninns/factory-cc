import type { ContentBlock, MessagesRequest, MessagesResponse, RoleTag } from "../types.js";
import type { SessionRecord } from "../sessions/state.js";

export interface NativeWorkstreamIdentity { workstreamId: string; role: "orchestrator" | "agent" }

export interface RuntimeRequest {
  request: MessagesRequest;
  role: RoleTag;
  session: SessionRecord;
  headers: Record<string, string | string[] | undefined>;
  /** Trusted host policy supplied by the controller, never raw Messages metadata. */
  factoryPermissionMode?: string;
  /** Bound by ControlBroker from its live opaque marker, never raw request metadata. */
  factorySession?: { sessionId: string; cwd: string; launchId?: string; desktopLifecycle: boolean; nativeWorkstream?: NativeWorkstreamIdentity };
  /** Trusted HTTP retry receipt. Prior results become reference history, never callbacks. */
  recovery?: "cold-import";
}

export interface RuntimeTurn {
  response: MessagesResponse;
  pendingToolIds: string[];
  /** Official SDK session identity, used only with the SDK's resume option. */
  sdkSessionId?: string;
  compactMetadata?: Record<string, unknown>;
  sdkBillingUsage?: Record<string, unknown>;
  events?: RuntimeEvent[];
  notes?: string[];
  /** The reconciliation-only native turn ended without dispatching new host work. */
  reconciledHostOperationId?: string;
  reconciledLineageOperationId?: string;
}

export interface StreamSink {
  textDelta(text: string): void;
  toolTrace(name: string, detail: string): void;
  usage?(usage: import("../types.js").Usage): void;
  /** Native progress of any kind, such as an SDK message. Restarts the turn's idle timeout. */
  activity?(): void;
  /** Human approvals now pending for this session. The idle timeout is suspended while any is. */
  approvalsPending?(count: number): void;
}

export interface RuntimeEvent {
  at: string;
  type: string;
  data?: Record<string, unknown>;
}

export type RuntimePermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** A live native callback. The controller must not persist/replay its authority. */
export interface RuntimeApprovalRequest {
  bridgeSessionId: string;
  sdkSessionId?: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  requestId?: string;
  agentId?: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  signal: AbortSignal;
}

export interface RuntimeControl {
  requestApproval(request: RuntimeApprovalRequest): Promise<RuntimePermissionDecision>;
  factoryPermissionMode?(bridgeSessionId: string): string | undefined;
}

export interface RuntimeHostCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface RuntimeHostCompletion extends RuntimeHostCall {
  content: string | ContentBlock[];
  isError?: boolean;
  /** Only set after the host confirms this tool really terminated its session. */
  terminal?: boolean;
}

export interface RuntimeHostEnd {
  /** True only when a persisted native checkpoint has no unresolved host work. */
  resumable: boolean;
  sdkSessionId?: string;
}

export type RetiredSession = Pick<SessionRecord, "bridgeSessionId" | "sdkSessionId" | "provider">;

export interface BridgeRuntime {
  readonly kind: "mock" | "fake" | "sdk" | "cursor";
  handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn>;
  cancel(sessionId: string, reason: string): Promise<void>;
  deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">>;
  setControl?(control: RuntimeControl | undefined): void;
  /**
   * Ask the running native turn to stop and give it a short grace period to wind
   * down. True means it did and the session can be resumed from its checkpoint;
   * on false the caller must cancel().
   */
  interrupt?(sessionId: string, reason: string): Promise<boolean>;
  pendingHostCalls?(sessionId: string): RuntimeHostCall[];
  /** Exact SDK name of the pending callback, including its registered catalog revision. */
  pendingNativeToolName?(sessionId: string, toolUseId: string): string | undefined;
  /** Validate an authenticated host receipt without resuming native execution. */
  validateHostToolCompletion?(sessionId: string, completion: RuntimeHostCompletion): void;
  /** Record a durable host receipt. Delivery waits for the next admitted phase. */
  recordHostToolCompletion?(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate">;
  completeHostTool?(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate">;
  endHostSession?(sessionId: string, reason: string): Promise<RuntimeHostEnd>;
  describe?(): Record<string, unknown>;
  protectedSessionIds?(): string[];
  isSessionUsable?(sessionId: string): boolean;
  /** This process holds the session's current durable lease identity. */
  ownsNativeSession?(sessionId: string): boolean;
  /** Retire a failed, side-effect-free native generation only after verified cleanup. */
  prepareColdRetry?(sessionId: string): Promise<void>;
  /** Retire a clean upstream failure while retaining its exact native checkpoint. */
  prepareCheckpointRetry?(sessionId: string, sdkSessionId: string): Promise<void>;
  /** Drop only inactive retained metadata after its durable session was pruned. */
  forget?(session: RetiredSession): Promise<void>;
  close?(): Promise<void>;
}
