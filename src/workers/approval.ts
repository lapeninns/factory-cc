/** Shared by approval creation, display and decision validation. Never truncate
 * an action to make it fit: the reviewer must receive the exact stored view. */
export const MAX_WORKER_APPROVAL_SUMMARY_CHARS = 4000;

export function approvalSummary(approval: { toolName?: string; input: unknown }): string {
  return `${approval.toolName ?? "Worker action"}: ${JSON.stringify(approval.input)}`;
}
