import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../types.js";
import type { SessionRecord } from "../sessions/state.js";

/** Continue the actual native assignee, including after a stopped model turn.
 * A queued replacement with no SDK checkpoint must not move that assignment. */
export function nativeAssignedAccount(records: readonly SessionRecord[], factorySessionId: string, members: readonly string[]): string | undefined {
  return records.filter(record => record.factorySessionId === factorySessionId && (record.sdkSessionId || record.retryableRequestKind === "upstream")
      && record.claudeAccount && members.includes(record.claudeAccount))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.claudeAccount;
}

/** Conservative routing projection, not an admission grant or quota estimate.
 * The shared Python scheduler still checks capacity, process ownership and cleanup.
 * No ledger is rewritten or reconciled by this read-only selection step. */
export function nativeAccountCandidates(stateRoot: string, role: "orchestrator" | "worker", members: readonly string[]): ReadonlySet<string> {
  const loads = new Map(members.map(member => [member, 0]));
  const uncertain = new Set<string>();
  try {
    let root: string;
    try { root = realpathSync(stateRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(members); throw error; }
    const directory = join(root, "jobs");
    let names: string[];
    try { names = readdirSync(directory).filter(name => name.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(members); throw error; }
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022 || names.length > 16_384) throw new Error();
    for (const name of names) {
      const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let job: Record<string, unknown>;
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022 || info.size > 4 * 1024 * 1024) throw new Error();
        job = JSON.parse(readFileSync(fd, "utf8"));
        if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error();
      } finally { closeSync(fd); }
      if (typeof job.profile !== "string" || !loads.has(job.profile)) continue;
      if (job.kind === "factory-session" && job.workspacePolicy === "controller-host"
          && job.hostActionReservation === true && job.reportedCleanupVerified === true) continue;
      if (["unknown", "orphaned", "cleanup_blocked"].includes(String(job.state))) { uncertain.add(job.profile); continue; }
      if (!["starting", "running", "waiting_slot"].includes(String(job.state))) continue;
      const controller = job.kind === "factory-session" && job.authMode === "subscription"
        && job.subscriptionProfile === job.profile
        && ["controller-readonly", "controller-host", "factory-native"].includes(String(job.workspacePolicy))
        && ["chat", "orchestrator"].includes(String(job.role));
      if (controller === (role === "orchestrator")) loads.set(job.profile, loads.get(job.profile)! + 1);
    }
  } catch {
    throw new BridgeError(503, "native_pool_state_unavailable", "Cannot verify the shared native account admission ledger. No account was reassigned.");
  }
  const ready = members.filter(member => !uncertain.has(member));
  if (!ready.length) throw new BridgeError(503, "native_pool_recovery_required", "Configured native accounts require verified cleanup before a new assignment.");
  const least = Math.min(...ready.map(member => loads.get(member)!));
  return new Set(ready.filter(member => loads.get(member) === least));
}
