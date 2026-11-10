import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimePermissionDecision, NativeWorkstreamIdentity } from "../runtime/types.js";
import type { SessionStore } from "../sessions/store.js";
import { isEnded } from "../sessions/state.js";
import { BridgeError, type ContentBlock, type MessagesRequest } from "../types.js";
import { canonicalWorkspacePath, COMPACTION_SUMMARY } from "../workspace.js";

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
  terminalResults: Map<string, { toolUseId: string; input: unknown; response: unknown; isError: boolean }>;
  launchId?: string;
  permissionMode?: string;
  /** Remains locked until the host confirms successful ExitSpecMode. */
  specRestricted?: boolean;
  desktopLifecycle?: boolean;
  nativeWorkstream?: NativeWorkstreamIdentity;
}
export interface FactoryHostIdentity { sessionId: string; cwd: string; launchId?: string; desktopLifecycle: boolean; nativeWorkstream?: NativeWorkstreamIdentity }
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
  private readonly launches = new Map<string, { cwd: string; cwdAliases: Set<string>; ended: boolean; hosts: Set<HostBinding>; requiresBinding?: boolean }>();
  private readonly failures: string[] = [];
  private restoredDesktopBindings = 0;
  private closed = false;

  constructor(private readonly runtime: BridgeRuntime, private readonly store: SessionStore, private readonly approvalTimeoutMs: number,
    private readonly options: { desktopLifecycle?: boolean; ignoreUnknownSessionMarkers?: boolean; restoreIdleDesktopBindings?: boolean; factoryNative?: boolean } = {}) {
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

  /** Only leading host context can select a binding. Returned content is data. */
  prepareRequest(original: MessagesRequest, cwd?: string): { request: MessagesRequest; binding?: string } {
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
        if (index === 0 && text.startsWith(COMPACTION_SUMMARY)) continue;
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

    const request = structuredClone(original);
    const clean = (text: string): string => text.replace(/\[factory-cc-session:[a-f0-9]{64}\]/g, "");
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
      const content = blocks(message.content);
      return (content === "" && message.content !== "") || (Array.isArray(content) && content.length === 0 && Array.isArray(message.content) && message.content.length > 0)
        ? [] : [{ ...message, content }];
    });
    if (found.size > 1) throw new BridgeError(409, "ambiguous_host_binding", "Multiple live Factory session markers in trusted host context.");
    if (markers > 0 && found.size === 0 && (!this.options.ignoreUnknownSessionMarkers || recognizedMarkers > 0)) {
      throw new BridgeError(409, "stale_host_binding", "This Factory session has ended or its generation is no longer registered.");
    }
    const host = [...found][0];
    if (host && cwd !== undefined && host.cwd !== canonicalWorkspacePath(cwd)) throw new BridgeError(409, "host_workspace_mismatch", "Factory hook and native workspace differ.");
    return { request, binding: host?.token };
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
    if (host.ended) {
      if (!host.drained) await this.endHost(host, false, "Factory SessionEnd retry");
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
        await this.runtime.recordHostToolCompletion(match.sessionId, completion);
        return { ok: true, observed: true, matched: true, completionRecorded: true, receipt };
      }
      return { ok: true, observed: true, matched: true };
    }

    // idle_prompt also means ordinary idle. It does not authorize cancellation.
    const cancelled = event.hook_event_name === "Notification" && (event.notification_type === "cancelled" || event.notification_type === "session_cancelled");
    if (event.hook_event_name === "SessionEnd" || cancelled) {
      await this.endHost(host, cancelled, `Factory SessionEnd: ${String(event.reason ?? "other")}`);
      return { ok: true, ended: true, sessions: host.bridgeSessions.size };
    }
    return { ok: true, observed: true };
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
    if (host.ending) return host.ending;
    if (host.drained) return;
    host.ended = true;
    const ending = (async () => {
      const errors: unknown[] = [];
      for (const sessionId of host.bridgeSessions) {
        this.cancelApprovals(sessionId);
        const terminal = host.terminalResults.get(sessionId);
        const call = terminal && this.runtime.pendingHostCalls?.(sessionId).find((call) => call.toolUseId === terminal.toolUseId && call.toolName === "EndFeatureRun" && canonical(call.input) === canonical(terminal.input));
        let disposition: "resumable" | "terminal" | "interrupted" = "interrupted";
        let sdkSessionId: string | undefined;
        // Persist replay prohibition before awaiting any live callback cleanup.
        if (this.store.get(sessionId)) {
          this.store.update(sessionId, { hostEnded: "interrupted", ...(cancelled ? { cancelRequested: true } : {}) });
          if (cancelled) this.store.setState(sessionId, "CANCELLED");
        }
        try {
          if (!cancelled && terminal && call && !terminal.isError && this.runtime.completeHostTool) {
            await this.runtime.completeHostTool(sessionId, { ...call, content: typeof terminal.response === "string" ? terminal.response : JSON.stringify(terminal.response), terminal: true });
            disposition = "terminal";
          } else if (cancelled) await this.runtime.cancel(sessionId, "factory-cancelled");
          else {
            const result = await this.runtime.endHostSession?.(sessionId, reason);
            disposition = result?.resumable ? "resumable" : "interrupted";
            sdkSessionId = result?.sdkSessionId;
          }
        } catch (error) {
          errors.push(error);
          this.failures.push(error instanceof BridgeError ? error.code : "host_cleanup_failed");
          try { await this.runtime.cancel(sessionId, "host-completion-failed"); } catch (cancelError) { errors.push(cancelError); }
        }
        const session = this.store.get(sessionId);
        if (session) {
          this.store.update(sessionId, { pendingToolIds: [], hostEnded: disposition, ...(sdkSessionId ? { sdkSessionId } : {}), notes: [...session.notes, cancelled ? "factory-cancelled" : "factory-session-ended"] });
          // A normal exec exit can be resumed later with the same official native checkpoint.
          if (session.state !== "FAILED" && session.state !== "CANCELLED") this.store.setState(sessionId, "IDLE");
        }
      }
      host.drained = true;
      host.terminalResults.clear();
      if (errors.length) throw new AggregateError(errors, "Factory session cleanup reported failures");
    })();
    host.ending = ending;
    try { await ending; } catch (error) { host.ending = undefined; throw error; }
  }

  close(): void {
    this.closed = true;
    for (const approval of this.approvals.values()) approval.finish({ behavior: "deny", message: "Controller shut down." });
  }

  prune(): void {
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
