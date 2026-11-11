/** Outside-the-agent supervision. Scheduler receipts are delivery evidence, never progress evidence. */
export interface StartRejection { at: number; sessionId: string; reason: string }
export interface DispatchReceipt { id: string; at: number }
export interface SupervisorObservation {
  now: number;
  healthy: boolean;
  busy: boolean;
  cancelledAt?: number;
  cooldownUntil?: number;
  rejection?: StartRejection;
  dispatch?: DispatchReceipt;
  retryDispatch?: DispatchReceipt;
  lastTurnAt?: number;
  lastToolAt?: number;
}
export interface SupervisorState {
  armedAt: number;
  intent: "continue" | "pause" | "complete";
  incident?: string;
  failureAt?: number;
  attempts: number;
  pending?: { id: string; dueAt: number; dispatchedAt?: number };
  verifiedAt?: number;
  deliveryHash?: string;
  deliveryIntentHash?: string;
  controlAt?: number;
  status: string;
  alert?: { at: number; reason: string };
}
export interface SupervisorPolicy {
  sessionId: string;
  startupGraceMs: number;
  idleAlertMs: number;
  dispatchGraceMs: number;
  retryDelaysMs: readonly number[];
}
export interface SupervisorDecision {
  state: SupervisorState;
  action?: { type: "schedule"; id: string; dueAt: number } | { type: "pause-retry" };
}
const retryableRejections = new Set(["missions_v2_disabled", "workstreams_v2_disabled"]);
const finiteTime = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x >= 0;

export function superviseWorkstream(previous: SupervisorState, o: SupervisorObservation, p: SupervisorPolicy): SupervisorDecision {
  const s: SupervisorState = structuredClone(previous);
  const finish = (status: string, alert?: string, action?: SupervisorDecision["action"]): SupervisorDecision => {
    s.status = status;
    if (alert && s.alert?.reason !== alert) s.alert = { at: o.now, reason: alert };
    if (!alert) delete s.alert;
    return { state: s, ...(action ? { action } : {}) };
  };
  if (s.intent !== "continue") return finish(s.intent, undefined, s.pending ? { type: "pause-retry" } : undefined);
  if (!o.healthy) return finish("observation-unavailable", "observation_unavailable", s.pending ? { type: "pause-retry" } : undefined);
  const rejection = o.rejection?.sessionId === p.sessionId && o.rejection.at >= s.armedAt ? o.rejection : undefined;
  const dispatch = o.dispatch && o.dispatch.at >= s.armedAt ? o.dispatch : undefined;
  const failureAt = Math.max(rejection?.at ?? 0, dispatch?.at ?? 0);
  const proofAt = finiteTime(o.lastTurnAt) && finiteTime(o.lastToolAt) ? Math.min(o.lastTurnAt, o.lastToolAt) : 0;

  // Both a completed model turn and an authenticated completed host tool are required.
  if (proofAt >= Math.max(s.armedAt, failureAt, s.failureAt ?? 0, s.pending?.dueAt ?? 0)) {
    s.verifiedAt = proofAt;
    s.attempts = 0;
    delete s.failureAt; delete s.incident;
    const action = s.pending ? { type: "pause-retry" as const } : undefined;
    delete s.pending;
    if (!o.busy && o.now - proofAt >= p.idleAlertMs) return finish("attention-idle", "unfinished_work_idle", action);
    return finish("progress-verified", undefined, action);
  }
  if (finiteTime(o.cancelledAt) && o.cancelledAt >= Math.max(s.armedAt, failureAt, s.failureAt ?? 0)) {
    return finish("operator-interrupted", "operator_interruption_requires_explicit_resume", s.pending ? { type: "pause-retry" } : undefined);
  }
  if (o.busy) return finish("work-active", rejection && rejection.at > (s.verifiedAt ?? 0) && o.now - rejection.at >= p.startupGraceMs ? "native_start_rejected_recovery_deferred" : undefined, s.pending ? { type: "pause-retry" } : undefined); // Never interrupt an agent, tool, approval or another writer.

  if (s.pending && finiteTime(o.cooldownUntil) && o.cooldownUntil > o.now) {
    s.pending.dueAt = Math.max(s.pending.dueAt, o.cooldownUntil + 60_000);
    return finish("waiting-for-account", "assigned_account_cooling", { type: "pause-retry" });
  }

  if (s.pending) {
    if (o.retryDispatch && o.retryDispatch.at >= s.pending.dueAt && o.retryDispatch.at <= o.now) {
      if (!s.pending.dispatchedAt) s.pending.dispatchedAt = o.retryDispatch.at;
      if (o.now - s.pending.dispatchedAt < p.startupGraceMs) return finish("verifying-retry", undefined, { type: "pause-retry" });
      // A dispatched retry without progress is not success. Only an explicit new
      // access rejection authorizes another retry; arbitrary idle/cancelled turns do not.
      if (!rejection || rejection.at < s.pending.dispatchedAt) return finish("retry-unverified", "retry_dispatched_without_verified_progress", { type: "pause-retry" });
      delete s.pending;
    } else if (o.now > s.pending.dueAt + p.dispatchGraceMs) {
      return finish("delivery-missed", "retry_delivery_not_observed", { type: "pause-retry" });
    } else return finish("retry-scheduled", s.failureAt ? "native_start_rejected" : undefined);
  }

  if (rejection && rejection.at > (s.verifiedAt ?? 0)) {
    const incident = `${p.sessionId}:${rejection.at}`;
    // An incident's budget spans its retries, rather than resetting on each rejection.
    if (!s.incident) { s.incident = incident; s.failureAt = rejection.at; s.attempts = 0; }
    if (!retryableRejections.has(rejection.reason)) return finish("blocked", "unclassified_native_start_rejection");
    if (o.now - rejection.at < p.startupGraceMs) return finish("start-rejected", "native_start_rejected");
    if (s.attempts >= p.retryDelaysMs.length) return finish("blocked", "native_start_retry_budget_exhausted");
    if (finiteTime(o.cooldownUntil) && o.cooldownUntil > o.now) return finish("waiting-for-account", "assigned_account_cooling");
    const dueAt = Math.max(o.now + 60_000, rejection.at + p.retryDelaysMs[s.attempts]!);
    const id = `${s.armedAt}-${s.attempts + 1}`;
    s.attempts++;
    s.pending = { id, dueAt };
    return finish("retry-scheduled", "native_start_rejected", { type: "schedule", id, dueAt });
  }
  if (dispatch && dispatch.at > (s.verifiedAt ?? 0) && o.now - dispatch.at >= p.startupGraceMs) {
    return finish("start-unverified", "dispatch_succeeded_but_no_productive_start");
  }
  if (o.now - (s.verifiedAt ?? s.armedAt) >= p.idleAlertMs) return finish("attention-idle", "unfinished_work_idle");
  return finish("watching");
}

/** Parse ONLY an owned native logger record. Never recursively search a transcript/tool result. */
export function nativeStartRejection(record: string): StartRejection | undefined {
  const header = /^\[([^\]]+)\] WARN: \[Agent\] Missions 2\.0 turn rejected\r?\n/.exec(record);
  if (!header || record.length > 256 * 1024) return;
  const delimiter = record.indexOf(" | Context: ", header[0].length);
  if (delimiter < 0) return;
  try {
    const context = JSON.parse(record.slice(delimiter + 12).trim());
    const id = context.tags?.sessionId;
    const at = Date.parse(header[1]!);
    if (Number.isFinite(at) && uuid(id) && typeof context.reason === "string") return { at, sessionId: id, reason: context.reason };
  } catch { /* incomplete records are retained by the caller or ignored, never authoritative */ }
}
export function uuid(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }
