import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { asBlocks, canonicalToolUseId, collectToolResults, collectToolUses, systemText } from "../protocol/content.js";
import { hostAllowsAnyTools } from "../runtime/native-tool-policy.js";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimeHostCompletion, RuntimePermissionDecision, NativeWorkstreamIdentity } from "../runtime/types.js";
import type { SessionStore } from "../sessions/store.js";
import { isEnded, nativePurpose, type SessionRecord } from "../sessions/state.js";
import { BridgeError, type ContentBlock, type MessagesRequest } from "../types.js";
import { canonicalWorkspacePath, droidWorkingDirectory, isDroidCompactionSummary, SAME_SESSION_COMPACTION_SUMMARY } from "../workspace.js";

type ObjectValue = Record<string, unknown>;
interface HostBinding {
  token: string;
  sessionId: string;
  cwd: string;
  /** Authenticated aliases observed while the workspace still existed. */
  cwdAliases: Set<string>;
  bridgeSessions: Set<string>;
  ended: boolean;
  drained?: boolean;
  ending?: Promise<void>;
  cancelRequested?: boolean;
  cancellation?: Promise<unknown[]>;
  cancellationFailed?: boolean;
  terminalResults: Map<string, { toolUseId: string; input: unknown; response: unknown; isError: boolean }>;
  launchId?: string;
  permissionMode?: string;
  /** Remains locked until the host confirms successful ExitSpecMode. */
  specRestricted?: boolean;
  desktopLifecycle?: boolean;
  nativeWorkstream?: NativeWorkstreamIdentity;
}
export interface FactoryHostIdentity { sessionId: string; cwd: string; launchId?: string; desktopLifecycle: boolean; nativeWorkstream?: NativeWorkstreamIdentity }
interface ContinuationScope {
  host: HostBinding;
  bridgeSessionId: string;
  sdkSessionId: string;
  generation: number;
  batch: string;
  account?: string;
  provider?: SessionRecord["provider"];
}
interface ContinuationTicket {
  scope: ContinuationScope;
  toolUseId: string;
  receiptHash: string;
  expiresAt: number;
}
interface ContinuationPolicy { scope: ContinuationScope; hash: string }
interface VerifiedContinuation {
  scope: ContinuationScope;
  receiptHash: string;
  aliases: ReadonlyMap<string, string>;
  nativeToolNames: ReadonlyMap<string, string>;
}
const MAX_CONTINUATIONS = 256;
const CONTINUATION_TTL_MS = 10 * 60_000;
const EXACT_CONTINUATION = /^\[factory-cc-continuation:([a-f0-9]{64})\](?![\s\S])/;
const DROID_REWRITTEN_TOOL_ID = /^call_[A-Za-z0-9_-]{18}(?![\s\S])/;

interface PendingApproval {
  view: ObjectValue & { id: string; bridgeSessionId: string };
  finish(decision: RuntimePermissionDecision): void;
}

/** Application control only. Native prompts, tools and conversation remain owned by Claude Code. */
export class ControlBroker implements RuntimeControl {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly hosts = new Map<string, HostBinding>();
  private readonly tokens = new Map<string, HostBinding>();
  private readonly receipts = new Map<string, { hash: string; result: Promise<ObjectValue> }>();
  private readonly continuationTickets = new Map<string, ContinuationTicket>();
  private readonly continuationPolicies = new Map<string, ContinuationPolicy>();
  private readonly launches = new Map<string, { cwd: string; cwdAliases: Set<string>; ended: boolean; hosts: Set<HostBinding>; requiresBinding?: boolean }>();
  private readonly failures: string[] = [];
  private restoredDesktopBindings = 0;
  private closed = false;

  constructor(private readonly runtime: BridgeRuntime, private readonly store: SessionStore, private readonly approvalTimeoutMs: number,
    private readonly options: { desktopLifecycle?: boolean; ignoreUnknownSessionMarkers?: boolean; restoreIdleDesktopBindings?: boolean; factoryNative?: boolean;
      restoreRetainedCheckpoint?: (record: SessionRecord) => Promise<boolean> } = {}) {
    if (options.factoryNative !== undefined && typeof options.factoryNative !== "boolean") throw new Error("Factory-native binding policy must be an explicit boolean.");
    if (options.factoryNative && !options.desktopLifecycle) throw new Error("Factory-native bindings require authenticated Desktop lifecycle events.");
    if (options.desktopLifecycle && options.ignoreUnknownSessionMarkers) throw new Error("Desktop lifecycle cannot ignore unknown session markers.");
    if (options.restoreIdleDesktopBindings !== undefined && typeof options.restoreIdleDesktopBindings !== "boolean") throw new Error("Desktop binding recovery must be an explicit boolean.");
    if (options.restoreIdleDesktopBindings && !options.desktopLifecycle) throw new Error("Desktop binding recovery requires authenticated Desktop lifecycle events.");
  }

  requestApproval(request: RuntimeApprovalRequest): Promise<RuntimePermissionDecision> {
    if (this.closed || request.signal.aborted) return Promise.resolve({ behavior: "deny", message: "The native permission request has ended." });
    const id = randomUUID();
    const { signal, ...details } = request;
    const view = { ...structuredClone(details), id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString() };
    return new Promise((resolveDecision) => {
      let settled = false;
      const finish = (decision: RuntimePermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.approvals.delete(id);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolveDecision(decision);
      };
      const abort = (): void => finish({ behavior: "deny", message: "The native permission request was cancelled." });
      const timer = setTimeout(() => finish({ behavior: "deny", message: "Approval expired without a decision." }), this.approvalTimeoutMs);
      timer.unref();
      this.approvals.set(id, { view, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  listApprovals(): ObjectValue[] { return [...this.approvals.values()].map(({ view }) => structuredClone(view)); }

  decide(id: string, input: unknown): void {
    const decision = object(input);
    if (decision.decision !== "allow" && decision.decision !== "deny") throw invalid("decision must be allow or deny");
    if (decision.updatedInput !== undefined) object(decision.updatedInput);
    if (decision.message !== undefined && typeof decision.message !== "string") throw invalid("message must be a string");
    const approval = this.approvals.get(id);
    if (!approval) throw new BridgeError(409, "approval_expired", "This native permission request is no longer pending.");
    approval.finish(decision.decision === "allow"
      ? { behavior: "allow", ...(decision.updatedInput === undefined ? {} : { updatedInput: structuredClone(decision.updatedInput as ObjectValue) }) }
      : { behavior: "deny", message: typeof decision.message === "string" ? decision.message : "Denied by the local controller." });
  }

  hasApprovals(sessionId: string): boolean {
    return [...this.approvals.values()].some((pending) => pending.view.bridgeSessionId === sessionId);
  }

  cancelApprovals(sessionId: string): void {
    for (const pending of this.approvals.values()) if (pending.view.bridgeSessionId === sessionId) {
      pending.finish({ behavior: "deny", message: "Session cancelled." });
    }
  }

  createLaunch(input: unknown): { launchId: string } {
    const body = object(input);
    if (typeof body.cwd !== "string" || !body.cwd) throw invalid("launch cwd required");
    const launchId = randomUUID();
    const cwd = canonicalWorkspacePath(body.cwd);
    this.launches.set(launchId, { cwd, cwdAliases: new Set([cwd, resolve(body.cwd)]), ended: false, hosts: new Set() });
    return { launchId };
  }

  async endLaunch(launchId: string, cancelled: boolean): Promise<ObjectValue> {
    const launch = this.launches.get(launchId);
    if (!launch) throw new BridgeError(404, "launch_not_found", "Unknown Droid launch.");
    // Closing admission precedes draining; no late SessionStart can escape cancellation.
    launch.ended = true;
    const results = await Promise.allSettled([...launch.hosts].filter((host) => !host.drained)
      .map((host) => this.endHost(host, cancelled, cancelled ? "Factory launch cancelled" : "Factory launch exited")));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Droid launch cleanup reported failures");
    return { ok: true, launchId, ended: true };
  }

  /** Only leading host context or an exact, receipted compacted continuation can select a binding. */
  prepareRequest(original: MessagesRequest, cwd?: string, missionDir?: string): {
    request: MessagesRequest; binding?: string; continuationSessionId?: string; continuationRequest?: MessagesRequest;
    continuationNativeToolNames?: ReadonlyMap<string, string>;
    assertContinuationCurrent?: () => void;
  } {
    const found = new Set<HostBinding>();
    let markers = 0;
    let recognizedMarkers = 0;
    const collect = (text: string): void => {
      for (const match of text.matchAll(/\[factory-cc-session:([a-f0-9]{64})\]/g)) {
        markers += 1;
        const host = this.tokens.get(match[1]!);
        if (host) recognizedMarkers += 1;
        if (host && !host.ended) found.add(host);
      }
    };
    for (const message of original.messages) {
      if (message.role !== "user") continue;
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      for (const [index, block] of content.entries()) {
        if (block.type !== "text" || typeof block.text !== "string") break;
        const text = block.text;
        if (index === 0 && isDroidCompactionSummary(text)) continue;
        // Droid wraps hook additionalContext in a leading system reminder.
        if (text.startsWith("<system-reminder>\n") && text.endsWith("</system-reminder>")) {
          const end = text.indexOf("</system-reminder>");
          if (end !== text.length - "</system-reminder>".length) break;
          if (text.indexOf("<system-reminder>", 1) === -1) collect(text);
          continue;
        }
        // Older hook consumers preserve additionalContext as a bare prefix.
        const prefix = /^(?:\s*\[factory-cc-session:[a-f0-9]{64}\])+/.exec(text)?.[0];
        if (!prefix) break;
        collect(prefix);
        if (text.slice(prefix.length).trim()) break;
      }
    }

    if (found.size > 1) throw new BridgeError(409, "ambiguous_host_binding", "Multiple live Factory session markers in trusted host context.");
    if (markers > 0 && found.size === 0 && (!this.options.ignoreUnknownSessionMarkers || recognizedMarkers > 0)) {
      throw new BridgeError(409, "stale_host_binding", "This Factory session has ended or its generation is no longer registered.");
    }
    const continuation = found.size === 0 ? this.findContinuation(original, missionDir) : undefined;
    const host = [...found][0] ?? continuation?.scope.host;
    if (host && cwd !== undefined && host.cwd !== canonicalWorkspacePath(cwd)) throw new BridgeError(409, "host_workspace_mismatch", "Factory hook and native workspace differ.");

    const request = structuredClone(original);
    const clean = (text: string): string => text.replace(/\[factory-cc-(?:session|continuation):[a-f0-9]{64}\]/g, "");
    const blocks = (content: string | ContentBlock[]): string | ContentBlock[] => {
      if (typeof content === "string") return clean(content);
      return content.flatMap((block): ContentBlock[] => {
        if (block.type === "text" && typeof block.text === "string") {
          const text = clean(block.text);
          return text === "" && block.text !== "" ? [] : [{ ...block, text }];
        }
        if (block.type === "tool_result" && (typeof block.content === "string" || Array.isArray(block.content))) return [{ ...block, content: blocks(block.content as string | ContentBlock[]) } as ContentBlock];
        return [block];
      });
    };
    if (request.system !== undefined) request.system = blocks(request.system);
    request.messages = request.messages.flatMap((message) => {
      // Preserve the client-visible history for normal future correlation.
      // The SDK independently replaces these wrappers before native delivery.
      const content = blocks(message.content);
      return (content === "" && message.content !== "") || (Array.isArray(content) && content.length === 0 && Array.isArray(message.content) && message.content.length > 0)
        ? [] : [{ ...message, content }];
    });
    const prepared = { request: scrubContinuationMarkers(request), binding: host?.token };
    if (!continuation) return prepared;
    return { ...prepared, continuationSessionId: continuation.scope.bridgeSessionId,
      continuationRequest: continuation.aliases.size ? nativeContinuationRequest(prepared.request, continuation.aliases) : undefined,
      continuationNativeToolNames: continuation.aliases.size ? continuation.nativeToolNames : undefined,
      assertContinuationCurrent: () => {
        // HTTP can await other proofs before admission. Recheck the live ticket
        // and every pending receipt after those awaits, before changing state.
        const current = this.findContinuation(original, missionDir);
        if (!current || !sameContinuationScope(continuation.scope, current.scope)
            || current.receiptHash !== continuation.receiptHash) {
          throw new BridgeError(409, "factory_continuation_scope_changed", "The Factory tool receipt no longer belongs to the pending native turn.");
        }
      } };
  }

  /** Capture the policy that actually exposed the current pending batch. */
  rememberContinuationPolicy(token: string | undefined, bridgeSessionId: string, request: MessagesRequest, missionDir?: string): void {
    const host = token ? this.tokens.get(token) : undefined;
    const scope = host && this.continuationScope(host, bridgeSessionId);
    if (!scope || !hostAllowsAnyTools(request)) return;
    this.continuationPolicies.delete(bridgeSessionId);
    setBounded(this.continuationPolicies, bridgeSessionId, { scope, hash: continuationPolicyHash(request, missionDir) });
  }

  private continuationScope(host: HostBinding, bridgeSessionId: string): ContinuationScope | undefined {
    if (this.closed || !this.options.factoryNative || !host.desktopLifecycle || host.ended || host.cancelRequested
        || host.terminalResults.has(bridgeSessionId) || this.tokens.get(host.token) !== host || this.liveHost(bridgeSessionId) !== host) return;
    const session = this.store.get(bridgeSessionId);
    if (!session || session.state !== "WAITING_DROID_TOOL" || session.cancelRequested || session.cancellation || session.hostEnded
        || session.pendingHostRecovery || session.pendingLineageReconciliation || nativePurpose(session) !== "interactive"
        || !session.sdkSessionId || !Number.isSafeInteger(session.nativeGeneration) || session.nativeGeneration! < 0 || !session.pendingToolIds.length) return;
    return { host, bridgeSessionId, sdkSessionId: session.sdkSessionId, generation: session.nativeGeneration!, batch: canonical(session.pendingToolIds),
      account: session.claudeAccount, provider: session.provider };
  }

  private findContinuation(request: MessagesRequest, missionDir?: string): VerifiedContinuation | undefined {
    if (!this.options.factoryNative || !this.continuationTickets.size || !hostAllowsAnyTools(request)) return;
    const first = request.messages[0];
    const prelude = first?.role === "user" ? asBlocks(first.content)[0] : undefined;
    // Legacy cross-instance compaction can retire the parked session; its
    // summary and workspace may still parse, but cannot spend this ticket.
    if (prelude?.type !== "text" || typeof prelude.text !== "string" || !prelude.text.startsWith(SAME_SESSION_COMPACTION_SUMMARY)) return;
    const lastAssistant = request.messages.map(message => message.role).lastIndexOf("assistant");
    if (lastAssistant < 1) return;

    const ids = new Set<string>();
    const ticketResultGroups = new Map<string, Set<string>>();
    let precedingResults = new Set<string>();
    let scope: ContinuationScope | undefined;
    const now = Date.now();
    for (const message of request.messages.slice(lastAssistant + 1)) {
      if (message.role !== "user") return;
      const content = asBlocks(message.content);
      const block = content[0];
      const marker = content.length === 1 && block?.type === "text" && typeof block.text === "string" ? EXACT_CONTINUATION.exec(block.text) : undefined;
      if (marker) {
        // No trimming, wrappers, pasted quotes, or mixed content. Multiple
        // PostToolUse messages can follow one parallel group of results.
        const ticket = this.continuationTickets.get(marker[1]!);
        if (!ticket || ticket.expiresAt <= now || !precedingResults.size || ticketResultGroups.has(ticket.toolUseId)
            || scope && !sameContinuationScope(scope, ticket.scope)) return;
        scope = ticket.scope;
        const receipt = this.store.get(scope.bridgeSessionId)?.hostCompletionReceipts?.find(item => item.toolUseId === ticket.toolUseId);
        if (!receipt || canonical(receipt) !== ticket.receiptHash) return;
        ticketResultGroups.set(ticket.toolUseId, precedingResults);
        continue;
      }
      if (!content.length) return;
      precedingResults = new Set();
      for (const result of content) {
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string" || !result.tool_use_id || ids.has(result.tool_use_id)) return;
        precedingResults.add(result.tool_use_id);
        ids.add(result.tool_use_id);
      }
    }
    if (!scope) return;
    const live = this.continuationScope(scope.host, scope.bridgeSessionId);
    const policy = this.continuationPolicies.get(scope.bridgeSessionId);
    if (!live || !sameContinuationScope(live, scope) || !policy || !sameContinuationScope(policy.scope, scope)
        || policy.hash !== continuationPolicyHash(request, missionDir)) return;
    const cwd = droidWorkingDirectory({ ...request, messages: [first!] });
    if (!cwd || !isAbsolute(cwd) || cwd.includes("\0")) return;
    try {
      if (canonicalWorkspacePath(cwd) !== scope.host.cwd) return;
    } catch { return; }

    const session = this.store.require(scope.bridgeSessionId);
    if (ids.size !== session.pendingToolIds.length) return;

    const assistant = request.messages[lastAssistant]!;
    const calls = collectToolUses([assistant]);
    if (calls.length !== ids.size || asBlocks(assistant.content).filter(block => block.type === "tool_use").length !== calls.length) return;
    const receipts = new Map<string, RuntimeHostCompletion>();
    const wireByNative = new Map<string, string>();
    const aliases = new Map<string, string>();
    const pendingIds = new Set(session.pendingToolIds);
    const pending = this.runtime.pendingHostCalls?.(scope.bridgeSessionId) ?? [];
    for (const call of calls) {
      if (!ids.has(call.id) || aliases.has(call.id) || call.input === undefined) return;
      const exact = pendingIds.has(call.id);
      if (!exact && !DROID_REWRITTEN_TOOL_ID.test(call.id)) return;
      const inputHash = canonical(call.input);
      const matching = (item: { toolName: string; input: unknown }): boolean => item.toolName === call.name && canonical(item.input) === inputHash;
      let nativeCall = pending.find(item => item.toolUseId === call.id);
      if (!exact) {
        const matchingCalls = pending.filter(item => pendingIds.has(item.toolUseId) && matching(item));
        if (matchingCalls.length !== 1) return;
        nativeCall = matchingCalls[0];
      }
      if (!nativeCall || !matching(nativeCall) || receipts.has(nativeCall.toolUseId)) return;
      const nativeId = nativeCall.toolUseId;
      const receipt = session.hostCompletionReceipts?.find(item => item.toolUseId === nativeId);
      if (!receipt || receipt.terminal || !matching(receipt)) return;
      if (!exact) {
        // Droid 1.9 can give a retained tool call a new wire ID. Its exact
        // tool name and input must identify a single live call, and that
        // call's own receipt ticket must follow the corresponding result.
        if (!ticketResultGroups.get(nativeId)?.has(call.id)) return;
        aliases.set(call.id, nativeId);
      }
      wireByNative.set(nativeId, call.id);
      receipts.set(nativeId, receipt);
    }
    for (const [nativeId, group] of ticketResultGroups) {
      const wireId = wireByNative.get(nativeId);
      if (wireId === undefined || !group.has(wireId)) return;
    }
    // Historical results may not answer a pending callback. Check both ID
    // forms, because the SDK also reads earlier results for live callbacks.
    const callbackIds = new Set([...ids, ...pendingIds].map(canonicalToolUseId));
    if (collectToolResults(request.messages.slice(0, lastAssistant + 1)).some(result => callbackIds.has(canonicalToolUseId(result.tool_use_id)))) return;
    // An alias must not hide an ID already owned by another live session
    // when the HTTP layer applies its normal pending-tool ownership checks.
    if (aliases.size && this.store.list().some(record => record.bridgeSessionId !== scope.bridgeSessionId && !isEnded(record)
        && record.pendingToolIds.some(id => aliases.has(canonicalToolUseId(id))))) return;
    const nativeToolNames = new Map<string, string>();
    if (aliases.size) {
      for (const nativeId of receipts.keys()) {
        const name = this.runtime.pendingNativeToolName?.(scope.bridgeSessionId, nativeId);
        if (name) nativeToolNames.set(nativeId, name);
      }
    }
    return { scope, receiptHash: canonical({ receipts: [...receipts.values()], aliases: [...aliases], nativeToolNames: [...nativeToolNames] }),
      aliases, nativeToolNames };
  }

  bind(token: string | undefined, bridgeSessionId: string): void {
    if (!token) return;
    const host = this.tokens.get(token);
    if (!host || host.ended) throw new BridgeError(409, "host_session_ended", "Factory session binding has expired.");
    for (const other of this.hosts.values()) if (other !== host && !other.ended && other.bridgeSessions.has(bridgeSessionId)) {
      throw new BridgeError(409, "conflicting_host_binding", "This native session belongs to another live Factory session.");
    }
    host.bridgeSessions.add(bridgeSessionId);
    this.store.update(bridgeSessionId, { factorySessionId: host.sessionId, factoryCwd: host.cwd });
  }

  hostSessionId(token: string | undefined): string | undefined { return token ? this.tokens.get(token)?.sessionId : undefined; }

  /** Only an exact live generation token supplies trusted Desktop identity. */
  hostIdentity(token: string | undefined): FactoryHostIdentity | undefined {
    const host = token ? this.tokens.get(token) : undefined;
    return host && !host.ended ? { sessionId: host.sessionId, cwd: host.cwd, launchId: host.launchId,
      desktopLifecycle: host.desktopLifecycle === true, ...(host.nativeWorkstream ? { nativeWorkstream: { ...host.nativeWorkstream } } : {}) } : undefined;
  }

  /** The live Factory host this native session is bound to, if any. */
  private liveHost(bridgeSessionId: string): HostBinding | undefined {
    const session = this.store.get(bridgeSessionId);
    if (!session?.factorySessionId || !session.factoryCwd) return undefined;
    const host = this.hosts.get(`${session.factoryCwd}\0${session.factorySessionId}`);
    return host && !host.ended && host.bridgeSessions.has(bridgeSessionId) ? host : undefined;
  }

  /** A bound host's own SessionEnd or launch end releases the session, so it is never reclaimed for its slot. */
  hasLiveHost(bridgeSessionId: string): boolean { return this.liveHost(bridgeSessionId) !== undefined; }

  factoryPermissionMode(bridgeSessionId: string): string | undefined {
    const host = this.liveHost(bridgeSessionId);
    if (!host) return undefined;
    return host.specRestricted ? "spec" : host.permissionMode;
  }

  hostEvent(input: unknown): Promise<ObjectValue> {
    if (this.closed) throw new BridgeError(503, "bridge_shutting_down", "Controller is closed.");
    const envelope = object(input);
    if (typeof envelope.eventId !== "string" || !envelope.eventId || envelope.eventId.length > 200) throw invalid("eventId required");
    const event = object(envelope.event);
    if (envelope.desktopLifecycle !== undefined && typeof envelope.desktopLifecycle !== "boolean") throw invalid("desktopLifecycle must be a boolean");
    const hash = createHash("sha256").update(canonical({ event, bindingToken: envelope.bindingToken, launchId: envelope.launchId, desktopLifecycle: envelope.desktopLifecycle })).digest("hex");
    const existing = this.receipts.get(envelope.eventId);
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError(409, "conflicting_host_event", "An event ID cannot be reused with different content.");
      return existing.result;
    }
    const result = this.processHostEvent(event, envelope.bindingToken, envelope.launchId, envelope.desktopLifecycle === true);
    this.receipts.set(envelope.eventId, { hash, result });
    // Failed events can be retried after their prerequisite reaches the bridge.
    const eventId = envelope.eventId;
    void result.catch(() => { if (this.receipts.get(eventId)?.result === result) this.receipts.delete(eventId); });
    if (this.receipts.size > 10_000) this.receipts.delete(this.receipts.keys().next().value!);
    return result;
  }

  private async processHostEvent(event: ObjectValue, token: unknown, launchId: unknown, desktopLifecycle = false): Promise<ObjectValue> {
    if (typeof event.session_id !== "string" || !event.session_id || typeof event.cwd !== "string" || !event.cwd || typeof event.hook_event_name !== "string") throw invalid("Factory session_id, cwd and hook_event_name required");
    const cwd = canonicalWorkspacePath(event.cwd);
    const key = `${cwd}\0${event.session_id}`;
    let host = this.hosts.get(key);
    if (desktopLifecycle) {
      if (!this.options.desktopLifecycle || event.hook_event_name !== "SessionStart" || launchId !== undefined) {
        throw new BridgeError(409, "desktop_lifecycle_disabled", "Direct Desktop binding is not enabled for this lifecycle event.");
      }
      if (host?.ended && !host.drained) throw new BridgeError(409, "host_session_closing", "The prior Factory session is still draining.");
      if (host && !host.ended) {
        if (!host.desktopLifecycle) throw new BridgeError(409, "conflicting_host_launch", "Factory session is already owned by a wrapper launch.");
        if (token !== undefined && token !== host.token) throw new BridgeError(409, "stale_host_event", "Desktop start supplied another session generation.");
        launchId = host.launchId;
      } else if (event.source === "compact" && typeof event.previous_session_id === "string" && event.previous_session_id !== event.session_id) {
        const previous = this.hosts.get(`${cwd}\0${event.previous_session_id}`);
        if (!previous || previous.ended || !previous.desktopLifecycle || token !== previous.token) {
          throw new BridgeError(409, "stale_host_event", "Desktop compact handoff requires its live predecessor generation.");
        }
        launchId = previous.launchId;
      } else {
        if (token !== undefined) throw new BridgeError(409, "stale_host_event", "A new Desktop generation must not reuse a prior binding.");
        launchId = this.createLaunch({ cwd }).launchId;
      }
    }
    if (event.hook_event_name === "SessionEnd" && token === undefined && launchId !== undefined) {
      // Factory's interactive client emits SessionEnd outside the agent scope
      // that loaded CLAUDE_ENV_FILE. Only the authenticated wrapper launch may
      // identify that exact session, and only when its generation is unique.
      const launch = typeof launchId === "string" ? this.launches.get(launchId) : undefined;
      if (!launch || launch.cwd !== cwd) throw new BridgeError(409, "invalid_host_launch", "Factory client SessionEnd requires its registered wrapper launch and workspace.");
      const owned = [...launch.hosts].filter((candidate) => candidate.sessionId === event.session_id && candidate.cwd === cwd);
      if (!owned.length) throw new BridgeError(409, "host_not_registered", "Factory session is not registered under this wrapper launch.");
      if (launch.requiresBinding && owned.some((candidate) => !candidate.drained)) throw new BridgeError(409, "ambiguous_host_generation", "Expired generations require an explicit live binding for SessionEnd.");
      if (owned.length !== 1) throw new BridgeError(409, "ambiguous_host_generation", "Factory client SessionEnd cannot identify a reused session generation without its binding.");
      // An old launch's late acknowledgement must never select a newer host
      // from the global session map, even when the Factory session ID matches.
      host = owned[0]!;
      token = host.token;
    }
    if (!host && event.hook_event_name === "SessionEnd" && typeof token === "string") {
      const owned = this.tokens.get(token);
      // Once an alias becomes dangling, realpath cannot recover its old target.
      // Only the same authenticated generation may end through an alias already
      // observed at registration; this does not authorize new model requests.
      if (owned?.sessionId === event.session_id && cwd === resolve(event.cwd) && owned.cwdAliases.has(cwd)) host = owned;
    }
    if (event.hook_event_name === "SessionStart") {
      const launch = typeof launchId === "string" ? this.launches.get(launchId) : undefined;
      // Once the bridge is serving wrapper launches, a start with no launch is an unrelated Droid session in the same project.
      if (launchId === undefined && this.launches.size > 0) throw new BridgeError(409, "invalid_host_launch", "Factory SessionStart needs a wrapper launch; this session was not started by run-droid or local.");
      if (launchId !== undefined && (!launch || launch.ended || launch.cwd !== cwd)) throw new BridgeError(409, "invalid_host_launch", "Factory launch is unknown, ended or uses another workspace.");
      if (host && !host.ended && launchId !== host.launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory session is already owned by another launch.");
      // Official compact/handoff SessionStart identifies its predecessor. Retire
      // only that authenticated host generation, so copied transcript markers
      // cannot bind the new session to its predecessor or cause ambiguity.
      // Ordinary starts and same-session compaction do not end sibling sessions.
      if (event.source === "compact" && typeof event.previous_session_id === "string"
          && event.previous_session_id !== event.session_id) {
        const previous = this.hosts.get(`${cwd}\0${event.previous_session_id}`);
        if (previous && !previous.drained) {
          if (previous.launchId !== launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory handoff cannot end a session owned by another launch.");
          await this.endHost(previous, false, "Factory compact handoff");
          // Another authenticated start can complete while draining awaits.
          host = this.hosts.get(key);
          if (launch?.ended) throw new BridgeError(409, "invalid_host_launch", "Factory launch ended during handoff.");
          if (host && !host.ended && launchId !== host.launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory session is already owned by another launch.");
        }
      }
      if (host?.ended && !host.drained) throw new BridgeError(409, "host_session_closing", "The prior Factory session is still draining.");
      if (!host || host.ended) {
        host = { token: randomBytes(32).toString("hex"), sessionId: event.session_id, cwd, cwdAliases: new Set([cwd, resolve(event.cwd), ...(launch?.cwdAliases ?? [])]), bridgeSessions: new Set(), ended: false, terminalResults: new Map(), launchId: typeof launchId === "string" ? launchId : undefined,
          ...(desktopLifecycle ? { desktopLifecycle: true } : {}) };
        if (desktopLifecycle) this.advanceInheritedGenerations(host);
        this.hosts.set(key, host);
        this.tokens.set(host.token, host);
        launch?.hosts.add(host);
      }
      host.cwdAliases.add(resolve(event.cwd));
      this.observeNativeWorkstream(host, event);
      this.observePermissionMode(host, event);
      return { ok: true, bindingToken: host.token, additionalContext: `[factory-cc-session:${host.token}]` };
    }
    if (!host) host = this.restoreIdleDesktopBinding(event, cwd, token, launchId);
    if (!host) throw new BridgeError(409, "host_not_registered", "SessionStart must register the Factory session first.");
    if (token !== host.token) throw new BridgeError(409, "stale_host_event", "Factory event is missing its live session generation or belongs to a prior one.");
    const cancelled = event.hook_event_name === "Notification" && (event.notification_type === "cancelled" || event.notification_type === "session_cancelled");
    if (host.ended) {
      if (!host.drained) await this.endHost(host, cancelled, "Factory SessionEnd retry");
      return { ok: true, alreadyEnded: true };
    }
    this.observeNativeWorkstream(host, event);
    this.observePermissionMode(host, event);

    if (event.hook_event_name === "UserPromptSubmit") {
      // Factory can discard the original SessionStart message during its own
      // automatic compaction. Reattach the authenticated generation at each
      // real user turn instead of inferring ownership from compacted text.
      return { ok: true, additionalContext: `[factory-cc-session:${host.token}]` };
    }

    if (event.hook_event_name === "PostToolUse") {
      if (typeof event.tool_name !== "string" || event.tool_input === undefined || event.tool_response === undefined) throw invalid("PostToolUse needs tool_name, tool_input and tool_response");
      const candidates = [...host.bridgeSessions].flatMap((sessionId) => (this.runtime.pendingHostCalls?.(sessionId) ?? [])
        .filter((call) => call.toolName === event.tool_name && canonical(call.input) === canonical(event.tool_input))
        .filter((call) => event.tool_use_id === undefined || event.tool_use_id === call.toolUseId)
        .map((call) => ({ sessionId, call })));
      if (candidates.length > 1) throw new BridgeError(409, "ambiguous_host_tool", "Identical live tool calls need an explicit tool ID.");
      const match = candidates[0];
      // Native/host-only tools that were never sent through this bridge are observational.
      if (!match) return { ok: true, observed: true, matched: false };
      // Factory exec changes permission_mode *before* executing ExitSpecMode.
      // That optimistic change is not approval. Unlock only after the exact
      // pending host tool has a successful authenticated completion receipt.
      if (event.tool_name === "ExitSpecMode" && !hostToolFailed(event)
          && typeof event.permission_mode === "string" && event.permission_mode !== "spec") {
        host.specRestricted = false;
      }
      if (event.tool_name === "EndFeatureRun") {
        const response = event.tool_response;
        const structuredError = response && typeof response === "object" && !Array.isArray(response)
          && ((response as ObjectValue).isError === true || (response as ObjectValue).is_error === true || (response as ObjectValue).error !== undefined);
        host.terminalResults.set(match.sessionId, { toolUseId: match.call.toolUseId, input: event.tool_input, response, isError: event.is_error === true || Boolean(structuredError) });
      } else if (this.runtime.recordHostToolCompletion) {
        const completion = { ...match.call,
          content: typeof event.tool_response === "string" ? event.tool_response : JSON.stringify(event.tool_response),
          isError: hostToolFailed(event) };
        this.runtime.validateHostToolCompletion?.(match.sessionId, completion);
        // The receipt survives a rejected continuation. Persist it before the
        // runtime releases any reservation or changes its in-memory mailbox.
        const receipt = this.store.recordHostCompletion(match.sessionId, completion);
        const scope = this.continuationScope(host, match.sessionId);
        const runtimeReceipt = await this.runtime.recordHostToolCompletion(match.sessionId, completion);
        const additionalContext = scope && (runtimeReceipt === "accepted" || runtimeReceipt === "duplicate")
          ? this.issueContinuation(scope, completion) : undefined;
        return { ok: true, observed: true, matched: true, completionRecorded: true, receipt, ...(additionalContext ? { additionalContext } : {}) };
      }
      return { ok: true, observed: true, matched: true };
    }

    // idle_prompt also means ordinary idle. It does not authorize cancellation.
    if (event.hook_event_name === "SessionEnd" || cancelled) {
      await this.endHost(host, cancelled, `Factory SessionEnd: ${String(event.reason ?? "other")}`);
      return { ok: true, ended: true, sessions: host.bridgeSessions.size };
    }
    return { ok: true, observed: true };
  }

  private issueContinuation(scope: ContinuationScope, completion: RuntimeHostCompletion): string | undefined {
    const { host, bridgeSessionId } = scope;
    const current = this.continuationScope(host, bridgeSessionId);
    const policy = this.continuationPolicies.get(bridgeSessionId);
    // Neither an async completion from an old generation nor an outcome
    // already consumed during the await can authorize another model request.
    if (!current || !sameContinuationScope(current, scope) || !policy || !sameContinuationScope(policy.scope, scope)
        || !this.runtime.pendingHostCalls?.(bridgeSessionId).some(call => call.toolUseId === completion.toolUseId
          && call.toolName === completion.toolName && canonical(call.input) === canonical(completion.input))) return;
    const receipt = this.store.get(bridgeSessionId)?.hostCompletionReceipts?.find(item => item.toolUseId === completion.toolUseId);
    const receiptHash = canonical({ ...completion, isError: Boolean(completion.isError), terminal: false });
    if (!receipt || canonical(receipt) !== receiptHash) return;
    const now = Date.now();
    this.pruneContinuationTickets(now);
    const id = randomBytes(32).toString("hex");
    setBounded(this.continuationTickets, id, { scope, toolUseId: completion.toolUseId, receiptHash, expiresAt: now + CONTINUATION_TTL_MS });
    return `[factory-cc-continuation:${id}]`;
  }

  private pruneContinuationTickets(now = Date.now()): void {
    for (const [id, ticket] of this.continuationTickets) {
      if (ticket.expiresAt <= now || ticket.scope.host.ended) this.continuationTickets.delete(id);
    }
  }

  private observeNativeWorkstream(host: HostBinding, event: ObjectValue): void {
    if (!this.options.factoryNative || event.bridgeNativeWorkstream === undefined) return;
    const value = object(event.bridgeNativeWorkstream);
    if ((value.role !== "orchestrator" && value.role !== "agent") || typeof value.workstreamId !== "string"
        || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.workstreamId)) {
      throw invalid("Invalid authenticated native Workstream metadata");
    }
    if (host.nativeWorkstream && (host.nativeWorkstream.role !== value.role || host.nativeWorkstream.workstreamId !== value.workstreamId)) {
      throw new BridgeError(409, "native_workstream_conflict", "Factory cannot change the Workstream role of a live session generation.");
    }
    host.nativeWorkstream = { workstreamId: value.workstreamId, role: value.role };
  }

  private observePermissionMode(host: HostBinding, event: ObjectValue): void {
    if (typeof event.permission_mode !== "string") return;
    host.permissionMode = event.permission_mode;
    if (event.permission_mode === "spec") host.specRestricted = true;
  }

  /**
   * A bridge restart loses its in-memory hooks, but Factory can retain the
   * original opaque marker. Only the authenticated user-turn hook may recover
   * that marker, and only from persisted records with no unfinished work.
   * Ordinary model requests and other lifecycle events cannot register hosts.
   */
  private restoreIdleDesktopBinding(event: ObjectValue, cwd: string, token: unknown, launchId: unknown): HostBinding | undefined {
    if (!this.options.restoreIdleDesktopBindings || !this.options.desktopLifecycle
        || event.hook_event_name !== "UserPromptSubmit" || launchId !== undefined
        || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || this.tokens.has(token)) return;
    const records = this.store.list().filter(record => record.factorySessionId === event.session_id);
    if (!records.length || records.some(record => record.factoryCwd !== cwd
        || !["IDLE", "FAILED"].includes(record.state)
        || record.cancelRequested !== false || record.hostEnded !== undefined
        || !Array.isArray(record.pendingToolIds) || record.pendingToolIds.length !== 0
        || (record.endedToolIds !== undefined && (!Array.isArray(record.endedToolIds) || record.endedToolIds.length !== 0))
        || !Array.isArray(record.notes) || record.notes.some(note => typeof note !== "string"
          || ["bridge-restarted-during-generation", "bridge-restarted-while-waiting-for-tool", "request-timeout-interrupted"].includes(note))
        || (record.sdkSessionId !== undefined && (typeof record.sdkSessionId !== "string" || !record.sdkSessionId.trim()
          || record.sdkSessionId.length > 256))
        || (record.nativeGeneration !== undefined && (!Number.isSafeInteger(record.nativeGeneration)
          || record.nativeGeneration < 0 || record.nativeGeneration >= 1_000_000))
        // A failed native process is not a resumable checkpoint. Pre-inference
        // workspace rejection has no SDK session or provider token usage.
        || (record.state === "FAILED" && (record.sdkSessionId !== undefined
          || record.usage?.input_tokens !== 0 || record.usage?.output_tokens !== 0))
        || this.hasApprovals(record.bridgeSessionId) || Boolean(this.runtime.pendingHostCalls?.(record.bridgeSessionId).length)
        || this.runtime.isSessionUsable?.(record.bridgeSessionId) === true
        || Boolean(this.runtime.protectedSessionIds?.().includes(record.bridgeSessionId))
        || [...this.hosts.values()].some(other => other.bridgeSessions.has(record.bridgeSessionId)))) return;
    // Python leases belong to the bridge process that acquired them. Keep its
    // strict owner check and allocate a new durable identity before publishing
    // the recovered host. Another restart advances again, including if this
    // process exits after persistence but before its first model request.
    for (const record of records) this.store.update(record.bridgeSessionId, { nativeGeneration: (record.nativeGeneration ?? 0) + 1 });
    const host: HostBinding = { token, sessionId: event.session_id as string, cwd,
      cwdAliases: new Set([cwd, resolve(event.cwd as string)]),
      bridgeSessions: new Set(records.map(record => record.bridgeSessionId)), ended: false,
      terminalResults: new Map(), desktopLifecycle: true };
    this.hosts.set(`${cwd}\0${host.sessionId}`, host);
    this.tokens.set(token, host);
    this.restoredDesktopBindings++;
    return host;
  }

  /**
   * A durable native lease belongs to the controller process that acquired it,
   * and an orderly close makes it terminal. A fresh authenticated start in a
   * later process continues the same native checkpoint under a new generation.
   * The lease helper still refuses that generation while any predecessor is
   * active, uncertain or owned by another live controller.
   */
  private advanceInheritedGenerations(host: HostBinding): void {
    const owns = this.runtime.ownsNativeSession?.bind(this.runtime);
    if (!owns) return;
    for (const record of this.store.list()) {
      const generation = record.nativeGeneration;
      if (record.factorySessionId !== host.sessionId || record.factoryCwd !== host.cwd || record.state !== "IDLE" || isEnded(record)
          || record.cancelRequested || record.pendingToolIds.length
          || generation === undefined || !Number.isSafeInteger(generation) || generation < 0 || generation >= 1_000_000
          || owns(record.bridgeSessionId) || this.runtime.isSessionUsable?.(record.bridgeSessionId) === true
          || Boolean(this.runtime.protectedSessionIds?.().includes(record.bridgeSessionId))
          || this.hasApprovals(record.bridgeSessionId) || Boolean(this.runtime.pendingHostCalls?.(record.bridgeSessionId).length)
          || [...this.hosts.values()].some(other => other !== host && !other.ended && other.bridgeSessions.has(record.bridgeSessionId))) continue;
      this.store.update(record.bridgeSessionId, { nativeGeneration: generation + 1 });
    }
  }

  private async endHost(host: HostBinding, cancelled: boolean, reason: string): Promise<void> {
    if (host.drained) return;
    // Latch a same-generation cancellation before joining a normal drain.
    // A drained old generation cannot cancel its later replacement.
    if (cancelled) this.cancelHost(host);
    if (host.ending) return host.ending;
    host.ended = true;
    const ending = (async () => {
      const errors: unknown[] = [];
      for (const sessionId of host.bridgeSessions) {
        this.cancelApprovals(sessionId);
        const previous = this.store.get(sessionId) ? structuredClone(this.store.require(sessionId)) : undefined;
        const terminal = host.terminalResults.get(sessionId);
        const call = terminal && this.runtime.pendingHostCalls?.(sessionId).find((call) => call.toolUseId === terminal.toolUseId && call.toolName === "EndFeatureRun" && canonical(call.input) === canonical(terminal.input));
        let disposition: "resumable" | "terminal" | "interrupted" = "interrupted";
        let sdkSessionId: string | undefined;
        try {
          // Persist replay prohibition before awaiting any live callback cleanup.
          if (this.store.get(sessionId)) {
            this.store.update(sessionId, { hostEnded: "interrupted", pendingHostRecovery: undefined,
              ...(host.cancelRequested ? { cancelRequested: true, cancellation: { at: new Date().toISOString(), source: "host" as const } } : {}) });
            if (host.cancelRequested) this.store.setState(sessionId, "CANCELLED");
          }
          const fenced = JSON.stringify(this.store.get(sessionId));
          if (!host.cancelRequested && terminal && call && !terminal.isError && this.runtime.completeHostTool) {
            await this.runtime.completeHostTool(sessionId, { ...call, content: typeof terminal.response === "string" ? terminal.response : JSON.stringify(terminal.response), terminal: true });
            disposition = "terminal";
          } else if (host.cancelRequested) await host.cancellation;
          else {
            const result = await this.runtime.endHostSession?.(sessionId, reason);
            disposition = result?.resumable ? "resumable" : "interrupted";
            sdkSessionId = result?.sdkSessionId;
            if (!host.cancelRequested && !result?.resumable && previous?.state === "IDLE" && previous.retainedCheckpoint && previous.sdkSessionId
                && !previous.cancelRequested && previous.hostEnded === undefined && !previous.pendingToolIds.length
                && !previous.endedToolIds?.length && !previous.hostCompletionReceipts?.length
                && this.options.restoreRetainedCheckpoint && await this.options.restoreRetainedCheckpoint(previous)
                && JSON.stringify(this.store.get(sessionId)) === fenced) {
              disposition = "resumable";
              sdkSessionId = previous.sdkSessionId;
            }
          }
        } catch (error) {
          errors.push(error);
          this.failures.push(error instanceof BridgeError ? error.code : "host_cleanup_failed");
          try {
            if (host.cancelRequested) await host.cancellation;
            else await this.runtime.cancel(sessionId, "host-completion-failed");
          } catch (cancelError) { errors.push(cancelError); }
        }
        const session = this.store.get(sessionId);
        if (session) {
          if (host.cancelRequested || session.cancelRequested || session.state === "CANCELLED") { disposition = "interrupted"; sdkSessionId = undefined; }
          try {
            this.store.update(sessionId, { pendingToolIds: [], hostEnded: disposition, ...(sdkSessionId ? { sdkSessionId } : {}), notes: [...session.notes, host.cancelRequested ? "factory-cancelled" : "factory-session-ended"] });
            // A normal exec exit can be resumed later with the same official native checkpoint.
            if (session.state !== "FAILED" && session.state !== "CANCELLED") this.store.setState(sessionId, "IDLE");
          } catch (error) { errors.push(error); }
        }
      }
      if (host.cancellation) errors.push(...await host.cancellation);
      host.drained = errors.length === 0;
      if (host.drained) host.terminalResults.clear();
      if (errors.length) throw new AggregateError(errors, "Factory session cleanup reported failures");
    })();
    host.ending = ending;
    try { await ending; } catch (error) { host.ending = undefined; throw error; }
  }

  private cancelHost(host: HostBinding): void {
    if (host.cancellation && !host.cancellationFailed) return;
    host.cancelRequested = true;
    host.cancellationFailed = false;
    const ids = [...host.bridgeSessions];
    host.cancellation = Promise.all(ids.map(async id => {
      const errors: unknown[] = [];
      try {
        this.cancelApprovals(id);
        if (this.store.get(id)) this.store.update(id, { state: "CANCELLED", cancelRequested: true, hostEnded: "interrupted",
          pendingHostRecovery: undefined, cancellation: { at: new Date().toISOString(), source: "host" } });
      } catch (error) { errors.push(error); }
      // Persistence failure cannot leave native execution running behind the latch.
      try { await this.runtime.cancel(id, "factory-cancelled"); }
      catch (error) { errors.push(error); }
      return errors;
    })).then(results => {
      const errors = results.flat();
      host.cancellationFailed = errors.length > 0;
      return errors;
    });
  }

  close(): void {
    this.closed = true;
    this.continuationTickets.clear();
    this.continuationPolicies.clear();
    for (const approval of this.approvals.values()) approval.finish({ behavior: "deny", message: "Controller shut down." });
  }

  prune(): void {
    this.pruneContinuationTickets();
    // Keep bounded ended generations for retries; never remove a live host or
    // an incomplete cleanup. Hook receipts already have their own 10k cap.
    const ended = [...this.tokens.values()].filter((host) => host.drained);
    for (const host of ended.slice(0, Math.max(0, ended.length - 256))) {
      const key = `${host.cwd}\0${host.sessionId}`;
      if (this.hosts.get(key) === host) this.hosts.delete(key);
      this.tokens.delete(host.token);
      if (host.launchId) {
        const launch = this.launches.get(host.launchId);
        if (launch) { launch.hosts.delete(host); launch.requiresBinding = true; }
      }
    }
    const endedLaunches = [...this.launches.entries()].filter(([, launch]) => launch.ended && [...launch.hosts].every((host) => host.drained));
    for (const [id] of endedLaunches.slice(0, Math.max(0, endedLaunches.length - 256))) this.launches.delete(id);
    if (this.failures.length > 256) this.failures.splice(0, this.failures.length - 256);
  }

  describe(): ObjectValue {
    return { ignoreUnknownSessionMarkers: this.options.ignoreUnknownSessionMarkers === true,
      restoreIdleDesktopBindings: this.options.restoreIdleDesktopBindings === true, restoredDesktopBindings: this.restoredDesktopBindings,
      pendingApprovals: this.approvals.size, failures: [...this.failures], activeHostSessions: [...this.hosts.values()].filter((host) => !host.ended).length, boundNativeSessions: [...this.hosts.values()].filter((host) => !host.ended).reduce((n, host) => n + host.bridgeSessions.size, 0) };
  }
}

/** Native ownership and SDK delivery use the original callback IDs. History
 * retains the sanitized wire IDs so Droid can echo that history next turn. */
function nativeContinuationRequest(request: MessagesRequest, aliases: ReadonlyMap<string, string>): MessagesRequest {
  const lastAssistant = request.messages.map(message => message.role).lastIndexOf("assistant");
  const messages = request.messages.map((message, index) => {
    if (index < lastAssistant || typeof message.content === "string") return message;
    const content = message.content.map(block => {
      if (block.type === "tool_use" && typeof block.id === "string" && aliases.has(block.id)) return { ...block, id: aliases.get(block.id)! };
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && aliases.has(block.tool_use_id)) {
        return { ...block, tool_use_id: aliases.get(block.tool_use_id)! };
      }
      return block;
    });
    return { ...message, content };
  });
  return { ...request, messages };
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_CONTINUATIONS) map.delete(map.keys().next().value!);
}

function sameContinuationScope(left: ContinuationScope, right: ContinuationScope): boolean {
  return left.host === right.host && left.bridgeSessionId === right.bridgeSessionId && left.sdkSessionId === right.sdkSessionId
    && left.generation === right.generation && left.batch === right.batch && left.account === right.account && left.provider === right.provider;
}

function continuationPolicyHash(request: MessagesRequest, missionDir?: string): string {
  return canonical({ tools: request.tools, tool_choice: request.tool_choice, system: systemText(request.system), missionDir });
}

/** Strip bearer material even when a copied ticket appears in arbitrary JSON data. */
function scrubContinuationMarkers<T>(value: T): T {
  const clean = (text: string) => text.replace(/\[factory-cc-continuation:[a-f0-9]{64}\]/g, "");
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return clean(item);
    if (Array.isArray(item)) return item.map(walk);
    if (!item || typeof item !== "object") return item;
    const object = item as ObjectValue;
    return Object.fromEntries(Object.entries(object).flatMap(([key, child]) => {
      const sanitized = clean(key);
      return sanitized !== key && (!sanitized || Object.hasOwn(object, sanitized)) ? [] : [[sanitized, walk(child)]];
    }));
  };
  return walk(value) as T;
}

function hostToolFailed(event: ObjectValue): boolean {
  const response = event.tool_response;
  return event.is_error === true || Boolean(response && typeof response === "object" && !Array.isArray(response)
    && ((response as ObjectValue).isError === true || (response as ObjectValue).is_error === true || (response as ObjectValue).error !== undefined));
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("JSON object required");
  return value as ObjectValue;
}
function invalid(message: string): BridgeError { return new BridgeError(400, "invalid_control_request", message); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : item;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}
