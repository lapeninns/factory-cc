const REASONS = {
  invalid_request: "Worker request was rejected before execution. Correct the request before starting replacement work.",
  repository_rejected: "Worker repository validation failed before execution. Correct the repository configuration before starting replacement work.",
  subscription_preflight_failed: "Worker subscription preflight failed before execution. Check the assigned login and pinned authentication runtime before starting replacement work.",
  subscription_profile_invalid: "The fixed Team profile mapping or private directory is invalid; execution did not start.",
  subscription_runtime_missing: "The packaged subscription CLI is missing; restore the complete pinned SDK release before retrying.",
  subscription_runtime_unverified: "The packaged subscription CLI or SDK failed verification; execution did not start.",
  subscription_login_unavailable: "The assigned Team login could not be verified; execution did not start.",
  subscription_identity_mismatch: "Native login does not match the configured first-party Team identity; execution did not start.",
  runtime_unverified: "Worker runtime verification failed before execution. Verify the configured native runtime before starting replacement work.",
  service_unavailable: "Worker service rejected the start before execution. Restore the service before starting replacement work.",
  capacity_unavailable: "Worker admission is full. Wait for an existing worker to settle before submitting another operation.",
} as const;

export type WorkerStartRejectionCode = keyof typeof REASONS;
export interface WorkerStartRejection {
  type: "worker_start_rejected";
  code: WorkerStartRejectionCode;
  executionStarted: false;
}

/** Only throw before the start operation can create a worktree or worker. */
export class WorkerStartRejected extends Error {
  constructor(readonly code: WorkerStartRejectionCode, message: string = REASONS[code]) {
    super(message);
    this.name = "WorkerStartRejected";
  }
}

export function isWorkerStartRejectionCode(value: unknown): value is WorkerStartRejectionCode {
  return typeof value === "string" && Object.hasOwn(REASONS, value);
}

export function isWorkerStartRejection(value: unknown): value is WorkerStartRejection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 3 && item.type === "worker_start_rejected"
    && item.executionStarted === false && isWorkerStartRejectionCode(item.code);
}

export function workerStartRejectionReason(code: WorkerStartRejectionCode): string {
  return REASONS[code];
}
