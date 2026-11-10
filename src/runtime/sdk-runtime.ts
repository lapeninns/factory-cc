import { WORKSTREAM_DECISION_POLICY } from "./decision-policy.js";
import { WorkflowPermits, workflowAllowed, workflowProviderAllowed, validateWorkflowInput } from './native-workflows.js';
import { assertNativeWorkflowSupport } from './native-workflow-support.js';
import { desktopActionQuestion, desktopJobPolicy, desktopWorkflowApproved, desktopWorkflowQuestion, type DesktopWorkflowQuestion } from "./desktop-workflow-approval.js";
import { decideWorkerApproval, readPendingWorkerApprovals } from "./worker-permission-client.js";
import { verifyNativeSubscription } from "../workers/subscription-auth.js";
import { DESKTOP_DISALLOWED_TOOLS, DESKTOP_APPROVAL_DENIAL, DESKTOP_READ_DENIAL } from "./desktop-policy.js";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { resolveRequestCwd } from "../workspace.js";
import { asBlocks, collectToolResults } from "../protocol/content.js";
import { assistantMessage } from "../protocol/messages.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { BridgeConfig, SubscriptionAccount } from "../config.js";
import type { ContentBlock, Json, Usage } from "../types.js";
import { BridgeError } from "../types.js";
import { appendLogLine, type Logger } from "../logging.js";
import { claudeToolTraceDetail, isDroidMcpName, selectDroidMcpTools } from "./droid-tools.js";
import { DroidMcpCatalog, StableDroidToolNames } from "./droid-mcp-catalog.js";
import { hostAllowsAnyTools, nativeToolAllowed } from "./native-tool-policy.js";
import { buildDynamicUserContent, buildHostContext, buildInitialUserContent, buildPresetSystemPrompt, coldImportStats, describePromptLayout, trailingUserMessages, type ColdImportStats } from "./system-prompt.js";
import { UsageLedger } from "./usage.js";
import { INTERRUPT_GRACE_MS, TurnWatchdog } from "./turn-watchdog.js";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimeEvent, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimePermissionDecision, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";
import { redactClaudeConfigText, claudeConfigNeedsLogin, CLAUDE_LOGIN_REQUIRED } from "../upstream/claude-config.js";
import { PERSONAL_ACCOUNT, POOL_PROFILE } from "../upstream/claude-pool.js";
import { buildChildEnv, classifyAuth, maskEmail, type AuthClassification, type AuthObservation } from "../upstream/auth-env.js";
import { publicSelection, sdkEnv, selectionFromConfig, type UpstreamSelection } from "../upstream/providers.js";
import { resolveRequestModel } from "../models.js";
import { claudeReasoningKey, claudeReasoningOptions, droidReasoningLevel } from "./reasoning.js";
import { OwnedProcesses } from "./owned-processes.js";
import { hostActionNeedsWorkspaceReservation } from "./desktop-jobs.js";
import { upstreamError } from "./upstream-error.js";
import { redactValue } from "../security/redact.js";
import { historicalHostResult, hostReceiptContent, matchesSettledHostResult, mcpResultContent as mcpContent, RECOVERY_ONLY_DENIAL, recoveredHostContext, lineageReconciliationContext } from "./host-recovery.js";

type ModelRoute = ReturnType<typeof resolveRequestModel>;

/** Kept narrow so tests can inject a deterministic SDK without starting a CLI. */
export interface SdkHandle {
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> & {
    interrupt?: () => Promise<unknown>;
    close?: () => void;
    mcpServerStatus?: () => Promise<Array<{ name: string; status: string; tools?: Array<{ name: string; description?: string }> }>>;
    accountInfo?: () => Promise<Record<string, unknown>>;
  };
  tool(name: string, description: string, schema: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>, extras?: Record<string, unknown>): unknown;
  createSdkMcpServer(options: Record<string, unknown>): unknown;
}

export interface SdkUserInput {
  type: "user";
  message: { role: "user"; content: ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
}

/** A streaming SDK prompt stays open between user turns, including MCP waits. */
class InputQueue implements AsyncIterable<SdkUserInput> {
  private readonly values: SdkUserInput[] = [];
  private nextValue?: (value: IteratorResult<SdkUserInput>) => void;
  private ended = false;

  push(value: SdkUserInput): void {
    if (this.ended) throw new BridgeError(409, "session_closed", "SDK input queue is closed");
    const next = this.nextValue;
    this.nextValue = undefined;
    if (next) next({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    this.values.length = 0;
    this.nextValue?.({ value: undefined, done: true });
    this.nextValue = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserInput> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.nextValue = resolve; });
      },
    };
  }
}

interface PendingTurn {
  resolve(turn: RuntimeTurn): void;
  reject(error: Error): void;
}
interface DroidCall { id: string; name: string; input: unknown; mcpName?: string; messageId?: string }
interface HandlerArrival {
  name: string;
  mcpName?: string;
  input: Record<string, unknown>;
  callId?: string;
  resolve(call: DroidCall): void;
  reject(error: BridgeError): void;
}
interface HostResultConsumption {
  promise: Promise<void>;
  resolve(): void;
}
interface DesktopApprovalReceipt {
  question: DesktopWorkflowQuestion;
  resolve?: (decision: RuntimePermissionDecision) => void;
  fingerprint?: string;
}
interface NativePermissionContext {
  signal?: AbortSignal;
  toolUseID?: string;
  requestId?: string;
  agentID?: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}
interface LiveSdk {
  mailbox: ToolMailbox;
  inputs: InputQueue;
  events: RuntimeEvent[];
  busy: boolean;
  active: boolean;
  terminal?: BridgeError;
  sdkSessionId?: string;
  names?: StableDroidToolNames;
  catalog?: DroidMcpCatalog;
  policyKey?: string;
  modelRoute?: ModelRoute;
  /** JSON of the Claude effort/thinking options applied to the open query. */
  reasoningKey?: string;
  abort?: AbortController;
  query?: ReturnType<SdkHandle["query"]>;
  processOwner?: string;
  cleanup?: Promise<void>;
  cleanupFailed?: boolean;
  subscriptionAccount?: SubscriptionAccount;
  retiring?: Promise<void>;
  turnStartedAt?: number;
  nativeCallsThisRequest?: boolean;
  upstreamBackoff?: { at: string; status: number; retryAfter?: number; heldForNativeWork: boolean };
  loop?: Promise<void>;
  waiter?: PendingTurn;
  outbox: RuntimeTurn[];
  sink?: StreamSink;
  current?: RuntimeRequest;
  usage: UsageLedger;
  streamed: string;
  /** A new text block started since the last delta: separate it from the text before it. */
  textBreak?: boolean;
  blocks: ContentBlock[];
  pending: Map<string, DroidCall>;
  candidates: Map<string, DroidCall>;
  /** The main thread's assistant message being streamed: its tool_use order and whether it has ended. */
  workflowPermits?: WorkflowPermits;
  workflowTimer?: ReturnType<typeof setTimeout>;
  workflowDeferredResult?: Record<string, unknown>;
  assistantTurn?: { id: string; toolUses: Array<{ id: string; name: string }>; seen: Set<string>; stopped: boolean };
  /** Task batches waiting for their assistant message to finish streaming. */
  batchChecks: Set<() => void>;
  /** Task calls already sent to Droid with an earlier Task of the same message, before their own handler. */
  prefetched: Set<string>;
  handlerArrivals: Set<HandlerArrival>;
  retiredCandidates: Set<string>;
  claimedHandlers: Set<string>;
  resultFingerprints: Map<string, string>;
  hostResultConsumptions: Map<string, HostResultConsumption>;
  hostCompletionFingerprints: Map<string, string>;
  recordedHostCompletions: Map<string, RuntimeHostCompletion>;
  /** Historical successes may suppress exact replays only during the recovery turn. */
  recoveryReceipts?: RuntimeHostCompletion[];
  approvals: Set<AbortController>;
  desktopApprovals: Map<string, DesktopApprovalReceipt>;
  hostEnding?: string;
  resumableAfterHostEnd?: boolean;
  lastRequestKey?: string;
  lastReply?: RuntimeTurn;
  compactMetadata?: Record<string, unknown>;
  lastHostContext?: string;
  sentUserTurns: number;
  starting: boolean;
  queryEpoch: number;
  initApiKeySource?: string;
  accountSnapshot?: AuthObservation;
  lastTouched: number;
  backgroundTasks: Set<string>;
  /** Backstop deadline of the HTTP request currently waiting for this session's turn. */
  watchdog?: TurnWatchdog;
  /** Set while interrupt() waits for the aborted turn to end. */
  interrupting?: boolean;
  windDown?: () => void;
  /** Wind down the previous native response before delivering queued user input. */
  turnHandoff?: TurnHandoff;
  /** Lifecycle position of the current request, kept for the terminal failure record. */
  phase?: "startup" | "prompted" | "continuation" | "responding" | "waiting_host";
  queryStartedAt?: number;
  /** Counts only. Present while the current request is a cold import. */
  importStats?: ColdImportStats & { contentBytes?: number };
  /** Allowlisted SDK failure fields of the current request. Never message text. */
  failure?: SdkFailure;
}

interface SdkFailure { terminalReason?: string; apiErrorStatus?: number; resultSubtype?: string; assistantError?: string }

const TERMINAL_REASONS = new Set(["blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error", "model_error", "api_error",
  "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools", "stop_hook_prevented", "hook_stopped", "tool_deferred", "max_turns",
  "background_requested", "completed", "budget_exhausted", "structured_output_retry_exhausted", "tool_deferred_unavailable", "turn_setup_failed"]);
const ASSISTANT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error",
  "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"]);
/** Claude Code's fixed text for an over-window prompt, used by producers without terminal_reason. */
const PROMPT_TOO_LONG_TEXT = /^Prompt is too long\b/;

/**
 * The HTTP layer enforces the idle and maximum limits and interrupts cleanly
 * first. The runtime's own deadline only guards callers that drive it without
 * that layer, so it waits long enough for an interrupt to finish.
 */
const BACKSTOP_SLACK_MS = INTERRUPT_GRACE_MS + 1_000;

type DroidResult = { tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };
type TurnHandoff = { reason: "cancelled" | "steering"; followup: ContentBlock[] };

/**
 * Droid's whole result when the user picks "No, cancel" (each locale of its
 * common:toolExecution.cancelledByUser) or interrupts a tool. Droid sends it as
 * "Error: <text>" and then ends its own turn without another request.
 */
const USER_CANCELLATIONS = new Set([
  "Tool execution cancelled by user", "工具执行已被用户取消", "ツール実行がユーザーによりキャンセルされました",
  "사용자가 도구 실행을 취소했습니다", "Esecuzione dello strumento annullata dall'utente",
  "Tool execution was interrupted", "Request interrupted by user",
]);
const CANCELLED_TOOL_NOTE = "The user cancelled or interrupted this tool call in Droid. Preserve any work already done. Do not retry it or try another way. Acknowledge the cancellation in one short sentence, then end your turn.";
const CANCELLED_TURN_DENIAL = "BRIDGE_USER_CANCELLED: The user cancelled the previous tool call in Droid. Do not retry it or use any other tool now; acknowledge the cancellation and end your turn.";
const STEERING_TOOL_NOTE = "A new user message is queued. This is the completed tool's actual result. Preserve work already done, finish the current response without starting another tool, then read the new user message and continue any unfinished task.";
const STEERING_TURN_DENIAL = "BRIDGE_USER_TURN_PENDING: A new user message is queued. Finish the current response without using another tool, then read the new user turn and continue the task.";
/**
 * accountInfo() resolves only when Claude Code answers its initialize request,
 * so this bounds process startup. A Mission starting several workers and Task
 * subagents at once has taken over 10s. Until it answers, no prompt is sent.
 */
const SDK_START_TIMEOUT_MS = 60_000;
/** Longest a Task waits for the rest of its message before it goes to Droid alone. */
const TASK_BATCH_WAIT_MS = 30_000;

/** Claude Code had not started in time; its account was never examined. */
class SdkStartTimeout extends BridgeError {
  constructor(readonly timeoutMs: number) {
    super(503, "sdk_start_timeout", `Claude Code did not finish starting within ${timeoutMs}ms, so its account could not be verified and no prompt was sent. Retry the request.`, { retry_after: 1 });
  }
}

/** Official Claude Code owns the agent loop, tools, context, and compaction. */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk?: SdkHandle;
  private selection?: UpstreamSelection;
  private selectionPromise?: Promise<UpstreamSelection | undefined>;
  private readonly lives = new Map<string, LiveSdk>();
  private readonly usageFile: string;
  private control?: RuntimeControl;
  private authVerification?: AuthVerification;
  private readonly processes: OwnedProcesses;
  private readonly maintenance: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly config: BridgeConfig, private readonly logger: Logger, sdk?: SdkHandle) {
    this.sdk = sdk;
    this.usageFile = join(config.logDir, "usage.jsonl");
    this.processes = new OwnedProcesses(logger);
    this.maintenance = setInterval(() => { void this.maintain().catch(() => logger.error("sdk_maintenance_failed")); }, 30_000);
    this.maintenance.unref();
  }

  describe(): Record<string, unknown> {
    return {
      kind: "sdk", authMode: this.config.authMode, permissionMode: this.config.permissionMode,
      controllerHostTools: this.config.controllerHostTools === true,
      controllerApprovalPolicy: this.config.controllerApprovalPolicy ?? "ask",
      ...(this.config.claudeConfig ? { claudeProfile: {
        settingsPath: this.config.claudeConfig.path,
        upstreamOrigin: this.config.claudeConfig.env.ANTHROPIC_BASE_URL ? new URL(this.config.claudeConfig.env.ANTHROPIC_BASE_URL).origin : "https://api.anthropic.com",
      } } : {}),
      prompt: describePromptLayout(), tools: "preset:claude_code + droid-exclusive MCP",
      input: "persistent SDK streaming input", includePartialMessages: true,
      approvalChannel: this.control ? "external controller" : "unavailable: fail closed",
      activeNativeSessions: [...this.lives.values()].filter((live) => !live.terminal && (live.query || live.starting)).length,
      processes: this.processes.describe(),
      slotsInUse: this.slotsInUse(), maxSlots: this.config.maxSessions,
      maxIdleSessions: this.config.maxIdleSessions ?? 4,
      upstreamBackoffs: [...this.lives.entries()].flatMap(([sessionId, live]) => !live.terminal && live.upstreamBackoff ? [{ sessionId, ...live.upstreamBackoff }] : []),
      oldestTurnMs: Math.max(0, ...[...this.lives.values()].filter((live) => live.active && live.turnStartedAt).map((live) => Date.now() - live.turnStartedAt!)),
      activeNativeTurns: [...this.lives.values()].filter((live) => !live.terminal && live.active).length,
      pendingHostCalls: [...this.lives.values()].reduce((total, live) => total + (live.terminal ? 0 : live.pending.size), 0),
      pendingApprovals: [...this.lives.values()].reduce((total, live) => total + live.approvals.size, 0),
      fatalErrors: [...this.lives.entries()].flatMap(([sessionId, live]) => live.terminal && !["cancelled", "host_session_ended"].includes(live.terminal.code)
        ? [{ sessionId, code: live.terminal.code, message: live.terminal.message }] : []),
      overridesAnthropicEnv: this.config.authMode === "byok",
      authVerification: this.authVerification ?? null,
      upstream: this.selection ? publicSelection(this.selection) : { selected: false, authMode: this.config.authMode },
      ...(this.config.models !== undefined ? {
        modelRouting: "explicit-catalog",
        sessions: [...this.lives.entries()].map(([sessionId, live]) => ({
          sessionId, sdkSessionId: live.sdkSessionId, modelId: live.modelRoute?.id,
          nativeModel: live.modelRoute?.model, active: live.active, ended: Boolean(live.terminal),
          ...(live.subscriptionAccount ? { subscriptionProfile: live.subscriptionAccount.profile,
            nativeGeneration: live.current?.session.nativeGeneration } : {}),
        })),
      } : {}),
    };
  }

  setControl(control: RuntimeControl | undefined): void {
    // A replaced/disconnected controller cannot retain permission authority.
    if (control !== this.control) for (const live of this.lives.values()) {
      for (const approval of live.approvals) approval.abort();
    }
    this.control = control;
  }

  protectedSessionIds(): string[] {
    return [...this.lives.entries()].filter(([, live]) => !live.terminal && (live.busy || live.active || live.starting || live.pending.size
      || live.handlerArrivals.size || live.hostResultConsumptions.size || live.approvals.size || live.backgroundTasks.size || live.outbox.length)).map(([id]) => id);
  }

  isSessionUsable(sessionId: string): boolean {
    const live = this.lives.get(sessionId);
    return Boolean(live && !live.terminal && !live.hostEnding);
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    if (!live || live.terminal) return [];
    return [...live.pending.values()].map((call) => ({ toolUseId: call.id, toolName: call.name, input: structuredClone(call.input) }));
  }

  validateHostToolCompletion(sessionId: string, completion: RuntimeHostCompletion): void {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live SDK owns this host completion");
    const call = live.mailbox.getCall(completion.toolUseId);
    if (!call) throw new BridgeError(409, "unknown_tool_use_id", completion.toolUseId);
    if (call.originalName !== completion.toolName || canonicalJson(call.input) !== canonicalJson(completion.input)) {
      throw new BridgeError(409, "conflicting_host_completion", "Host completion does not match the accepted native tool invocation");
    }
    const fingerprint = createHash("sha256").update(canonicalJson({ ...completion, isError: Boolean(completion.isError), terminal: Boolean(completion.terminal) })).digest("hex");
    const previous = live.hostCompletionFingerprints.get(completion.toolUseId);
    if (previous) {
      if (previous !== fingerprint) throw new BridgeError(409, "conflicting_host_completion", completion.toolUseId);
      return;
    }
    const recorded = live.recordedHostCompletions.get(completion.toolUseId);
    if (recorded && hostCompletionFingerprint(recorded) !== fingerprint) {
      throw new BridgeError(409, "conflicting_host_completion", completion.toolUseId);
    }
    if (live.terminal) throw live.terminal;
    if (live.hostEnding) throw new BridgeError(409, "host_session_ending", live.hostEnding);
    if (completion.terminal && completion.isError) throw new BridgeError(400, "failed_terminal_tool", "A failed host tool does not confirm successful session termination");
    if (completion.terminal && [...live.pending.keys()].some((id) => id !== completion.toolUseId)) {
      throw new BridgeError(409, "host_tools_pending", "A terminal completion cannot discard another pending host tool");
    }
    const result: DroidResult = { tool_use_id: completion.toolUseId, content: completion.content, is_error: Boolean(completion.isError) };
    mcpContent(result.content);
    if (!previous) this.validateResults(live, [result]);
  }

  async recordHostToolCompletion(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    this.validateHostToolCompletion(sessionId, completion);
    const live = this.lives.get(sessionId)!;
    if (live.recordedHostCompletions.has(completion.toolUseId) || live.hostCompletionFingerprints.has(completion.toolUseId)) return "duplicate";
    live.recordedHostCompletions.set(completion.toolUseId, structuredClone(completion));
    live.events.push({ at: now(), type: "host_tool_receipt_recorded", data: { toolUseId: completion.toolUseId, toolName: completion.toolName } });
    return "accepted";
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    this.validateHostToolCompletion(sessionId, completion);
    const live = this.lives.get(sessionId)!;
    const fingerprint = hostCompletionFingerprint(completion);
    if (live.hostCompletionFingerprints.has(completion.toolUseId)) return "duplicate";
    const result: DroidResult = { tool_use_id: completion.toolUseId, content: completion.content, is_error: Boolean(completion.isError) };
    live.hostCompletionFingerprints.set(completion.toolUseId, fingerprint);
    if (completion.terminal) live.hostEnding = `Host completed ${completion.toolName}`;
    const [outcome] = this.submitResults(live, [result]);
    live.events.push({ at: now(), type: "host_tool_completed", data: { toolUseId: completion.toolUseId, toolName: completion.toolName, terminal: Boolean(completion.terminal), isError: Boolean(completion.isError) } });
    if (completion.terminal) {
      // Let the real MCP handler consume the host's actual result before closing
      // its worker. No final model request or fabricated model success is needed.
      await live.hostResultConsumptions.get(completion.toolUseId)?.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.endHostSession(sessionId, `Host completed ${completion.toolName}`);
    }
    return outcome!;
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const live = this.lives.get(sessionId);
    if (!live) return { resumable: false };
    if (live.terminal) return { resumable: live.terminal.code === "host_session_ended" && live.resumableAfterHostEnd === true, sdkSessionId: live.sdkSessionId };
    live.resumableAfterHostEnd = this.config.persistSessions && Boolean(live.sdkSessionId) && !live.hostEnding
      && !live.pending.size && !live.handlerArrivals.size && !live.candidates.size && !live.backgroundTasks.size;
    live.events.push({ at: now(), type: "host_session_ended", data: { reason, unresolvedToolIds: [...live.pending.keys()] } });
    await this.stop(live, new BridgeError(409, "host_session_ended", reason));
    return { resumable: live.resumableAfterHostEnd, sdkSessionId: live.sdkSessionId };
  }

  async ensureSelection(): Promise<UpstreamSelection | undefined> {
    if (this.config.authMode !== "byok") return undefined;
    if (this.selection) return this.selection;
    if (this.selectionPromise) return this.selectionPromise;
    this.selectionPromise = (async () => {
      const configured = selectionFromConfig({ baseUrl: this.config.upstreamBaseUrl, model: this.config.upstreamModel, tokenEnv: this.config.upstreamTokenEnv });
      if (configured) return (this.selection = configured);
      throw new BridgeError(401, "blocked_auth", "BYOK requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV; automatic credential discovery is disabled.");
    })();
    try { return await this.selectionPromise; }
    finally { this.selectionPromise = undefined; }
  }

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    const preparationStarted = Date.now();
    if (this.closing) throw new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
    // Resolve before allocating or changing a native session. A catalog typo or
    // missing explicit credential must never fall back to another model/login.
    const modelRoute = this.config.models !== undefined ? resolveRequestModel(this.config, input.request.model) : undefined;
    const id = input.session.bridgeSessionId;
    let live = this.lives.get(id);
    if (input.recovery === "cold-import") {
      if (this.config.controllerPool && live) throw new BridgeError(409, "native_retry_unprepared", "Retire the prior native generation before account failover.");
      if (live && !live.terminal) throw new BridgeError(409, "session_busy", "The previous query has not stopped");
      live = this.createLive();
      this.lives.set(id, live);
    }
    if (live?.terminal?.code === "host_session_ended" && live.resumableAfterHostEnd) {
      if (input.session.pendingToolIds.length) throw new BridgeError(409, "interrupted_tool_roundtrip", "The ended host session still records unresolved tools; do not replay them");
      const previous = live;
      live = this.createLive(previous.sdkSessionId);
      // Preserve only resumable native configuration/context. A new generation
      // never inherits callbacks, approvals, delivery receipts or old replies.
      live.names = previous.names;
      live.catalog = previous.catalog;
      live.policyKey = previous.policyKey;
      live.modelRoute = previous.modelRoute;
      live.lastHostContext = previous.lastHostContext;
      live.sentUserTurns = previous.sentUserTurns;
      this.lives.set(id, live);
    }
    if (!live && input.session.pendingToolIds.length) {
      throw new BridgeError(409, "interrupted_tool_roundtrip", "The bridge restarted while a Droid tool was pending. Start a new session; the tool will not be replayed.");
    }
    if (!live) {
      live = this.createLive(input.session.sdkSessionId);
      this.lives.set(id, live);
    }
    if (this.config.controllerPool && live.policyKey && live.policyKey !== queryPolicy(input, this.config)) {
      throw new BridgeError(409, "session_configuration_changed", "The controller account or native generation changed without verified retirement.");
    }
    if (live.terminal) throw live.terminal;
    if (live.hostEnding) throw new BridgeError(409, "host_session_ending", live.hostEnding);
    if (live.busy) throw new BridgeError(409, "session_busy", "This session already has an active HTTP request");
    // Acquire before the first await: concurrent initial turns cannot start two queries.
    live.busy = true;
    live.lastTouched = Date.now();
    live.sink = sink;
    let waiting: Promise<RuntimeTurn> | undefined;
    try {
      // An approval left pending by an earlier request still pauses this one's idle limit.
      this.notifyApprovals(live);
      const requestKey = createHash("sha256").update(JSON.stringify({ request: input.request, role: input.role, cwd: resolveCwd(input, this.config), missionDir: input.headers["x-bridge-mission-dir"] })).digest("hex");
      if (requestKey === live.lastRequestKey && live.lastReply) return live.lastReply;
      const trailing = trailingUserMessages(input.request.messages);
      // Droid may insert an assistant record between a completed tool and steering.
      // Only callbacks this live query still owns can receive earlier user results.
      const earlier = live.pending.size ? collectToolResults(input.request.messages
        .slice(0, input.request.messages.length - trailing.length).filter((message) => message.role === "user"))
        .filter((result) => live.pending.has(result.tool_use_id)) : [];
      const retained = input.session.retainedCheckpoint;
      const retainedResume = Boolean(retained && input.session.retryableRequestKind === "native-upstream"
        && retained.sdkSessionId === input.session.sdkSessionId && retained.account === input.session.claudeAccount
        && live.sdkSessionId === retained.sdkSessionId && !live.query && !live.active && !live.pending.size && !live.sentUserTurns);
      let results = [...earlier, ...latestToolResults(input, live.active || live.pending.size > 0 || retainedResume)];
      const lineage = input.session.pendingLineageReconciliation ? input.session.nativeLineageSelection : undefined;
      if (input.session.pendingLineageReconciliation && (!lineage || lineage.operationId !== input.session.pendingLineageReconciliation)) {
        throw new BridgeError(409, "lineage_reconciliation_missing", "The selected lineage outcomes are unavailable.");
      }
      if (lineage) {
        if (live.active || live.pending.size) throw new BridgeError(409, "lineage_reconciliation_busy", "Native work must settle before lineage reconciliation.");
        live.recoveryReceipts = [];
        const rawResults = trailing.flatMap(message => asBlocks(message.content)).filter(block => block.type === "tool_result");
        if (rawResults.some(block => !("tool_use_id" in block) || typeof block.tool_use_id !== "string" || !block.tool_use_id)
            || new Set(results.map(result => result.tool_use_id)).size !== results.length
            || rawResults.length !== results.length) throw new BridgeError(409, "conflicting_settled_result", "Cross-lineage result identities are incomplete or ambiguous.");
        const settled = lineage.sources.length ? lineage.sources.flatMap(source => source.checkpoint.settledToolResults)
          : retainedResume ? retained?.settledToolResults ?? [] : [];
        results = results.filter(result => {
          if (!matchesSettledHostResult(result, settled)) throw new BridgeError(409, "conflicting_settled_result", "A cross-lineage result is not proven by the selection audit.");
          return false;
        });
      }
      const recovery = input.session.pendingHostRecovery;
      const recovered = recovery && input.session.completedHostRecoveries?.find(item => item.operationId === recovery.operationId);
      if (recovery && !recovered) throw new BridgeError(409, "recovery_receipt_missing", "The recovered host actions are unavailable; do not replay them.");
      if (recovered && !recovery.notified && !live.active && !live.pending.size) {
        live.recoveryReceipts = structuredClone(recovered.receipts);
        const settled = new Set(recovered.receipts.map(receipt => receipt.toolUseId));
        results = results.filter(result => !settled.has(result.tool_use_id));
      }
      if (retainedResume && retained?.settledToolResults?.length) {
        results = results.filter(result => {
          const settled = retained.settledToolResults!.find(item => item.toolUseId === result.tool_use_id);
          if (!settled) return true;
          if (!matchesSettledHostResult(result, retained.settledToolResults!)) throw new BridgeError(409, "conflicting_settled_result", "A previously consumed tool result changed.");
          return false;
        });
      }
      // Hook receipts are authenticated independently of a model continuation.
      // Their representation may differ from Droid's display wrapper. Deliver
      // the recorded content once, under this phase's admission permit.
      for (const completion of input.session.hostCompletionReceipts ?? []) {
        if (live.pending.has(completion.toolUseId)) await this.recordHostToolCompletion(id, completion);
      }
      for (const completion of live.recordedHostCompletions.values()) {
        if (!live.pending.has(completion.toolUseId)) continue;
        results = results.filter(result => result.tool_use_id !== completion.toolUseId);
        results.push({ tool_use_id: completion.toolUseId, content: hostReceiptContent(completion.content), is_error: Boolean(completion.isError) });
      }
      if (input.recovery === "cold-import") results = [];
      // A conversation imported from history has no native callbacks to answer.
      // Its tool results are earlier history when the same message carries a new
      // user turn; the cold import below presents them as reference.
      if (results.length && !live.sdkSessionId && !live.sentUserTurns && hasNewUserContent(input)) results = [];
      if (!results.length && live.active) {
        throw new BridgeError(409, "session_busy", "Complete the current SDK turn and its Droid tools before sending a new user turn");
      }
      if (results.length) {
        this.validateResults(live, results);
        const supplied = new Set(results.map((result) => result.tool_use_id));
        const missing = live.lastReply?.response.content
          .filter((block) => block.type === "tool_use")
          .map((block) => (block as { id: string }).id)
          .filter((callId) => live.pending.has(callId) && !supplied.has(callId)) ?? [];
        if (missing.length) throw new BridgeError(409, "incomplete_tool_results", "Return all tool results from the preceding response together", { missing_tool_use_ids: missing });
        if (!live.active && !live.outbox.length) {
          throw new BridgeError(409, "stale_tool_result", "These tool results have already completed their SDK turn");
        }
      }
      const policy = queryPolicy(input, this.config);
      if (live.policyKey && live.policyKey !== policy) {
        throw new BridgeError(409, "session_configuration_changed", "Working directory, model, permission policy or role changed; start a separate session");
      }
      if (modelRoute) await this.selectModel(live, modelRoute, results.length > 0);
      await this.selectReasoning(live, input, results.length > 0);
      const context = buildHostContext(input, resolveCwd(input, this.config), this.config.factoryNative);
      // A cancellation or an assistant separator ends Droid's previous response.
      // Keep subsequent user input separate from the completed tool result.
      const cancelled = results.some((result) => isUserCancellation(result) && !live.resultFingerprints.has(result.tool_use_id));
      const followup = results.length && (cancelled || earlier.length) ? this.followupContent(input, live, context) : [];
      const handoff: TurnHandoff | undefined = cancelled || followup.length
        ? { reason: cancelled ? "cancelled" : "steering", followup } : undefined;
      const continuation = results.length && !followup.length ? this.continuationContent(input, live, context) : [];
      if ((continuation.length || followup.length) && results.every((result) => live.resultFingerprints.has(result.tool_use_id))) {
        throw new BridgeError(409, "stale_tool_result_context", "New host context cannot be attached to an already-delivered tool result");
      }
      // Validate before changing catalog, fingerprints, or mailbox state.
      // Unsupported documents must not wake a pending handler and fail later.
      for (const result of results) if (!live.resultFingerprints.has(result.tool_use_id)) mcpContent(result.content);
      if (continuation.length) mcpContent(continuation);
      live.current = input;
      live.nativeCallsThisRequest = false;
      live.failure = undefined;
      live.importStats = undefined;
      live.phase = results.length ? "continuation" : live.phase;
      waiting = this.waitForTurn(live);
      // Attach rejection handling before startup awaits, including startup timeouts.
      void waiting.catch(() => undefined);
      // ToolSearch may add tools on the very request that returns its result.
      // Publish the catalog change before unblocking the original MCP handler.
      if (live.query && input.request.tools !== undefined) await this.updateCatalog(live, input);
      if (live.terminal) throw live.terminal;
      if (results.length) {
        this.submitResults(live, results, continuation, handoff);
        live.lastHostContext = context;
        this.flushOutbox(live);
        this.logger.info("sdk_turn_prepared", { sessionId: id, sdkSessionId: live.sdkSessionId, kind: "tool-continuation", queryReused: true, preparationMs: Date.now() - preparationStarted });
      } else {
        // The CLI can emit init before it reads its first input. That new session ID
        // is not evidence that the supplied Droid history was already imported.
        const coldImport = !live.sentUserTurns && !live.sdkSessionId;
        const queryReused = Boolean(live.query);
        live.active = true;
        live.importStats = coldImport && trailingUserMessages(input.request.messages).length < input.request.messages.length
          ? coldImportStats(input.request.messages) : undefined;
        if (!live.query) await this.startQuery(input, live);
        if (live.terminal) throw live.terminal;
        const cwd = resolveCwd(input, this.config);
        const content = coldImport
          ? buildInitialUserContent(input, cwd, this.config.factoryNative)
          : buildDynamicUserContent(input, cwd, { includeContext: live.lastHostContext !== context, factoryNative: this.config.factoryNative });
        if (lineage) content.push({ type: "text", text: lineageReconciliationContext(lineage) });
        if (recovered && !recovery.notified) content.push({ type: "text", text: recoveredHostContext(recovered.receipts) });
        if (live.importStats) live.importStats.contentBytes = Buffer.byteLength(JSON.stringify(content));
        live.phase = "prompted";
        live.lastHostContext = context;
        live.sentUserTurns++;
        live.inputs.push({
          type: "user", message: { role: "user", content },
          parent_tool_use_id: null, session_id: live.sdkSessionId ?? "", uuid: randomUUID(),
        });
        this.logger.info("sdk_turn_prepared", { sessionId: id, sdkSessionId: live.sdkSessionId, kind: "user", queryReused, coldImport,
          importedMessages: coldImport ? input.request.messages.length : 0, contentBytes: Buffer.byteLength(JSON.stringify(content)), preparationMs: Date.now() - preparationStarted });
      }
      const reply = await waiting;
      if (!reply.pendingToolIds.length) {
        if (recovered) reply.reconciledHostOperationId = recovered.operationId;
        if (lineage && reply.response.stop_reason === "end_turn") reply.reconciledLineageOperationId = lineage.operationId;
        live.recoveryReceipts = undefined;
      }
      live.lastRequestKey = requestKey;
      live.lastReply = reply;
      return reply;
    } catch (error) {
      if (waiting) {
        live.recoveryReceipts = undefined;
        await this.stop(live, this.sdkError(error));
      }
      throw live.terminal ?? this.sdkError(error);
    } finally {
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = Date.now();
      void this.trimIdle().catch(() => this.logger.error("sdk_idle_trim_failed"));
    }
  }

  async deliverResults(sessionId: string, results: DroidResult[]): Promise<Array<"accepted" | "duplicate">> {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live SDK owns these tool results");
    if (live.terminal) throw live.terminal;
    this.validateResults(live, results);
    return this.submitResults(live, results);
  }

  async interrupt(sessionId: string, reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    const query = live?.query;
    if (!live || live.terminal || live.interrupting || !query?.interrupt) return false;
    live.interrupting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const woundDown = new Promise<boolean>((resolve) => {
        live.windDown = () => resolve(true);
        timer = setTimeout(() => resolve(false), INTERRUPT_GRACE_MS);
        timer.unref();
      });
      // Not awaited: the abort is acknowledged only when the turn's result arrives.
      try { void query.interrupt().catch(() => undefined); } catch { /* best effort */ }
      if (!(await woundDown)) return false;
    } finally {
      if (timer) clearTimeout(timer);
      live.interrupting = false;
      live.windDown = undefined;
    }
    // The turn stopped at a clean boundary. Retire the process but keep the
    // native checkpoint, so the next request resumes it like after a host exit.
    return (await this.endHostSession(sessionId, reason)).resumable;
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (live) {
      await this.stop(live, new BridgeError(499, "cancelled", reason));
      if (live.cleanupFailed) throw new BridgeError(503, "native_cleanup_incomplete", "Native process cleanup could not be verified.");
    }
  }

  async prepareColdRetry(sessionId: string): Promise<void> {
    return this.prepareRetry(sessionId);
  }

  async prepareCheckpointRetry(sessionId: string, sdkSessionId: string): Promise<void> {
    if (!this.config.persistSessions || this.lives.get(sessionId)?.sdkSessionId !== sdkSessionId) {
      throw new BridgeError(409, "native_checkpoint_mismatch", "The failed query does not own the retained native checkpoint.");
    }
    return this.prepareRetry(sessionId);
  }

  private async prepareRetry(sessionId: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live?.terminal) {
      throw new BridgeError(409, "native_retry_unsafe", "This native generation is not safe to import as history.");
    }
    await live.cleanup;
    if (live.cleanupFailed || live.query
        || (live.processOwner && this.processes.has(live.processOwner))) {
      throw new BridgeError(503, "native_cleanup_incomplete", "Native process cleanup could not be verified.");
    }
    if (live.terminal.extra.retry_from_history !== true) {
      throw new BridgeError(409, "native_retry_unsafe", "This native generation is not safe to import as history.");
    }
    // No callbacks or process state cross the generation boundary.
    this.lives.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.maintenance);
    await Promise.all([...this.lives.values()].map((live) => this.stop(live, new BridgeError(499, "cancelled", "bridge shutdown"))));
    await this.processes.close();
    this.lives.clear();
  }

  private createLive(sdkSessionId?: string): LiveSdk {
    return {
      mailbox: new ToolMailbox(), inputs: new InputQueue(), events: [], busy: false, active: false,
      sdkSessionId, outbox: [], usage: new UsageLedger(), streamed: "", blocks: [], pending: new Map(),
      candidates: new Map(), handlerArrivals: new Set(), retiredCandidates: new Set(), batchChecks: new Set(), prefetched: new Set(),
      claimedHandlers: new Set(), resultFingerprints: new Map(), sentUserTurns: 0,
      hostResultConsumptions: new Map(), hostCompletionFingerprints: new Map(), recordedHostCompletions: new Map(), approvals: new Set(),
      desktopApprovals: new Map(),
      starting: false, queryEpoch: 0, lastTouched: Date.now(), backgroundTasks: new Set(),
    };
  }

  private async selectModel(live: LiveSdk, route: ModelRoute, hasResults: boolean): Promise<void> {
    const previous = live.modelRoute;
    if (!previous) { live.modelRoute = route; return; }
    if (previous.routeKey === route.routeKey && previous.id === route.id) return;
    if (hasResults || live.active || live.starting || live.pending.size || live.handlerArrivals.size
        || live.candidates.size || live.hostResultConsumptions.size || live.approvals.size
        || live.backgroundTasks.size || live.outbox.length) {
      throw new BridgeError(409, "model_switch_busy", "Finish the current turn, tools and background tasks before switching models.");
    }
    if (!this.config.persistSessions || !live.sdkSessionId) {
      throw new BridgeError(409, "model_switch_requires_persistence", "Switching models requires a persisted native session. Keep the current model or start a separate conversation.");
    }
    if (live.query && !live.query.close) {
      throw new BridgeError(409, "model_switch_unavailable", "The native query cannot be closed safely for model switching.");
    }

    // Model slots and BRIDGE_MODEL_ID are process environment. A setModel call
    // alone leaves native subagents and generator commands on the old model.
    // Retire the idle query, then resume its official transcript with one
    // consistent model/environment. Late callbacks retain the retired epoch.
    try { await this.retireQuery(live); }
    catch {
      const error = new BridgeError(502, "model_switch_failed", "The old native process could not be verified stopped; no new model was started.");
      await this.stop(live, error); throw error;
    }
    if (live.terminal) throw live.terminal;
    live.modelRoute = route;
    live.lastReply = undefined;
    live.lastRequestKey = undefined;
    const change = {
      fromId: previous.id, toId: route.id, fromModel: previous.model, toModel: route.model,
      sdkSessionId: live.sdkSessionId, sessionId: live.current?.session.bridgeSessionId, strategy: "resume",
    };
    live.events.push({ at: now(), type: "sdk_model_changed", data: change });
    this.logger.info("sdk_model_changed", change);
  }

  /** Same idle retire as a model switch. The next startQuery resumes sdkSessionId. */
  private async selectReasoning(live: LiveSdk, input: RuntimeRequest, hasResults: boolean): Promise<void> {
    const next = claudeReasoningKey(input.request);
    if (live.reasoningKey === next) return;
    if (!live.query) {
      live.reasoningKey = next;
      return;
    }
    if (hasResults || live.active || live.starting || live.pending.size || live.handlerArrivals.size
        || live.candidates.size || live.hostResultConsumptions.size || live.approvals.size
        || live.backgroundTasks.size || live.outbox.length) {
      throw new BridgeError(409, "reasoning_switch_busy", "Finish the current turn, tools and background tasks before changing reasoning effort.");
    }
    if (!this.config.persistSessions || !live.sdkSessionId) {
      throw new BridgeError(409, "reasoning_switch_requires_persistence", "Changing reasoning effort requires a persisted native session.");
    }
    if (!live.query.close) {
      throw new BridgeError(409, "reasoning_switch_unavailable", "The native query cannot be closed safely for a reasoning change.");
    }
    const previous = live.reasoningKey;
    try { await this.retireQuery(live); }
    catch {
      const error = new BridgeError(502, "reasoning_switch_failed", "The old native process could not be verified stopped; no new reasoning level was started.");
      await this.stop(live, error); throw error;
    }
    if (live.terminal) throw live.terminal;
    live.reasoningKey = next;
    live.lastReply = undefined;
    live.lastRequestKey = undefined;
    const level = droidReasoningLevel(input.request) ?? null;
    const change = { from: previous ?? null, to: next, level, sdkSessionId: live.sdkSessionId, sessionId: live.current?.session.bridgeSessionId, strategy: "resume" };
    live.events.push({ at: now(), type: "sdk_reasoning_changed", data: change });
    this.logger.info("sdk_reasoning_changed", change);
  }

  private validateResults(live: LiveSdk, results: DroidResult[]): void {
    const batch = new Map<string, string>();
    for (const result of results) {
      if (!live.mailbox.hasCall(result.tool_use_id) && !live.desktopApprovals.has(result.tool_use_id)) throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
      const fingerprint = resultFingerprint(result);
      const previous = live.resultFingerprints.get(result.tool_use_id);
      const earlierInBatch = batch.get(result.tool_use_id);
      if ((previous && previous !== fingerprint) || (earlierInBatch && earlierInBatch !== fingerprint)) throw new BridgeError(409, "conflicting_tool_result", result.tool_use_id);
      batch.set(result.tool_use_id, fingerprint);
    }
  }

  private continuationContent(input: RuntimeRequest, live: LiveSdk, context: string): ContentBlock[] {
    const content = trailingUserMessages(input.request.messages).flatMap((message) => buildDynamicUserContent({
      ...input, request: { ...input.request, messages: [message] },
    }, resolveCwd(input, this.config), { includeContext: false }));
    if (context !== live.lastHostContext) content.push({ type: "text", text: context });
    return content.length ? [{ type: "text", text: "Host continuation context supplied by Droid with these tool results (not an additional user turn):" }, ...content] : [];
  }

  /** Queue the user's steering separately from the completed tool result. */
  private followupContent(input: RuntimeRequest, live: LiveSdk, context: string): ContentBlock[] {
    const blocks = trailingUserMessages(input.request.messages).flatMap((message) => asBlocks(message.content)).filter((block) => block.type !== "tool_result");
    if (!blocks.length) return [];
    return buildDynamicUserContent({ ...input, request: { ...input.request, messages: [{ role: "user", content: blocks }] } },
      resolveCwd(input, this.config), { includeContext: context !== live.lastHostContext, factoryNative: this.config.factoryNative });
  }

  private submitResults(live: LiveSdk, results: DroidResult[], continuation: ContentBlock[] = [], handoff?: TurnHandoff): Array<"accepted" | "duplicate"> {
    if (results.some((result) => !live.resultFingerprints.has(result.tool_use_id))) {
      if (handoff) live.turnHandoff = handoff;
      else if (results.some((result) => isUserCancellation(result) && !live.resultFingerprints.has(result.tool_use_id))) live.turnHandoff = { reason: "cancelled", followup: [] };
    }
    let attached = false;
    return results.map((result) => {
      const fresh = !live.resultFingerprints.has(result.tool_use_id);
      live.resultFingerprints.set(result.tool_use_id, resultFingerprint(result));
      live.pending.delete(result.tool_use_id);
      const receipt = live.recordedHostCompletions.get(result.tool_use_id);
      if (receipt) {
        live.hostCompletionFingerprints.set(result.tool_use_id, hostCompletionFingerprint(receipt));
        live.recordedHostCompletions.delete(result.tool_use_id);
      }
      const desktopApproval = live.desktopApprovals.get(result.tool_use_id);
      if (desktopApproval) {
        if (!fresh) return "duplicate" as const;
        desktopApproval.fingerprint = resultFingerprint(result);
        const resolve = desktopApproval.resolve;
        desktopApproval.resolve = undefined;
        resolve?.(desktopWorkflowApproved(desktopApproval.question, result)
          ? { behavior: "allow" }
          : { behavior: "deny", message: "The Workflow was not explicitly approved in Factory." });
        return "accepted" as const;
      }
      // validateResults already proved a repeat has the same fingerprint. What the
      // mailbox kept may carry host continuation text, so do not compare against it.
      if (!fresh) return "duplicate" as const;
      const note = isUserCancellation(result) ? CANCELLED_TOOL_NOTE
        : live.turnHandoff?.reason === "steering" ? STEERING_TOOL_NOTE : undefined;
      const extra: ContentBlock[] = note ? [{ type: "text", text: note }] : [];
      if (!attached && continuation.length) {
        extra.push(...continuation);
        attached = true;
      }
      return live.mailbox.submitResult(extra.length ? { ...result, content: [...asBlocks(result.content), ...extra] } : result);
    });
  }

  private async updateCatalog(live: LiveSdk, input: RuntimeRequest): Promise<void> {
    const started = Date.now();
    if (!live.catalog) throw new BridgeError(503, "dynamic_tools_unavailable", "The live SDK session has no mutable Droid MCP catalog");
    if (await live.catalog.update(selectDroidMcpTools(input.request.tools, this.config.desktopProfile, this.config.factoryNative)
      .filter((tool) => controllerHostToolAllowed(this.config, tool.name)))) {
      await this.waitForCatalogVisibility(live);
      live.events.push({ at: now(), type: "droid_catalog_updated", data: {
        tools: live.catalog.definitions().map((tool) => tool.name), visibility: "cli_tool_names_confirmed", schemaVisibility: "revision_name_confirmed",
      } });
      this.logger.info("droid_catalog_updated", { sdkSessionId: live.sdkSessionId, tools: live.catalog.definitions().length, catalogMs: Date.now() - started });
    }
  }

  private async waitForCatalogVisibility(live: LiveSdk): Promise<void> {
    const query = live.query;
    if (!query?.mcpServerStatus) throw new BridgeError(503, "dynamic_tools_unavailable", "SDK cannot confirm that Claude Code refreshed its MCP catalog");
    const expected = live.catalog!.definitions().map((tool) => live.names!.toMcp(tool.name)).sort();
    const deadline = Date.now() + Math.min(5_000, Math.max(1, Math.floor(this.config.requestTimeoutMs / 2)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      while (!live.terminal && Date.now() < deadline) {
        const statuses = await query.mcpServerStatus!();
        const server = statuses.find((status) => status.name === "droid");
        const actual = server?.tools?.map((tool) => tool.name.replace(/^mcp__droid__/, "")).sort();
        if (server?.status === "connected" && actual && JSON.stringify(actual) === JSON.stringify(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      throw live.terminal ?? new BridgeError(503, "tool_catalog_not_visible", "Claude Code did not refresh its advertised Droid tools before continuation");
    };
    try {
      await Promise.race([
        poll(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BridgeError(503, "tool_catalog_not_visible", "Timed out confirming the Claude Code tool catalog")), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async startQuery(input: RuntimeRequest, live: LiveSdk): Promise<void> {
    if (live.retiring) await live.retiring;
    // Reserve synchronously, before capacity eviction or SDK import can yield.
    live.starting = true;
    live.phase = "startup";
    live.queryStartedAt = Date.now();
    try {
      await this.ensureQueryCapacity(live);
      if (live.terminal || this.closing) throw live.terminal ?? new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
      await this.startQueryImpl(input, live);
    } finally { live.starting = false; }
  }

  private slotsInUse(): number {
    return this.processes.size + [...this.lives.values()].filter((live) => !live.terminal && (live.query || live.starting) && (!live.processOwner || !this.processes.has(live.processOwner))).length;
  }

  private async ensureQueryCapacity(current: LiveSdk): Promise<void> {
    const owners = new Set([...this.lives.values()].filter((live) => !live.terminal && (live.query || live.starting)).flatMap((live) => live.processOwner ? [live.processOwner] : []));
    if (this.processes.hasOrphans(owners)) {
      await this.processes.reap(owners);
      if (this.processes.hasOrphans(owners)) throw new BridgeError(503, "sdk_cleanup_incomplete", "An earlier owned process could not be stopped; no new process was started", { retry_after: 1 });
    }
    while (this.slotsInUse() > this.config.maxSessions) {
      const idle = this.idleLives().find((live) => live !== current);
      if (!idle) throw new BridgeError(429, "rate_limit_error", "All Claude Code slots have live work or are still stopping. Retry after a slot is released.", { retry_after: 1 });
      // Fence it before the first await: two admissions cannot evict the same query.
      await this.retireQuery(idle);
      this.logger.info("sdk_idle_evicted", { sdkSessionId: idle.sdkSessionId });
      idle.events.push({ at: now(), type: "sdk_idle_evicted", data: { sdkSessionId: idle.sdkSessionId } });
    }
  }

  private idleLives(): LiveSdk[] {
    return [...this.lives.values()].filter((live) => this.config.persistSessions && live.query && live.sdkSessionId && !live.terminal && !live.active && !live.busy && !live.starting
      && !live.pending.size && !live.handlerArrivals.size && !live.candidates.size && !live.hostResultConsumptions.size
      && !live.outbox.length && !live.backgroundTasks.size && !live.approvals.size).sort((a, b) => a.lastTouched - b.lastTouched);
  }

  private async trimIdle(): Promise<void> {
    const idle = this.idleLives();
    await Promise.all(idle.slice(0, Math.max(0, idle.length - (this.config.maxIdleSessions ?? 4))).map(async (live) => {
      await this.retireQuery(live);
      this.logger.info("sdk_idle_evicted", { sdkSessionId: live.sdkSessionId, reason: "idle-pool-limit" });
    }));
  }

  private retireQuery(live: LiveSdk): Promise<void> {
    if (live.retiring) return live.retiring;
    const query = live.query;
    const owner = live.processOwner;
    live.queryEpoch++;
    live.workflowPermits?.cancel(new BridgeError(409, "workflow_query_retired", "The native workflow query was retired"));
    if (live.workflowTimer) clearTimeout(live.workflowTimer);
    live.workflowTimer = undefined;
    live.workflowDeferredResult = undefined;
    live.inputs.close();
    live.query = undefined;
    live.loop = undefined;
    live.inputs = new InputQueue();
    let closeFailed = false;
    try { query?.close?.(); } catch { closeFailed = true; }
    live.abort?.abort();
    live.abort = undefined;
    const owned = owner && this.processes.has(owner);
    const retiring = (owner ? this.processes.stop(owner) : Promise.resolve()).then(() => {
      if (live.processOwner === owner) live.processOwner = undefined;
      if (closeFailed && !owned) throw new Error("Cannot verify native close without process ownership");
    }).finally(() => { if (live.retiring === retiring) live.retiring = undefined; });
    live.retiring = retiring;
    return retiring;
  }

  async maintain(): Promise<void> {
    await this.trimIdle();
    const owners = new Set([...this.lives.values()].filter((live) => !live.terminal && (live.query || live.starting)).flatMap((live) => live.processOwner ? [live.processOwner] : []));
    await this.processes.reap(owners);
    for (const [id, live] of this.lives) {
      if (!live.busy && !live.starting && !live.query && !live.active && !live.pending.size && !live.approvals.size
          && (!live.processOwner || !this.processes.has(live.processOwner))) this.lives.delete(id);
    }
  }

  async forget({ bridgeSessionId: sessionId }: import("./types.js").RetiredSession): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live || live.active || live.busy || live.pending.size || live.approvals.size || live.backgroundTasks.size) return;
    await this.stop(live, new BridgeError(409, "session_expired", "Retained session expired"));
    this.lives.delete(sessionId);
  }

  private async startQueryImpl(input: RuntimeRequest, live: LiveSdk): Promise<void> {
    if (this.config.nativeWorkflows && !workflowProviderAllowed(this.config)) throw new BridgeError(400, "workflow_provider_rejected", "Native workflows require an explicitly approved provider configuration.");
    const sdk = await this.loadSdk();
    const route = live.modelRoute;
    const selection = route ? route.selection : await this.ensureSelection();
    if (selection) this.selection = selection;
    if (live.terminal) throw live.terminal;
    const droidTools = (input.request.tools !== undefined ? selectDroidMcpTools(input.request.tools, this.config.desktopProfile, this.config.factoryNative) : live.catalog?.definitions() ?? [])
      .filter((tool) => controllerHostToolAllowed(this.config, tool.name));
    const names = live.names ?? new StableDroidToolNames();
    live.names = names;
    live.policyKey = queryPolicy(input, this.config);
    const epoch = live.queryEpoch;
    const workflowPermits = this.config.nativeWorkflows ? new WorkflowPermits() : undefined;
    live.workflowPermits = workflowPermits;
    const server = sdk.createSdkMcpServer({ name: "droid", version: "0.1.0", tools: [], alwaysLoad: true });
    const catalog = new DroidMcpCatalog(server, async (original, args, extra, mcpName) => {
        if (live.queryEpoch !== epoch) throw new BridgeError(409, "stale_native_query", "This native query has been retired.");
        if (live.terminal) throw live.terminal;
        if (live.hostEnding) throw new BridgeError(409, "host_session_ended", live.hostEnding);
        if (!controllerHostToolAllowed(this.config, original)) throw new BridgeError(403, "controller_tool_denied", "The read-only Factory controller cannot invoke this tool.");
        if (!live.catalog?.has(original)) throw new BridgeError(409, "tool_not_advertised", `Droid no longer advertises ${original}`);
        let workflowCallId: string | undefined;
        try {
          // Only this handler proves the native CLI and MCP server accepted the
          // invocation. Assistant tool_use output alone is merely a proposal.
          const call = workflowPermits
            ? { id: workflowPermits.claim(`mcp__droid__${mcpName}`, args, epoch, extractCallId(extra)), name: original, input: args, mcpName }
            : await this.claimCall(live, original, args, extractCallId(extra), mcpName);
          workflowCallId = call.id;
          if (workflowPermits) {
            const denied = this.toolAccessDenial(live, `mcp__droid__${mcpName}`, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? ""));
            if (denied) throw new BridgeError(409, "workflow_tool_not_authorized", denied);
            live.claimedHandlers.add(call.id);
            live.candidates.delete(call.id);
          }
          if (live.terminal) throw live.terminal;
          if (live.retiredCandidates.has(call.id)) throw new BridgeError(409, "sdk_tool_rejected", "The native SDK already completed this tool invocation");
          if (!controllerHostToolAllowed(this.config, original)) throw new BridgeError(403, "controller_tool_denied", "The read-only Factory controller cannot invoke this tool.");
          if (!live.catalog?.has(original)) throw new BridgeError(409, "tool_not_advertised", `Droid no longer advertises ${original}`);
          if (live.recoveryReceipts) {
            const recovered = live.recoveryReceipts.find(receipt => receipt.toolName === original
              && canonicalJson(receipt.input) === canonicalJson(call.input));
            const content: ContentBlock[] = recovered ? historicalHostResult(recovered) : [{ type: "text", text: RECOVERY_ONLY_DENIAL }];
            live.events.push({ at: now(), type: recovered ? "recovered_host_receipt" : "recovery_action_denied",
              data: { ...(recovered ? { originalToolUseId: recovered.toolUseId } : {}), toolUseId: call.id, toolName: original } });
            // Complete the local callback through normal mailbox bookkeeping.
            // Nothing is published to Factory, including for a reformulated action.
            live.mailbox.registerCall({ callId: call.id, originalName: original, mcpName: mcpName ?? names.toMcp(original), input: call.input });
            this.submitResults(live, [{ tool_use_id: call.id, content, is_error: !recovered }]);
            await live.mailbox.wait(call.id, this.config.toolWaitMs);
            return { content: mcpContent(content), isError: !recovered };
          }
          if (this.config.controllerHostTools && controllerHostAction(original, this.config)) {
            // Preserve the exact reviewed action even if a caller retains and
            // mutates its input object while the human question is pending.
            const approvedInput = structuredClone(call.input);
            const approved = await this.requestControllerHostActionApproval(live, original, approvedInput, mcpName ?? names.toMcp(original));
            if (!approved) return { content: [{ type: "text", text: "This Factory host action was not approved. No operation was sent to the host." }], isError: true };
            call.input = approvedInput;
          }
          // Sent to Droid with an earlier Task of its message; Droid already ran it alongside.
          const prefetched = live.prefetched.delete(call.id);
          if (!prefetched) {
            live.mailbox.registerCall({ callId: call.id, originalName: original, mcpName: mcpName ?? names.toMcp(original), input: call.input });
            live.pending.set(call.id, call);
          }
          let consumed!: () => void;
          live.hostResultConsumptions.set(call.id, { promise: new Promise<void>((resolve) => { consumed = resolve; }), resolve: () => consumed() });
          const batch = !workflowPermits && !prefetched && original === "Task" ? await this.taskBatch(live, call) : [];
          if (live.terminal) throw live.terminal;
          const waiting = live.mailbox.wait(call.id, this.config.toolWaitMs);
          if (!prefetched) {
            for (const sibling of batch) {
              live.mailbox.registerCall({ callId: sibling.id, originalName: sibling.name, mcpName: sibling.mcpName ?? names.toMcp(sibling.name), input: sibling.input });
              live.pending.set(sibling.id, sibling);
              live.prefetched.add(sibling.id);
            }
            if (batch.length) live.events.push({ at: now(), type: "task_batch", data: { toolUseIds: [call.id, ...batch.map((sibling) => sibling.id)] } });
            this.publish(live, this.makeTurn(live, [call, ...batch].map((item) => ({ type: "tool_use", id: item.id, name: item.name, input: item.input as Json })), "tool_use"));
          }
          const result = await waiting;
          if (!result.isError) await this.requestPendingWorkerApproval(live, original, call.input);
          const response = { content: mcpContent(result.content), isError: Boolean(result.isError) };
          live.hostResultConsumptions.get(call.id)?.resolve();
          live.hostResultConsumptions.delete(call.id);
          return response;
        } catch (error) {
          if (live.queryEpoch === epoch) this.stop(live, this.sdkError(error));
          throw error;
        } finally {
          if (workflowCallId) workflowPermits?.release(workflowCallId);
          this.finishDeferredWorkflow(live);
        }
      }, names);
    live.catalog = catalog;
    await catalog.update(droidTools);
    if (live.terminal) throw live.terminal;
    const subscriptionAccount = this.subscriptionAccountFor(input.session);
    live.subscriptionAccount = subscriptionAccount;
    const claudeConfig = this.claudeConfigFor(route, input.session);
    const env = subscriptionAccount
      ? buildChildEnv("subscription", { ...subscriptionAccount.env })
      : this.config.authMode === "claude-config"
      ? buildChildEnv("claude-config", process.env, undefined, { bridgeListen: `${this.config.host}:${this.config.port}`, claudeConfig })
      : sdkEnv(selection, `${this.config.host}:${this.config.port}`, this.config.authMode);
    // Project skills may run the local generator through native Bash. Bind its
    // client connection to this Bridge, not stale values in the parent shell.
    // These values stay in the process environment, never the model prompt.
    const clientHost = this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host === "::" ? "[::1]" : this.config.host;
    env.BRIDGE_CLIENT_TOKEN = this.config.clientToken;
    if (route) env.BRIDGE_MODEL_ID = route.id;
    else delete env.BRIDGE_MODEL_ID;
    env.BRIDGE_CONTROL_URL = `http://${clientHost.includes(":") && !clientHost.startsWith("[") ? `[${clientHost}]` : clientHost}:${this.config.port}`;
    // The native worker receives its provider credential, never the host
    // controller's authority or Factory lifecycle generation.
    for (const name of ["BRIDGE_ADMIN_TOKEN", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID", "BRIDGE_LAUNCH_ID"]) delete env[name];
    for (const name of Object.keys(env)) if (name.startsWith("BRIDGE_FACTORY_BINDING_")) delete env[name];
    // Subscription, anthropic-api and inherit need the user's own Claude config/login.
    // BYOK and cloud get an empty config dir so user settings cannot reroute them.
    if (this.config.authMode === "byok" || this.config.authMode === "cloud") {
      const configDir = join(this.config.dataDir, "claude-config");
      mkdirSync(configDir, { recursive: true });
      env.CLAUDE_CONFIG_DIR = configDir;
    }
    const abort = new AbortController();
    live.abort = abort;
    const processOwner = randomUUID();
    live.processOwner = processOwner;
    const options: Record<string, unknown> = {
      spawnClaudeCodeProcess: (options: import("@anthropic-ai/claude-agent-sdk").SpawnOptions) => {
        if (live.terminal || live.queryEpoch !== epoch || this.closing) throw new Error("Native query was retired before spawn");
        return this.processes.spawn(processOwner, options);
      },
      tools: { type: "preset", preset: "claude_code" }, includePartialMessages: true,
      cwd: resolveCwd(input, this.config), persistSession: this.config.persistSessions,
      ...(this.config.maxTurns > 0 ? { maxTurns: this.config.maxTurns } : {}), mcpServers: { droid: server },
      // Permit the dynamic host namespace only. Droid executes these operations
      // with its own permissions; native Claude Code builtins are not covered.
      allowedTools: ["mcp__droid__*"],
      env, permissionMode: this.config.desktopProfile || this.config.permissionMode === "ask" ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: !this.config.desktopProfile && this.config.permissionMode !== "ask", abortController: abort,
      systemPrompt: { ...buildPresetSystemPrompt(this.config.desktopProfile, this.config.nativeWorkflows, this.config.factoryNative),
        append: buildPresetSystemPrompt(this.config.desktopProfile, this.config.nativeWorkflows, this.config.factoryNative).append + (this.config.factoryNative ? "" : desktopJobPolicy(this.config))
          + (this.config.factoryNative
            ? "\nUse Factory SpawnAgent, SendMessage, ListAgents and InterruptAgent for native Workstream coordination, and Factory Task for custom Droid subagents when advertised. All actual tools run in Factory. Never delegate through factory_worker_start or other bridge worker tools. Each native Droid agent must use the configured bridge-backed custom model; never assume model inheritance or silently select a hosted model. Report blocked model configuration to the user. Give concurrent writers separate ownership and follow Factory instructions for workspaces and integration."
            : this.config.controllerHostTools
            ? "\nThis Factory controller supports ordinary folders and repositories. Use the allowed host read tools for inspection. "
              + (this.config.controllerApprovalPolicy === "bypass"
                ? "The operator disabled this bridge's extra confirmation for Factory Execute, Create and Edit. Use those advertised host tools within the user's task scope; Factory's own permissions still apply. "
                : "General filesystem operations may use Factory Execute, Create or Edit only through the exact-action human approval; never bypass it with native tools. ")
              + (this.config.controllerSpawnAgents
                ? "Use the advertised Factory tools. Delegate work the user should see and steer with SpawnAgent: each agent appears in the Workstream Agents pane, SendMessage steers it, InterruptAgent stops its current turn and ListAgents shows its state. "
                  + "Agents that use this pooled model each receive their own team1 to team8 account from this bridge. Agents start in this Workstream's folder, so give each writer separate paths or its own Git worktree and use one integration owner. "
                  + "Use factory_worker_start only when the work needs the pool's isolated Git worktree and fixed-seat queue. Pool workers do not appear in the Agents pane, so report each worker id, account and branch. Factory Task is unavailable in this controller. "
                : "Use the advertised Factory tools and delegate useful independent work through factory_worker_start in the configured worker pool. Factory Task and SpawnAgent are unavailable in this controller. Give each writer separate ownership and use one integration owner. ")
              + "The worker pool routes across its eight configured accounts. Use factory_worker_accounts to inspect actual availability and assignment counts. Keep one stable operationId for each worker assignment and reuse it after transport uncertainty. "
              + "Use bounded factory_worker_wait calls and check messages and status between waits. Do not use long shell sleeps to wait for workers. Report queue, approval, failure, cleanup and completion separately. "
              + "For an ordinary folder or a workspace the worker cannot isolate, use authorized Factory host tools. Keep all actions within the user's task and current Factory permission mode."
            : this.config.controllerReadOnly ? "\nThis Factory controller is read-only. Inspect with the allowed read tools, discover only allowed tools with ToolSearch, and use AskUser for essential missing information or new permissions. Delegate all implementation to the configured supervised worker tools. Never use Execute, Create, Edit, Task, SpawnAgent, unrelated MCP tools or native side effects." : "")
          + (this.config.desktopProfile || this.config.desktopJobs ? "\n\n" + WORKSTREAM_DECISION_POLICY
            + (this.config.factoryNative ? "\nUse Factory native messaging to steer agents and collect blocked handoffs; a finished agent turn does not by itself complete the user task." : "\nWhen a worker returns a blocked handoff, its completed attempt does not complete the user task. Collect essential answers or new permissions with AskUser and provide the actual answer in a new worker assignment.") : "") },
      canUseTool: async (name: string, toolInput: Record<string, unknown>, context?: NativePermissionContext) => live.queryEpoch === epoch
        ? this.canUseTool(live, name, toolInput, context)
        : { behavior: "deny", message: "This native query has been retired." },
    };
    if (this.config.desktopProfile || this.config.nativeWorkflows || this.config.controllerReadOnly) options.disallowedTools = [...(this.config.factoryNative ? ["Read", "LS", "Grep", "Glob"] : []), ...DESKTOP_DISALLOWED_TOOLS].filter(name => !(this.config.nativeWorkflows && !this.config.controllerReadOnly && name === "Workflow"));
    if (this.config.nativeWorkflows) {
      options.maxBudgetUsd = this.config.workflowMaxBudgetUsd;
      env.CLAUDE_CONFIG_DIR = join(this.config.dataDir, "native-workflow-config");
      mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    // Empty setting sources keep settings.json env blocks and permissions.allow
    // from bypassing this bridge. inherit keeps the CLI default (all sources).
    if (this.config.desktopProfile || this.config.authMode !== "inherit") {
      options.settingSources = [];
      options.strictMcpConfig = true;
    }
    if (this.config.authMode === "claude-config" && claudeConfig?.helper) options.settings = { apiKeyHelper: claudeConfig.helper };
    if (this.config.authMode === "anthropic-api") {
      const helper = process.env.BRIDGE_API_KEY_HELPER?.trim();
      if (helper) {
        if (!isAbsolute(helper)) throw new BridgeError(400, "invalid_api_key_helper", "BRIDGE_API_KEY_HELPER must be an absolute path.");
        // SDK 0.3.300 loads this object as the --settings flag layer, above filesystem settings.
        options.settings = { apiKeyHelper: helper };
      }
    }
    if (this.config.nativeWorkflows) options.settings = { ...(options.settings as object ?? {}), enableWorkflows: true, ultracode: true, workflowSizeGuideline: "small" };
    // The host can change its tool capability between turns without rebuilding
    // native history. Check at invocation, including under native bypass mode.
    options.hooks = { PreToolUse: [{ hooks: [async (hook: { tool_name?: string; tool_use_id?: string; tool_input?: unknown }) => {
        if (live.queryEpoch !== epoch) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This native query has been retired." } };
        if (live.terminal) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The host session has ended." } };
        if (recoveryActionDenied(live, hook.tool_name, hook.tool_input)) return { hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: RECOVERY_ONLY_DENIAL } };
        if (this.config.controllerReadOnly && (!hook.tool_name || !isDroidMcpName(hook.tool_name) && !["Read", "Glob", "Grep", "LS"].includes(hook.tool_name))) {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The Factory controller is read-only; delegate implementation to its supervised workers." } };
        }
        if (this.config.controllerReadOnly && hook.tool_name?.startsWith("mcp__droid__")) {
          const original = live.names?.toOriginal(hook.tool_name.slice("mcp__droid__".length));
          if (!original || !controllerHostToolAllowed(this.config, original)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The Factory controller cannot invoke this host tool." } };
        }
        if (hook.tool_name && !isDroidMcpName(hook.tool_name)) live.nativeCallsThisRequest = true;
        // Droid already ran a batched Task; its handler must return what Droid reported.
        const prefetched = hook.tool_use_id !== undefined && live.prefetched.has(hook.tool_use_id);
        if (live.turnHandoff && !prefetched) {
          const cancelled = live.turnHandoff.reason === "cancelled";
          live.events.push({ at: now(), type: cancelled ? "cancelled_turn_tool_denied" : "steering_turn_tool_denied", data: { toolName: hook.tool_name, toolUseId: hook.tool_use_id } });
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: cancelled ? CANCELLED_TURN_DENIAL : STEERING_TURN_DENIAL } };
        }
        if (this.config.nativeWorkflows && hook.tool_name === "Workflow") {
          if (!workflowAllowed(this.config, live.current?.request, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? "") ?? live.current?.factoryPermissionMode)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Workflow execution is not authorised in this host mode." } };
          const invalid = validateWorkflowInput((hook.tool_input ?? {}) as Record<string, unknown>);
          if (invalid) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: invalid } };
          // Workflow may be classified safe by the native permission engine.
          // Always ask the Factory controller here, before the script can run.
          const decision = await this.canUseTool(live, "Workflow", (hook.tool_input ?? {}) as Record<string, unknown>, { toolUseID: hook.tool_use_id });
          if (decision.behavior !== "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.message } };
          if (!live.workflowTimer) live.workflowTimer = setTimeout(() => { void this.stop(live, new BridgeError(504, "workflow_deadline", "Native workflow exceeded its absolute deadline")); }, this.config.workflowMaxMs);
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: decision.updatedInput ?? hook.tool_input } };
        }
        if (this.config.nativeWorkflows && hook.tool_name?.startsWith("mcp__droid__")) {
          const denied = this.toolAccessDenial(live, hook.tool_name, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? ""));
          if (denied) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denied } };
          try { await workflowPermits!.acquire(hook.tool_use_id, hook.tool_name, hook.tool_input, epoch); }
          catch { return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Workflow action identity unavailable or cancelled" } }; }
          return {};
        }
        if ((this.config.desktopProfile || this.config.nativeWorkflows) && hook.tool_name && !hook.tool_name.startsWith("mcp__droid__") && !["Read", "Glob", "Grep", "LS"].includes(hook.tool_name)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DESKTOP_APPROVAL_DENIAL } };
        const denial = prefetched ? undefined : this.toolAccessDenial(live, hook.tool_name, this.control?.factoryPermissionMode?.(input.session.bridgeSessionId));
        if (!denial) return {};
        const data = { sessionId: input.session.bridgeSessionId, sdkSessionId: live.sdkSessionId, toolName: hook.tool_name, toolUseId: hook.tool_use_id, reason: denial };
        live.events.push({ at: now(), type: "host_tool_access_denied", data });
        this.logger.info("host_tool_access_denied", data);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denial } };
      }] }] };
    if (route?.model) options.model = route.model;
    else if (selection) options.model = selection.provider.model;
    else if (process.env.ANTHROPIC_MODEL) options.model = process.env.ANTHROPIC_MODEL;
    const reasoning = claudeReasoningOptions(droidReasoningLevel(input.request));
    if (reasoning?.effort) options.effort = reasoning.effort;
    else if (this.config.nativeWorkflows && !reasoning) options.effort = "medium";
    if (reasoning?.thinking) options.thinking = reasoning.thinking;
    live.reasoningKey = claudeReasoningKey(input.request);
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;
    if (live.sdkSessionId) options.resume = live.sdkSessionId;
    const expectedResumeId = route ? live.sdkSessionId : undefined;
    const queryStart = { resumed: Boolean(live.sdkSessionId), sdkSessionId: live.sdkSessionId, droidMcp: catalog.definitions().map((tool) => tool.name), effort: options.effort ?? null, thinking: reasoning?.thinking?.type ?? null };
    live.events.push({ at: now(), type: "sdk_query_start", data: queryStart });
    this.logger.info("sdk_query_options", queryStart);
    try {
      if (this.config.nativeWorkflows) options.pathToClaudeCodeExecutable = assertNativeWorkflowSupport().executable;
      live.query = sdk.query({ prompt: live.inputs, options });
      // Iterate the Query itself. Its close() owns process shutdown; never call raw generator.return().
      live.loop = this.consume(live, live.query, live.queryEpoch, expectedResumeId);
      // Gate before this method returns, so handle() has not pushed a user message yet.
      await this.verifyDeclaredAuth(live, input.session.bridgeSessionId);
    } catch (error) {
      this.stop(live, this.sdkError(error));
      throw this.sdkError(error);
    }
  }

  private async verifyDeclaredAuth(live: LiveSdk, sessionId: string): Promise<void> {
    const mode = this.config.authMode;
    if (mode === "inherit") {
      void this.observeInheritAuth(live);
      return;
    }
    if (mode !== "subscription" && mode !== "anthropic-api" && mode !== "claude-config") return;
    const query = live.query;
    if (!query?.accountInfo) {
      this.rejectAuth(live, mode, "unknown", `Declared BRIDGE_AUTH=${mode} but the SDK query does not expose accountInfo(). Refusing to send a prompt.`);
      return;
    }
    const timeoutMs = Math.min(this.config.sdkStartTimeoutMs ?? SDK_START_TIMEOUT_MS, Math.max(1, this.config.requestTimeoutMs));
    const started = Date.now();
    let info: Record<string, unknown>;
    try {
      info = await withTimeout(query.accountInfo(), timeoutMs);
    } catch (error) {
      if (error instanceof SdkStartTimeout) {
        // Not an authentication result: keep the last real verification.
        this.logger.warn("sdk_start_timeout", { mode, timeoutMs, sessionId });
        this.stop(live, error);
        throw error;
      }
      const detail = error instanceof Error ? error.message : "accountInfo failed";
      const safe = mode === "claude-config" || /sk-ant-|Bearer /i.test(detail) ? "accountInfo failed or timed out" : detail;
      this.rejectAuth(live, mode, "unknown", `Declared BRIDGE_AUTH=${mode} but account verification did not succeed: ${safe}`);
      return;
    }
    const observed = observationFrom(info);
    live.accountSnapshot = observed;
    const expectedEmail = live.subscriptionAccount?.expectedEmail ?? this.config.subscriptionExpectedEmail;
    if (mode === "subscription" && expectedEmail) {
      try { verifyNativeSubscription(info, { email: expectedEmail }); }
      catch { this.rejectAuth(live, mode, "unknown", "The native subscription identity does not match this controller's assigned Team account. Refusing to send a prompt."); }
    }
    const email = maskEmail(stringField(info, "email"));
    const classification = classifyAuth(observed, live.initApiKeySource);
    const profile = this.claudeProfileFor(live.modelRoute, live.current?.session);
    this.rememberAuth(mode, classification, observed, email, Date.now() - started, profile?.id ?? live.current?.session.claudeAccount);
    if (mode === "claude-config") {
      const claudeConfig = profile?.config ?? this.config.claudeConfig;
      if ((!claudeConfig || claudeConfigNeedsLogin(claudeConfig)) && classification.kind === "unknown") this.rejectAuth(live, mode, "unknown", CLAUDE_LOGIN_REQUIRED);
      // A profile must answer as the account recorded in its own directory, never fall back to the default login.
      const reported = stringField(info, "email")?.toLowerCase();
      if (profile?.email && reported !== profile.email) {
        this.rejectAuth(live, mode, classification.kind, `Claude profile ${profile.id} reported a different account (${maskEmail(reported) ?? "none"}) than its directory records (${maskEmail(profile.email)}). Refusing to send a prompt.`);
      }
      return;
    }
    if (classification.kind !== mode) {
      const error = new BridgeError(401, "auth_mode_mismatch", mismatchMessage(mode, classification, observed));
      this.stop(live, error);
      throw error;
    }
  }

  private observeInheritAuth(live: LiveSdk): void {
    const query = live.query;
    if (!query?.accountInfo) return;
    const timeoutMs = Math.min(this.config.sdkStartTimeoutMs ?? SDK_START_TIMEOUT_MS, Math.max(1, this.config.requestTimeoutMs));
    void withTimeout(query.accountInfo(), timeoutMs).then((info) => {
      if (live.terminal) return;
      const observed = observationFrom(info);
      live.accountSnapshot = observed;
      const classification = classifyAuth(observed, live.initApiKeySource);
      this.rememberAuth("inherit", classification, observed, maskEmail(stringField(info, "email")));
    }).catch(() => undefined);
  }

  /** The session's assigned account wins (pool or limit failover); otherwise the entry's own account. */
  private claudeProfileFor(route: ModelRoute | undefined, session: { claudeAccount?: string } | undefined) {
    if (this.config.controllerPool) return undefined;
    const account = session?.claudeAccount ?? route?.claudeProfile;
    if (account === POOL_PROFILE) throw new BridgeError(500, "pool_unassigned", "This pool session has no Claude account assigned.");
    if (!account || account === PERSONAL_ACCOUNT) return undefined;
    const profile = this.config.claudeProfiles?.find((item) => item.id === account);
    if (!profile) throw new BridgeError(400, "unknown_model", `Claude profile ${account} is not configured on this Bridge.`);
    return profile;
  }

  private claudeConfigFor(route: ModelRoute | undefined, session: { claudeAccount?: string } | undefined) {
    return this.claudeProfileFor(route, session)?.config ?? this.config.claudeConfig;
  }

  private subscriptionAccountFor(session: { claudeAccount?: string; nativeGeneration?: number }): SubscriptionAccount | undefined {
    if (!this.config.controllerPool) return undefined;
    const account = this.config.subscriptionAccounts?.find(item => item.profile === session.claudeAccount);
    if (!account || !Number.isSafeInteger(session.nativeGeneration) || session.nativeGeneration! < 0 || session.nativeGeneration! > 1_000_000) {
      throw new BridgeError(500, "subscription_pool_unassigned", "The controller has no valid privately configured subscription generation.");
    }
    return account;
  }

  private rememberAuth(mode: BridgeConfig["authMode"], classification: AuthClassification, observed: AuthObservation, email?: string, startupMs?: number, claudeProfile?: string): void {
    const record: AuthVerification = {
      mode, kind: classification.kind, reason: classification.reason,
      subscriptionType: observed.subscriptionType, apiKeySource: observed.apiKeySource, tokenSource: observed.tokenSource,
      email, at: now(),
    };
    this.authVerification = record;
    const gated = mode === "subscription" || mode === "anthropic-api";
    const ok = mode === "claude-config" ? Boolean(this.config.claudeConfig && !claudeConfigNeedsLogin(this.config.claudeConfig)) || classification.kind !== "unknown" : gated ? classification.kind === mode : true;
    this.logger.info("auth_verified", { ...record, email: undefined, ok, ...startupMs !== undefined && { startupMs }, ...claudeProfile && { claudeProfile } });
  }

  private rejectAuth(live: LiveSdk, mode: BridgeConfig["authMode"], kind: AuthClassification["kind"], message: string): never {
    const error = new BridgeError(401, "auth_mode_mismatch", message);
    this.authVerification = { mode, kind, at: now(), reason: message };
    this.logger.info("auth_verified", { mode, kind, ok: false, at: this.authVerification.at });
    this.stop(live, error);
    throw error;
  }

  private recheckInitAuth(live: LiveSdk): void {
    const mode = this.config.authMode;
    if (!live.accountSnapshot || (mode !== "subscription" && mode !== "anthropic-api" && mode !== "inherit")) return;
    const classification = classifyAuth(live.accountSnapshot, live.initApiKeySource);
    const email = this.authVerification?.email;
    this.rememberAuth(mode, classification, live.accountSnapshot, email);
    if ((mode === "subscription" || mode === "anthropic-api") && classification.kind !== mode) {
      this.stop(live, new BridgeError(401, "auth_mode_mismatch", mismatchMessage(mode, classification, live.accountSnapshot)));
    }
  }

  private async canUseTool(live: LiveSdk, name: string, input: Record<string, unknown>, context: NativePermissionContext = {}): Promise<RuntimePermissionDecision> {
    if (recoveryActionDenied(live, name, input)) return { behavior: "deny", message: RECOVERY_ONLY_DENIAL };
    if (this.config.controllerReadOnly && !isDroidMcpName(name) && !["Read", "Glob", "Grep", "LS"].includes(name)) {
      return { behavior: "deny", message: "The Factory controller is read-only; delegate implementation to its supervised workers." };
    }
    const nativeWorkflow = name === "Workflow" && workflowAllowed(this.config, live.current?.request, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? "") ?? live.current?.factoryPermissionMode);
    const workflowInvalid = nativeWorkflow ? validateWorkflowInput(input) : undefined;
    if (workflowInvalid) return { behavior: "deny", message: workflowInvalid };
    if ((this.config.desktopProfile || this.config.nativeWorkflows) && !nativeWorkflow) return { behavior: "deny", message: ["Read", "Glob", "Grep", "LS"].includes(name) ? DESKTOP_READ_DENIAL : DESKTOP_APPROVAL_DENIAL };
    if (live.terminal) return { behavior: "deny", message: "Session is closed" };
    const denial = nativeWorkflow ? undefined : this.toolAccessDenial(live, name, live.current && this.control?.factoryPermissionMode?.(live.current.session.bridgeSessionId));
    if (denial) return { behavior: "deny", message: denial };
    const control = this.control;
    if (!control || !live.current) {
      live.events.push({ at: now(), type: "permission_denied", data: { toolName: name, reason: "approval_channel_unavailable" } });
      return { behavior: "deny", message: "No approval controller is connected. Open the bridge approvals client and retry this operation." };
    }
    const approval = new AbortController();
    const epoch = live.queryEpoch;
    live.approvals.add(approval);
    this.notifyApprovals(live);
    const cancel = () => approval.abort();
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) approval.abort();
    // Approvals wait on a human, not on the model: they have their own limit.
    const timer = setTimeout(cancel, this.config.approvalTimeoutMs);
    timer.unref();
    let interrupted!: () => void;
    const aborted = new Promise<RuntimePermissionDecision>((resolve) => {
      interrupted = () => resolve({ behavior: "deny", message: "Native approval expired or was cancelled" });
      approval.signal.addEventListener("abort", interrupted, { once: true });
      if (approval.signal.aborted) interrupted();
    });
    const details: RuntimeApprovalRequest = {
      bridgeSessionId: live.current.session.bridgeSessionId, sdkSessionId: live.sdkSessionId,
      toolName: name, input: structuredClone(input), signal: approval.signal,
      toolUseId: context.toolUseID, requestId: context.requestId, agentId: context.agentID,
      title: context.title, description: context.description, decisionReason: context.decisionReason,
      blockedPath: context.blockedPath, defaultToNo: context.defaultToNo, suppressAlwaysAllowRule: context.suppressAlwaysAllowRule,
    };
    live.events.push({ at: now(), type: "permission_requested", data: { toolName: name, toolUseId: context.toolUseID, requestId: context.requestId } });
    try {
      if (approval.signal.aborted) return await aborted;
      const decision = await Promise.race([
        nativeWorkflow && this.config.desktopJobs
          ? this.requestDesktopWorkflowApproval(live, input, approval.signal)
          : control.requestApproval(details), aborted,
      ]);
      if (live.terminal || live.queryEpoch !== epoch || approval.signal.aborted || this.control !== control) {
        return { behavior: "deny", message: "Native approval is no longer live" };
      }
      if (nativeWorkflow && this.config.desktopJobs && live.turnHandoff) {
        return { behavior: "deny", message: "The Workflow approval was superseded by new Factory steering." };
      }
      const currentDenial = nativeWorkflow
        ? (workflowAllowed(this.config, live.current?.request, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? "") ?? live.current?.factoryPermissionMode) ? undefined : "Workflow permission changed while approval was pending")
        : this.toolAccessDenial(live, name, live.current && this.control?.factoryPermissionMode?.(live.current.session.bridgeSessionId));
      if (currentDenial) return { behavior: "deny", message: currentDenial };
      if (!decision || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
        return { behavior: "deny", message: "The approval controller returned an invalid decision" };
      }
      live.events.push({ at: now(), type: decision.behavior === "allow" ? "permission_allowed" : "permission_denied", data: { toolName: name, toolUseId: context.toolUseID } });
      if (nativeWorkflow && decision.behavior === "allow") {
        const invalid = validateWorkflowInput(decision.updatedInput ?? input);
        if (invalid) return { behavior: "deny", message: invalid };
      }
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
        : { behavior: "deny", message: decision.message || "The operation was denied" };
    } catch (error) {
      live.events.push({ at: now(), type: "permission_denied", data: { toolName: name, reason: "approval_controller_error" } });
      this.logger.warn("approval_controller_error", { sessionId: details.bridgeSessionId, toolName: name, error: error instanceof Error ? error.message : String(error) });
      return { behavior: "deny", message: "The approval controller disconnected or failed" };
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
      approval.signal.removeEventListener("abort", interrupted);
      live.approvals.delete(approval);
      this.notifyApprovals(live);
      approval.abort();
    }
  }

  private requestDesktopWorkflowApproval(live: LiveSdk, input: Record<string, unknown>, signal: AbortSignal): Promise<RuntimePermissionDecision> {
    if (!live.current) return Promise.resolve({ behavior: "deny", message: "No Factory session is active." });
    const question = desktopWorkflowQuestion(live.current.request, resolveCwd(live.current, this.config), input);
    if (!question) return Promise.resolve({ behavior: "deny", message: "A supported Factory AskUser tool is required for in-app Workflow approval." });
    return this.requestDesktopActionApproval(live, question, signal);
  }

  /** Host filesystem actions use the trusted operator approval policy.
   * Native Claude tools remain disabled; both policies enforce the same live
   * query, workspace, Factory mode and advertised-call checks. */
  private async requestControllerHostActionApproval(live: LiveSdk, original: string, input: unknown, mcpName: string): Promise<boolean> {
    if (!this.config.controllerHostTools || !controllerHostAction(original, this.config) || !live.current || !this.control) return false;
    const epoch = live.queryEpoch, control = this.control, cwd = resolveCwd(live.current, this.config);
    const approval = new AbortController();
    const current = (): boolean => !approval.signal.aborted && !live.terminal && !live.hostEnding && !live.turnHandoff
      && live.queryEpoch === epoch && this.control === control && !!live.current
      && resolveCwd(live.current, this.config) === cwd
      && (this.config.factoryNative || (control.factoryPermissionMode?.(live.current.session.bridgeSessionId) ?? live.current.factoryPermissionMode) !== "spec")
      && !this.toolAccessDenial(live, `mcp__droid__${mcpName}`, control.factoryPermissionMode?.(live.current.session.bridgeSessionId));
    if (this.config.controllerApprovalPolicy === "bypass") {
      // Bypass only this bridge-owned question. Factory still receives the
      // exact snapshotted action and applies its own native permissions.
      const allowed = current() && !!live.catalog?.accepts(original, input);
      live.events.push({ at: now(), type: "controller_host_action_decision", data: {
        toolName: original, decision: allowed ? "allow" : "deny", approvalPolicy: "bypass",
      } });
      return allowed;
    }
    const timer = setTimeout(() => approval.abort(), this.config.approvalTimeoutMs);
    timer.unref();
    live.approvals.add(approval); this.notifyApprovals(live);
    let allowed = false;
    try {
      if (!current()) return false;
      const request = live.current!.request.tools === undefined
        ? { ...live.current!.request, tools: live.catalog?.definitions() } : live.current!.request;
      const question = desktopActionQuestion(request, `Allow this one Factory host action ${original} in ${JSON.stringify(cwd)}?`, input);
      if (!question) return false;
      const answer = await this.requestDesktopActionApproval(live, question, approval.signal);
      allowed = answer.behavior === "allow" && current() && !!live.catalog?.accepts(original, input);
      return allowed;
    } catch {
      return false;
    } finally {
      live.events.push({ at: now(), type: "controller_host_action_decision", data: { toolName: original, decision: allowed ? "allow" : "deny" } });
      clearTimeout(timer); live.approvals.delete(approval); this.notifyApprovals(live); approval.abort();
    }
  }

  private requestDesktopActionApproval(live: LiveSdk, question: DesktopWorkflowQuestion, signal: AbortSignal): Promise<RuntimePermissionDecision> {
    if (!live.current || live.pending.size || [...live.desktopApprovals.values()].some((item) => item.resolve)) {
      return Promise.resolve({ behavior: "deny", message: "Finish pending Factory tools before requesting action approval." });
    }
    for (const [id, receipt] of live.desktopApprovals) {
      if (live.desktopApprovals.size < 256) break;
      if (!receipt.resolve) {
        live.desktopApprovals.delete(id);
        live.resultFingerprints.delete(id);
      }
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: RuntimePermissionDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        const receipt = live.desktopApprovals.get(question.id);
        if (receipt) receipt.resolve = undefined;
        live.pending.delete(question.id);
        resolve(decision);
      };
      const abort = (): void => finish({ behavior: "deny", message: "Factory action approval expired or was cancelled." });
      live.desktopApprovals.set(question.id, { question, resolve: finish });
      live.pending.set(question.id, { id: question.id, name: "AskUser", input: question.input });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      live.events.push({ at: now(), type: "desktop_workflow_approval_requested", data: { toolUseId: question.id } });
      this.publish(live, this.makeTurn(live, [{ type: "tool_use", id: question.id, name: "AskUser", input: question.input as Json }], "tool_use"));
    });
  }

  /** A model-visible status result is never authority to choose or approve an action. */
  private async requestPendingWorkerApproval(live: LiveSdk, original: string, input: unknown): Promise<void> {
    const path = this.config.workerControlFile, prefix = this.config.workerMcpPrefix;
    if (!path || !prefix || ![`${prefix}factory_worker_status`, `${prefix}factory_worker_wait`].includes(original)
        || !input || typeof input !== "object" || Array.isArray(input)
        || typeof (input as Record<string, unknown>).id !== "string" || !live.current || !this.control) return;
    const workerId = (input as { id: string }).id, epoch = live.queryEpoch, control = this.control;
    const approval = new AbortController();
    const timer = setTimeout(() => approval.abort(), this.config.approvalTimeoutMs);
    timer.unref();
    live.approvals.add(approval);
    this.notifyApprovals(live);
    try {
      const pending = await readPendingWorkerApprovals(path, workerId, approval.signal);
      const action = pending[0];
      if (!action) return;
      const current = (): boolean => !approval.signal.aborted && !live.terminal && !live.hostEnding
        && live.queryEpoch === epoch && this.control === control && !live.turnHandoff
        && (control.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? "") ?? live.current?.factoryPermissionMode) !== "spec";
      let decision: "allow" | "deny" = "deny";
      if (current()) {
        const request = live.current!.request.tools === undefined
          ? { ...live.current!.request, tools: live.catalog?.definitions() } : live.current!.request;
        const question = desktopActionQuestion(request,
          `Allow this one supervised worker action ${action.toolName} for ${workerId}?`, action.input);
        if (question) {
          const answer = await this.requestDesktopActionApproval(live, question, approval.signal);
          if (answer.behavior === "allow" && current()) decision = "allow";
        }
      }
      if (!approval.signal.aborted) await decideWorkerApproval(path, workerId, action, decision, approval.signal);
      live.events.push({ at: now(), type: "worker_action_decision", data: { workerId, approvalId: action.id, decision } });
    } catch {
      // No retries and no credential/provider details: an uncertain response cannot grant a new action.
      live.events.push({ at: now(), type: "worker_action_decision_unavailable", data: { workerId } });
    } finally {
      clearTimeout(timer);
      live.approvals.delete(approval);
      this.notifyApprovals(live);
      approval.abort();
    }
  }

  /** Report how many approvals are pending, so the idle limit can pause while a human decides. */
  private notifyApprovals(live: LiveSdk): void {
    const pending = live.approvals.size;
    live.watchdog?.setPaused(pending > 0);
    live.sink?.approvalsPending?.(pending);
  }

  private claimCall(live: LiveSdk, name: string, input: Record<string, unknown>, callId?: string, mcpName?: string): Promise<DroidCall> {
    if (live.terminal) return Promise.reject(live.terminal);
    if (callId && (live.claimedHandlers.has(callId) || live.retiredCandidates.has(callId))) {
      return Promise.reject(new BridgeError(409, "duplicate_tool_handler", "The SDK tool invocation was already handled or rejected"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => arrival.reject(new BridgeError(504, "sdk_tool_handoff_timeout", `No matching SDK tool_use arrived for ${name}`)), Math.min(this.config.requestTimeoutMs, this.config.toolWaitMs));
      const arrival: HandlerArrival = {
        name, input, callId, mcpName,
        resolve: (call) => { clearTimeout(timer); live.handlerArrivals.delete(arrival); resolve(call); },
        reject: (error) => { clearTimeout(timer); live.handlerArrivals.delete(arrival); reject(error); },
      };
      live.handlerArrivals.add(arrival);
      this.matchHandlers(live);
    });
  }

  private matchHandlers(live: LiveSdk): void {
    for (const arrival of [...live.handlerArrivals]) {
      const candidates = [...live.candidates.values()].filter((call) =>
        !live.claimedHandlers.has(call.id) && call.name === arrival.name
        && (!arrival.callId || call.id === arrival.callId)
        && (!arrival.mcpName || call.mcpName === arrival.mcpName)
        && canonicalJson(call.input) === canonicalJson(arrival.input));
      const rivals = [...live.handlerArrivals].filter((other) => other !== arrival && !other.callId && !arrival.callId
        && other.name === arrival.name && other.mcpName === arrival.mcpName && canonicalJson(other.input) === canonicalJson(arrival.input));
      if (candidates.length > 1 || (candidates.length && rivals.length)) {
        const error = new BridgeError(409, "ambiguous_tool_call", `Cannot safely associate the SDK callback for ${arrival.name} with one tool call`);
        this.stop(live, error);
        return;
      }
      const call = candidates[0];
      if (!call) continue; // SDK control requests can arrive before assistant output.
      live.candidates.delete(call.id);
      live.claimedHandlers.add(call.id);
      arrival.resolve(call);
    }
  }

  /**
   * Claude Code runs Droid's MCP tools one after another, since none is read-only.
   * Its own Agent tool starts subagents together, and Droid runs the Task calls
   * of one response concurrently. So when a Task is invoked, wait for its message
   * to finish streaming, then hand Droid the Task calls that follow it there
   * without another tool between them. Each still reaches Claude Code through its
   * own handler, in order, and gets the result Droid returned for it. A call this
   * session would refuse, or whose input its handler would reject, ends the batch.
   */
  private taskBatch(live: LiveSdk, first: DroidCall): Promise<DroidCall[]> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (batch: DroidCall[]): void => {
        if (timer) clearTimeout(timer);
        live.batchChecks.delete(check);
        resolve(batch);
      };
      const check = (): void => {
        const turn = live.assistantTurn;
        if (live.terminal || !first.messageId || turn?.id !== first.messageId) return finish([]);
        if (!turn.stopped) return;
        const index = turn.toolUses.findIndex((item) => item.id === first.id);
        if (index < 0) return finish([]);
        const batch: DroidCall[] = [];
        for (const use of turn.toolUses.slice(index + 1)) {
          if (!isDroidMcpName(use.name) || live.names?.toOriginal(use.name.replace(/^mcp__droid__/, "")) !== "Task") break;
          // Each block also arrives as its own assistant message; wait for this one's input.
          if (!turn.seen.has(use.id)) return;
          const call = live.candidates.get(use.id);
          if (!call || !this.mayPrefetch(live, call)) break;
          batch.push(call);
        }
        finish(batch);
      };
      timer = setTimeout(() => finish([]), TASK_BATCH_WAIT_MS);
      live.batchChecks.add(check);
      check();
    });
  }

  private mayPrefetch(live: LiveSdk, call: DroidCall): boolean {
    return !live.turnHandoff && !live.claimedHandlers.has(call.id) && !live.mailbox.hasCall(call.id)
      && Boolean(live.catalog?.accepts(call.name, call.input))
      && !this.toolAccessDenial(live, `mcp__droid__${call.mcpName}`, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? ""));
  }

  private toolAccessDenial(live: LiveSdk, name: string | undefined, factoryPermissionMode?: string): string | undefined {
    if (this.config.factoryNative && !name?.startsWith("mcp__droid__")) return "BRIDGE_FACTORY_NATIVE: All tools execute in Factory. Use the advertised Factory MCP tools, including for reads.";
    if (this.config.controllerReadOnly) {
      const original = name?.startsWith("mcp__droid__") ? live.names?.toOriginal(name.slice("mcp__droid__".length)) : name;
      if (!original || !controllerHostToolAllowed(this.config, original)) return "BRIDGE_CONTROLLER_READ_ONLY: This tool is outside the controller's read-only and supervised-worker allowlist.";
      if (this.config.controllerHostTools && !this.config.factoryNative && !["Read", "LS", "Grep", "Glob", "ToolSearch", "AskUser", "ExitSpecMode"].includes(original)
          && (factoryPermissionMode ?? live.current?.factoryPermissionMode) === "spec") {
        return "BRIDGE_FACTORY_SPEC_READ_ONLY: Leave Factory spec mode before authorizing a mutating host action.";
      }
    }
    return toolAccessDenial(live, name, factoryPermissionMode);
  }

  private trackAssistantTurn(live: LiveSdk, message: Record<string, unknown>): void {
    const event = message.event as { type?: string; message?: { id?: unknown }; content_block?: { type?: string; id?: unknown; name?: unknown } } | undefined;
    if (event?.type === "message_start") {
      live.assistantTurn = typeof event.message?.id === "string" ? { id: event.message.id, toolUses: [], seen: new Set(), stopped: false } : undefined;
    } else if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const { id, name } = event.content_block;
      if (live.assistantTurn && typeof id === "string" && typeof name === "string") live.assistantTurn.toolUses.push({ id, name });
    } else if (event?.type === "message_stop" && live.assistantTurn) {
      live.assistantTurn.stopped = true;
      this.settleBatches(live);
    }
  }

  private settleBatches(live: LiveSdk): void {
    for (const check of [...live.batchChecks]) check();
  }

  private retireNativeToolResults(live: LiveSdk, message: Record<string, unknown>): void {
    const body = message.message as { content?: unknown } | undefined;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const id = block.tool_use_id;
      live.candidates.delete(id);
      live.retiredCandidates.add(id);
      if (live.prefetched.delete(id)) live.events.push({ at: now(), type: "task_batch_unclaimed", data: { toolUseId: id } });
      for (const arrival of [...live.handlerArrivals]) {
        if (arrival.callId === id) arrival.reject(new BridgeError(409, "sdk_tool_rejected", "The native SDK rejected this tool invocation before handoff"));
      }
      if (live.pending.has(id)) throw new BridgeError(502, "sdk_tool_interrupted", "The native SDK completed a Droid tool before its external result arrived; do not replay it");
      live.workflowPermits?.release(id);
    }
  }

  private async consume(live: LiveSdk, iterator: AsyncIterable<Record<string, unknown>>, epoch: number, expectedResumeId?: string): Promise<void> {
    try {
      // Official Query.next()/return() manage its process; its raw iterator's
      // return() can remain parked waiting for another streaming-input turn.
      const query = iterator as AsyncIterable<Record<string, unknown>> & Partial<AsyncIterator<Record<string, unknown>>>;
      const source = typeof query.next === "function"
        ? { [Symbol.asyncIterator]: () => query as AsyncIterator<Record<string, unknown>> }
        : iterator;
      for await (const rawMessage of source) {
        let message = rawMessage;
        if (live.terminal || live.queryEpoch !== epoch) return;
        if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info as { status?: unknown; resetsAt?: unknown } | undefined;
          if (info?.status === "rejected") {
            const reset = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) ? info.resetsAt : undefined;
            throw new BridgeError(429, "rate_limit_error", "The native subscription usage limit was reached.", {
              usage_limit: true, ...(reset === undefined ? {} : { retry_after: Math.max(1, Math.ceil(reset - Date.now() / 1000)) }),
            });
          }
        }
        if (message.type === "system" && message.subtype === "api_retry" && (message.error_status === 429 || message.error_status === 529)) {
          const retryAfter = typeof message.retry_delay_ms === "number" && Number.isFinite(message.retry_delay_ms) && message.retry_delay_ms >= 0
            ? Math.max(1, Math.ceil(message.retry_delay_ms / 1000)) : undefined;
          const heldForNativeWork = !this.coldImportSafe(live);
          live.upstreamBackoff = { at: now(), status: message.error_status, retryAfter, heldForNativeWork };
          this.logger.warn("upstream_retry", { status: message.error_status, attempt: message.attempt, retryAfter, heldForNativeWork });
          if (!heldForNativeWork) {
            const mapped = upstreamError({ status: message.error_status })!;
            throw new BridgeError(mapped.status, mapped.code, mapped.message, retryAfter === undefined ? {} : { retry_after: retryAfter });
          }
        } else live.upstreamBackoff = undefined;
        if (message.type === "assistant" && !message.parent_tool_use_id && typeof message.error === "string" && ASSISTANT_ERRORS.has(message.error)) {
          live.failure = { ...live.failure, assistantError: message.error };
        }
        if (message.type === "assistant" && message.error) {
          const mapped = upstreamError(message.error === "rate_limit" ? "rate_limit_error" : message.error === "overloaded" ? "overloaded_error" : extractText(message));
          if (mapped) throw message.error === "rate_limit" ? usageLimitError(mapped, extractText(message)) : mapped;
        }
        live.watchdog?.touch();
        live.sink?.activity?.();
        if (message.type === "system" && message.subtype === "init" && typeof message.apiKeySource === "string" && !live.initApiKeySource) {
          live.initApiKeySource = message.apiKeySource;
          this.recheckInitAuth(live);
          if (live.terminal) return;
        }
        if (typeof message.session_id === "string") {
          if (expectedResumeId && !message.parent_tool_use_id && message.session_id !== expectedResumeId) {
            throw new BridgeError(502, "sdk_resume_identity_changed", "The SDK did not resume the requested native session; refusing to continue without its history.");
          }
          if (!message.parent_tool_use_id) live.sdkSessionId = message.session_id;
        }
        const event = { at: now(), type: String(message.subtype === "compact_boundary" ? "compact_boundary" : message.type ?? "sdk"), data: summarizeSdk(message) };
        live.events.push(event);
        if (live.events.length > 1000) live.events.splice(0, live.events.length - 1000);
        if (message.subtype === "compact_boundary" && message.compact_metadata && typeof message.compact_metadata === "object") {
          live.compactMetadata = structuredClone(message.compact_metadata as Record<string, unknown>);
          this.logger.info("sdk_compact_boundary", { sdkSessionId: live.sdkSessionId, ...live.compactMetadata });
        }
        this.noteUsage(live, message);
        if (message.type === "system" && message.subtype === "task_started" && typeof message.task_id === "string") live.backgroundTasks.add(message.task_id);
        if (message.type === "system" && message.subtype === "task_notification" && typeof message.task_id === "string") {
          live.backgroundTasks.delete(message.task_id);
          if (this.config.nativeWorkflows && ["failed", "cancelled", "stopped"].includes(String(message.status))) throw new BridgeError(502, "workflow_child_failed", "Native workflow child did not complete successfully");
          if (this.config.nativeWorkflows && !live.backgroundTasks.size && !live.pending.size && live.workflowDeferredResult) {
            message = live.workflowDeferredResult;
            live.workflowDeferredResult = undefined;
          }
        }
        if ((message.type === "stream_event" || (message.type === "assistant" && !message.error)) && !message.parent_tool_use_id && live.active) live.phase = "responding";
        if (message.type === "stream_event") {
          if (message.parent_tool_use_id) continue;
          this.trackAssistantTurn(live, message);
          // Separate text blocks (before and after a tool call, say) would otherwise
          // run together in the one text stream. Deltas of one block stay joined.
          if (startsTextBlock(message) && live.streamed) live.textBreak = true;
          const text = streamTextDelta(message);
          if (text) {
            const chunk = live.textBreak ? `\n\n${text}` : text;
            live.textBreak = false;
            live.streamed += chunk;
            live.sink?.textDelta(chunk);
          }
          continue;
        }
        if (message.type === "user") this.retireNativeToolResults(live, message);
        if (message.type === "assistant") {
          const uses = extractToolUses(message);
          const streaming = live.assistantTurn;
          if (!message.parent_tool_use_id && streaming && streaming.id === messageIdOf(message)) for (const use of uses) streaming.seen.add(use.id);
          for (const use of uses) {
            if (isDroidMcpName(use.name)) {
              // The official MCP CallToolRequest parser drops this root key.
              // Reject the original proposal before joining its mutated handler
              // arguments; never wait for a match or forward altered parameters.
              if (use.input && typeof use.input === "object" && Object.hasOwn(use.input, "__proto__")) {
                throw new BridgeError(422, "unsupported_tool_argument", "The official MCP transport cannot preserve a root __proto__ argument");
              }
              const bare = use.name.replace(/^mcp__droid__/, "");
              const original = live.names?.toOriginal(bare);
              // A stale/unknown proposal can still be rejected by the native
              // tool runner and corrected by the model. It grants no authority.
              if (!original || (!live.catalog?.hasVersion(original, bare) && !live.mailbox.hasCall(use.id))) continue;
              const published = live.mailbox.getCall(use.id);
              if (published && (published.originalName !== original || canonicalJson(published.input) !== canonicalJson(use.input))) throw new BridgeError(409, "conflicting_sdk_tool", "SDK reused a published tool id for different arguments");
              if (!live.claimedHandlers.has(use.id) && !live.retiredCandidates.has(use.id)) {
                const call = { ...use, name: original, mcpName: bare, messageId: messageIdOf(message) };
                const previous = live.candidates.get(use.id);
                if (previous && (previous.name !== call.name || canonicalJson(previous.input) !== canonicalJson(call.input))) throw new BridgeError(409, "conflicting_sdk_tool", "SDK reused a tool id for different arguments");
                live.candidates.set(use.id, call);
              }
            } else {
              live.nativeCallsThisRequest = true;
              live.sink?.toolTrace(use.name, claudeToolTraceDetail(use.name, use.input));
              live.events.push({ at: now(), type: "claude_code_tool", data: { name: use.name, id: use.id } });
            }
          }
          const text = message.parent_tool_use_id ? "" : extractText(message);
          if (text && !live.streamed.includes(text)) {
            live.blocks.push({ type: "text", text });
            if (!live.streamed) live.sink?.textDelta(text);
          }
          this.matchHandlers(live);
          this.settleBatches(live);
        }
        if (message.type === "result") {
          if (message.parent_tool_use_id) {
            if (this.config.nativeWorkflows && (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success"))) throw new BridgeError(502, "workflow_child_failed", "Native workflow child did not complete successfully");
            continue;
          }
          if (live.interrupting) {
            // The aborted turn has ended, whatever subtype it reports. What it left
            // unmatched is moot: interrupt() now retires this process.
            for (const id of live.candidates.keys()) live.retiredCandidates.add(id);
            live.candidates.clear();
            live.turnHandoff = undefined;
            live.windDown?.();
            continue;
          }
          if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
            live.failure = { ...live.failure, ...resultFailure(message) };
            const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string").join("; ") : "";
            const detail = errors || extractText(message) || String(message.subtype ?? "SDK execution failed");
            if (live.failure.terminalReason === "prompt_too_long" || (!live.failure.terminalReason && PROMPT_TOO_LONG_TEXT.test(detail))) {
              throw promptTooLong(live);
            }
            throw new BridgeError(502, "sdk_execution_error", detail, live.failure.terminalReason ? { sdk_terminal_reason: live.failure.terminalReason } : {});
          }
          if (!live.active) continue;
          if (this.config.nativeWorkflows && (live.backgroundTasks.size || live.pending.size || live.workflowPermits?.pending)) { live.workflowDeferredResult = message; continue; }
          if (live.pending.size || live.handlerArrivals.size) throw new BridgeError(502, "sdk_unfinished_tools", "SDK ended a turn while Droid tools were unresolved");
          this.completeRootResult(live, message);
        }
      }
      if (!live.terminal && live.queryEpoch === epoch) {
        // Streaming mode must remain alive between turns; an unexpected EOF is not a successful reply.
        this.stop(live, new BridgeError(502, "sdk_stream_closed", "The Claude Code session ended unexpectedly; resume it in a new bridge process or start a new session"));
      }
    } catch (error) {
      if (!live.terminal && live.queryEpoch === epoch) this.stop(live, this.sdkError(error));
    }
  }

  private completeRootResult(live: LiveSdk, message: Record<string, unknown>): void {
    for (const id of live.candidates.keys()) live.retiredCandidates.add(id);
    live.candidates.clear();
    for (const id of live.prefetched) live.events.push({ at: now(), type: "task_batch_unclaimed", data: { toolUseId: id } });
    live.prefetched.clear();
    const fallback = extractText(message);
    if (!live.streamed && !live.blocks.length && fallback) live.blocks.push({ type: "text", text: fallback });
    const handoff = live.turnHandoff;
    live.turnHandoff = undefined;
    if (handoff?.followup.length) {
      // The previous response ended. Deliver steering as a real user turn
      // whose reply continues this same HTTP response.
      live.sentUserTurns++;
      live.inputs.push({
        type: "user", message: { role: "user", content: handoff.followup },
        parent_tool_use_id: null, session_id: live.sdkSessionId ?? "", uuid: randomUUID(),
      });
      live.events.push({ at: now(), type: handoff.reason === "cancelled" ? "cancelled_turn_followup" : "steering_turn_followup", data: { sdkSessionId: live.sdkSessionId } });
      return;
    }
    if (live.workflowTimer) clearTimeout(live.workflowTimer);
    live.workflowTimer = undefined;
    live.active = false;
    live.turnStartedAt = undefined;
    this.publish(live, this.makeTurn(live, [], "end_turn"));
  }

  private noteUsage(live: LiveSdk, message: Record<string, unknown>): void {
    const event = live.usage.ingest(message);
    if (!event) return;
    const data = { ...event, sessionId: live.current?.session.bridgeSessionId, sdkSessionId: live.sdkSessionId };
    mkdirSync(this.config.logDir, { recursive: true });
    appendLogLine(this.usageFile, JSON.stringify({ at: now(), ...data }));
    live.events.push({ at: now(), type: "usage", data });
  }

  private makeTurn(live: LiveSdk, extra: ContentBlock[], stop: "tool_use" | "end_turn"): RuntimeTurn {
    for (const id of live.mailbox.pruneCompleted()) {
      live.resultFingerprints.delete(id); live.hostCompletionFingerprints.delete(id); live.recordedHostCompletions.delete(id);
      live.claimedHandlers.delete(id); live.retiredCandidates.delete(id);
    }
    if (live.events.length > 1000) live.events.splice(0, live.events.length - 1000);
    const text = live.streamed.trim();
    const content: ContentBlock[] = text ? [{ type: "text", text }, ...extra] : [...live.blocks, ...extra];
    if (!content.length) content.push({ type: "text", text: "" });
    const usage = live.usage.drainTurnUsage() as Usage;
    // A published reply ends this request's import and startup evidence.
    live.phase = stop === "tool_use" ? "waiting_host" : undefined;
    live.importStats = undefined;
    const turn: RuntimeTurn = {
      response: assistantMessage(live.current!.request.model, content, stop, usage),
      pendingToolIds: [...live.pending.keys()], sdkSessionId: live.sdkSessionId,
      compactMetadata: live.compactMetadata, sdkBillingUsage: live.usage.billingSnapshot(), events: [...live.events],
    };
    live.blocks = [];
    live.streamed = "";
    live.textBreak = false;
    return turn;
  }

  private finishDeferredWorkflow(live: LiveSdk): void {
    if (!this.config.nativeWorkflows || live.terminal || !live.workflowDeferredResult || live.backgroundTasks.size || live.pending.size || live.workflowPermits?.pending) return;
    const result = live.workflowDeferredResult;
    live.workflowDeferredResult = undefined;
    this.completeRootResult(live, result);
  }

  private publish(live: LiveSdk, turn: RuntimeTurn): void {
    if (live.terminal) return;
    if (live.waiter) live.waiter.resolve(turn);
    else live.outbox.push(turn);
  }

  private waitForTurn(live: LiveSdk): Promise<RuntimeTurn> {
    return new Promise((resolve, reject) => {
      const watchdog = new TurnWatchdog({
        idleMs: this.config.requestTimeoutMs + BACKSTOP_SLACK_MS,
        maxMs: this.config.turnMaxMs + BACKSTOP_SLACK_MS,
        onTimeout: (kind) => this.stop(live, new BridgeError(504, "sdk_turn_timeout",
          kind === "idle" ? "SDK turn made no progress and was cancelled" : "SDK turn exceeded its maximum duration and was cancelled")),
      });
      live.turnStartedAt = Date.now();
      live.watchdog = watchdog;
      const finish = (): void => {
        watchdog.dispose();
        if (live.watchdog === watchdog) live.watchdog = undefined;
        live.waiter = undefined;
      };
      live.waiter = {
        resolve: (turn) => { finish(); resolve(turn); },
        reject: (error) => { finish(); reject(error); },
      };
      watchdog.setPaused(live.approvals.size > 0);
      if (live.terminal) live.waiter.reject(live.terminal);
    });
  }

  private flushOutbox(live: LiveSdk): void {
    while (live.waiter && live.outbox.length) {
      const turn = live.outbox.shift()!;
      if (turn.response.stop_reason === "tool_use") {
        turn.response.content = turn.response.content.filter((block) => block.type !== "tool_use" || live.pending.has((block as { id: string }).id));
        if (!turn.response.content.some((block) => block.type === "tool_use")) continue;
        turn.pendingToolIds = [...live.pending.keys()];
      }
      live.waiter.resolve(turn);
    }
  }

  private sdkError(error: unknown): BridgeError {
    const converted = upstreamError(error) ?? asBridgeError(error);
    const message = redactValue((this.config.claudeProfiles ?? []).reduce((text, profile) => redactClaudeConfigText(profile.config, text), redactClaudeConfigText(this.config.claudeConfig, converted.message)));
    return message === converted.message ? converted : new BridgeError(converted.status, converted.code, message, converted.extra);
  }

  private stop(live: LiveSdk, error: BridgeError): Promise<void> {
    if (live.terminal) return live.cleanup ?? Promise.resolve();
    error = this.sdkError(error);
    if (([429, 529].includes(error.status) || error.code === "sdk_start_timeout") && this.coldImportSafe(live)) {
      error = new BridgeError(error.status, error.code, error.message, { ...error.extra, retry_from_history: true });
    }
    live.terminal = error;
    live.recoveryReceipts = undefined;
    this.recordTerminal(live, error);
    if (live.workflowTimer) clearTimeout(live.workflowTimer);
    live.workflowTimer = undefined;
    live.workflowDeferredResult = undefined;
    live.workflowPermits?.cancel(error);
    live.active = false;
    live.turnHandoff = undefined;
    live.inputs.close();
    for (const approval of live.approvals) approval.abort();
    live.approvals.clear();
    live.mailbox.cancel(error.message);
    for (const consumption of live.hostResultConsumptions.values()) consumption.resolve();
    live.hostResultConsumptions.clear();
    for (const arrival of [...live.handlerArrivals]) arrival.reject(error);
    live.candidates.clear();
    live.prefetched.clear();
    this.settleBatches(live);
    try { void live.query?.interrupt?.().catch(() => undefined); } catch { /* Best effort; verified tree cleanup follows. */ }
    live.cleanup = this.retireQuery(live).catch(() => {
      // Ownership remains in the reaper and capacity stays occupied on failure.
      this.logger.error("sdk_cleanup_incomplete", { sdkSessionId: live.sdkSessionId });
      live.cleanupFailed = true;
      live.terminal = new BridgeError(error.status, error.code, error.message, { ...error.extra, retry_from_history: false });
    });
    live.waiter?.reject(error);
    live.outbox.length = 0;
    live.current = undefined;
    live.lastReply = undefined;
    live.lastRequestKey = undefined;
    live.blocks = [];
    live.streamed = "";
    live.pending.clear();
    live.retiredCandidates.clear();
    live.claimedHandlers.clear();
    live.backgroundTasks.clear();
    live.usage = new UsageLedger();
    return live.cleanup;
  }

  /**
   * One bounded record per stopped native generation. Codes, phase and counts
   * only: the message, prompts, CLI output and credentials never reach it.
   * Best effort: stop() has already set the terminal state, so a throwing log
   * write here would skip teardown and leave the waiter and process unresolved.
   */
  private recordTerminal(live: LiveSdk, error: BridgeError): void {
    try {
      const session = live.current?.session;
      const account = live.subscriptionAccount?.profile ?? session?.claudeAccount;
      const data = {
        sessionId: session?.bridgeSessionId, sdkSessionId: live.sdkSessionId, status: error.status, code: error.code,
        phase: live.phase ?? "idle", ...live.failure, retryFromHistory: error.extra.retry_from_history === true,
        ...(session?.nativeGeneration !== undefined ? { nativeGeneration: session.nativeGeneration } : {}),
        ...(account ? { claudeProfile: account } : {}),
        ...(live.importStats ? { coldImport: { ...live.importStats } } : {}),
        ...(live.queryStartedAt !== undefined ? { queryAgeMs: Date.now() - live.queryStartedAt } : {}),
        sentUserTurns: live.sentUserTurns,
      };
      if (error.code === "cancelled" || error.code === "host_session_ended") this.logger.info("sdk_session_stopped", data);
      else this.logger.warn("sdk_session_failed", data);
    } catch { /* Diagnostics never block teardown. */ }
  }

  private coldImportSafe(live: LiveSdk): boolean {
    return !live.pending.size && !live.handlerArrivals.size && !live.hostResultConsumptions.size && !live.approvals.size
      && !live.backgroundTasks.size && !live.candidates.size && !live.nativeCallsThisRequest && !live.prefetched.size
      && ![...live.claimedHandlers].some((id) => !live.resultFingerprints.has(id));
  }

  private async loadSdk(): Promise<SdkHandle> {
    if (this.sdk) return this.sdk;
    try {
      const started = Date.now();
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      if (!sdk.query || !sdk.tool || !sdk.createSdkMcpServer) throw new Error("SDK exports missing query/tool/createSdkMcpServer");
      this.sdk = sdk as unknown as SdkHandle;
      this.logger.info("sdk_imported", { importMs: Date.now() - started });
      return this.sdk;
    } catch (error) { throw new BridgeError(503, "sdk_unavailable", error instanceof Error ? error.message : String(error)); }
  }
}

function latestToolResults(input: RuntimeRequest, includeTrailingUserMessages = false): DroidResult[] {
  const latest = input.request.messages.at(-1);
  if (!latest || latest.role !== "user") throw new BridgeError(400, "invalid_turn", "A new turn must end with a user message");
  const messages = includeTrailingUserMessages ? trailingUserMessages(input.request.messages) : [latest];
  return messages.flatMap((message) => asBlocks(message.content)).filter((block) => block.type === "tool_result").map((block) => {
    const result = block as { tool_use_id?: string; content?: string | ContentBlock[]; is_error?: boolean };
    return {
    tool_use_id: String(result.tool_use_id ?? ""), content: result.content ?? "", is_error: Boolean(result.is_error),
    };
  });
}

function isUserCancellation(result: DroidResult): boolean {
  if (!result.is_error) return false;
  const text = typeof result.content === "string" ? result.content
    : result.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "\u0000").join("");
  // Droid's session file stores the bare text; only its API request adds the prefix.
  return USER_CANCELLATIONS.has(text.trim().replace(/^Error:\s*/, ""));
}

function hasNewUserContent(input: RuntimeRequest): boolean {
  const latest = input.request.messages.at(-1);
  return latest?.role === "user" && asBlocks(latest.content).some((block) => block.type !== "tool_result");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function resultFingerprint(result: DroidResult): string {
  return createHash("sha256").update(JSON.stringify({ tool_use_id: result.tool_use_id, content: result.content, is_error: Boolean(result.is_error) })).digest("hex");
}

function hostCompletionFingerprint(completion: RuntimeHostCompletion): string {
  return createHash("sha256").update(canonicalJson({ ...completion, isError: Boolean(completion.isError), terminal: Boolean(completion.terminal) })).digest("hex");
}

function recoveryActionDenied(live: LiveSdk, name: string | undefined, input: unknown): boolean {
  if (!live.recoveryReceipts) return false;
  const original = name?.startsWith("mcp__droid__") ? live.names?.toOriginal(name.slice("mcp__droid__".length)) : undefined;
  return !original || !live.recoveryReceipts.some(receipt => receipt.toolName === original && canonicalJson(receipt.input) === canonicalJson(input));
}

function queryPolicy(input: RuntimeRequest, config: BridgeConfig): string {
  return JSON.stringify({ ...(config.models === undefined ? { model: input.request.model } : {}), role: input.role, cwd: resolveCwd(input, config), permission: config.permissionMode,
    controllerReadOnly: config.controllerReadOnly === true, controllerHostTools: config.controllerHostTools === true,
    ...(config.controllerSpawnAgents ? { controllerSpawnAgents: true } : {}),
    ...(config.factoryNative ? { factoryNative: true } : {}),
    ...(config.controllerReadOnly ? { workerMcpPrefix: config.workerMcpPrefix } : {}),
    ...(config.controllerPool ? { subscriptionAccount: input.session.claudeAccount, nativeGeneration: input.session.nativeGeneration } : {}) });
}
function controllerHostToolAllowed(config: BridgeConfig, name: string): boolean {
  if (config.factoryNative) return !/(?:^|___|__)factory_worker_/.test(name);
  if (!config.controllerReadOnly) return true;
  if (config.controllerHostTools) return name !== "Task" && (name !== "SpawnAgent" || config.controllerSpawnAgents === true);
  if (["Read", "LS", "Grep", "Glob", "ToolSearch", "AskUser"].includes(name)) return true;
  const prefix = config.workerMcpPrefix;
  return !!prefix && ["factory_worker_start", "factory_worker_status", "factory_worker_wait", "factory_worker_list", "factory_worker_cancel", "factory_worker_accounts"].some((tool) => name === prefix + tool);
}
function controllerHostAction(name: string, config: BridgeConfig): boolean {
  return hostActionNeedsWorkspaceReservation(name, config.workerMcpPrefix);
}
function toolAccessDenial(live: LiveSdk, name: string | undefined, factoryPermissionMode?: string): string | undefined {
  const request = live.current?.request;
  if (!hostAllowsAnyTools(request)) return "BRIDGE_HOST_TOOL_ACCESS_NONE: This host request permits no tools. Answer using the supplied conversation only.";
  if (name?.startsWith("mcp__droid__")) {
    const mcpName = name.slice("mcp__droid__".length);
    const original = live.names?.toOriginal(mcpName);
    if (original && request?.tools?.some((tool) => tool.name === original) && live.catalog?.hasVersion(original, mcpName)) return;
  } else if (nativeToolAllowed(name, request)) {
    if ((factoryPermissionMode ?? live.current?.factoryPermissionMode) === "spec" && !["Read", "Glob", "Grep", "LS"].includes(name!)) {
      return "BRIDGE_FACTORY_SPEC_READ_ONLY: Factory spec mode permits native read tools only. Propose the plan through Factory and wait for its permission transition before executing changes.";
    }
    return;
  }
  return `BRIDGE_HOST_TOOL_NOT_ADVERTISED: ${name ?? "Unknown tool"} is not authorized by the current host tool set. Use only its advertised native equivalents or Factory MCP tools; do not work around this restriction.`;
}
function resolveCwd(input: RuntimeRequest, config: BridgeConfig): string {
  if (input.factorySession?.desktopLifecycle) return input.factorySession.cwd;
  return resolveRequestCwd(input.headers, input.request, config);
}
function extractToolUses(message: Record<string, unknown>): DroidCall[] {
  const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
  return content.filter((raw): raw is DroidCall & { type: string } => Boolean(raw && typeof raw === "object" && (raw as { type?: string }).type === "tool_use")).map((use) => ({ id: use.id, name: use.name, input: use.input ?? {} }));
}
function extractText(message: Record<string, unknown>): string {
  if (typeof message.result === "string") return message.result;
  const content = (message.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => (block as { text?: string }).text ?? "").join("\n\n");
}
function messageIdOf(message: Record<string, unknown>): string | undefined {
  const id = (message.message as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}
function startsTextBlock(message: Record<string, unknown>): boolean {
  const event = message.event as { type?: string; content_block?: { type?: string } } | undefined;
  return event?.type === "content_block_start" && event.content_block?.type === "text";
}
function streamTextDelta(message: Record<string, unknown>): string {
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  return event?.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta.text ?? "" : "";
}
function extractCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const rec = extra as Record<string, unknown>;
  for (const key of ["toolUseId", "toolUseID", "tool_use_id"]) if (typeof rec[key] === "string") return rec[key] as string;
  for (const key of ["meta", "_meta"]) {
    const meta = rec[key] as Record<string, unknown> | undefined;
    if (meta && typeof meta.toolUseId === "string") return meta.toolUseId;
  }
  return undefined;
}
function summarizeSdk(message: Record<string, unknown>): Record<string, unknown> {
  return { type: message.type, subtype: message.subtype, session_id: message.session_id,
    ...(message.subtype === "compact_boundary" ? { compact_metadata: structuredClone(message.compact_metadata) } : {}) };
}
function resultFailure(message: Record<string, unknown>): SdkFailure {
  const failure: SdkFailure = {};
  if (typeof message.terminal_reason === "string" && TERMINAL_REASONS.has(message.terminal_reason)) failure.terminalReason = message.terminal_reason;
  if (Number.isSafeInteger(message.api_error_status) && (message.api_error_status as number) >= 100 && (message.api_error_status as number) <= 599) {
    failure.apiErrorStatus = message.api_error_status as number;
  }
  if (typeof message.subtype === "string" && /^[a-z_]{1,48}$/.test(message.subtype)) failure.resultSubtype = message.subtype;
  return failure;
}

/**
 * The same request cannot fit on retry or on another account. Report it the way
 * the Messages API does, so the host classifies it as a context overflow and
 * does not replay it, and name the recovery the operator or host must take.
 */
function promptTooLong(live: LiveSdk): BridgeError {
  const stats = live.importStats;
  return new BridgeError(400, "invalid_request_error",
    "Prompt is too long for the model context window. Retrying the same request will fail again; compact this conversation, or continue in a new session from a summary.",
    { sdk_terminal_reason: "prompt_too_long", recovery_action: "compact_conversation", retry_from_history: false,
      ...(stats ? { cold_import: true, imported_messages: stats.messages, ...(stats.contentBytes !== undefined ? { imported_bytes: stats.contentBytes } : {}) } : {}) });
}

function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError(/auth|login|unauthorized|api key|credit|billing/i.test(message) ? 401 : 502, /auth|login|unauthorized|api key|credit|billing/i.test(message) ? "blocked_auth" : "sdk_error", message);
}
interface AuthVerification {
  mode: BridgeConfig["authMode"];
  kind: AuthClassification["kind"];
  reason?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  tokenSource?: string;
  /** Masked. Never the raw address. */
  email?: string;
  at: string;
}

/** A subscription usage limit ("…limit reached|<reset epoch>") lasts hours, unlike a brief 429; keep its reset time. */
function usageLimitError(error: BridgeError, text: string): BridgeError {
  const reset = /\|(\d{10})\b/.exec(text);
  const seconds = reset ? Number(reset[1]) - Math.floor(Date.now() / 1000) : undefined;
  return new BridgeError(error.status, error.code, error.message, {
    ...error.extra, usage_limit: true, ...(seconds !== undefined && seconds > 0 ? { retry_after: seconds } : {}),
  });
}

function observationFrom(info: Record<string, unknown>): AuthObservation {
  return {
    subscriptionType: stringField(info, "subscriptionType"),
    apiKeySource: stringField(info, "apiKeySource"),
    tokenSource: stringField(info, "tokenSource"),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function mismatchMessage(mode: string, classification: AuthClassification, observed: AuthObservation): string {
  return `Declared BRIDGE_AUTH=${mode} but Claude Code reported ${classification.kind} (${classification.reason}). `
    + `subscriptionType=${observed.subscriptionType ?? "unset"} apiKeySource=${observed.apiKeySource ?? "unset"} `
    + `tokenSource=${observed.tokenSource ?? "unset"}.`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SdkStartTimeout(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function now(): string { return new Date().toISOString(); }
