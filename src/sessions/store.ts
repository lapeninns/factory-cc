import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logging.js";
import type { ModelProvider } from "../models.js";
import type { RuntimeHostCompletion } from "../runtime/types.js";
import { sessionId } from "../relay/ids.js";
import type { RoleTag, SessionState } from "../types.js";
import { BridgeError } from "../types.js";
import { type SessionRecord, retirePendingTools, transition } from "./state.js";
import { sameToolInput } from "./compaction.js";

export interface SessionRetention { maxRecords: number; maxAgeMs: number; journalMaxBytes: number }
export const DEFAULT_SESSION_RETENTION: SessionRetention = { maxRecords: 1000, maxAgeMs: 7 * 24 * 60 * 60 * 1000, journalMaxBytes: 8 * 1024 * 1024 };

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly file: string;
  private writes = 0;

  constructor(
    private readonly dir: string,
    private readonly persist: boolean,
    private readonly maxSessions: number,
    private readonly logger?: Pick<Logger, "warn">,
    private readonly retention = DEFAULT_SESSION_RETENTION,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "sessions.jsonl");
    if (persist) this.load();
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  create(input: {
    role: RoleTag;
    model: string;
    provider?: ModelProvider;
    claudeAccount?: string;
    nativeGeneration?: number;
    controllerWorkspacePolicy?: SessionRecord["controllerWorkspacePolicy"];
    droidSessionId?: string;
    historyHash?: string;
    contextHash?: string;
    reasoning?: string;
    requestMessageHashes?: string[];
    historyMessageHashes?: string[];
    toolNames: string[];
  }): SessionRecord {
    this.requireCapacity();
    const record: SessionRecord = {
      bridgeSessionId: sessionId(),
      droidSessionId: input.droidSessionId,
      role: input.role,
      state: "NEW",
      model: input.model,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.claudeAccount ? { claudeAccount: input.claudeAccount } : {}),
      ...(input.nativeGeneration === undefined ? {} : { nativeGeneration: input.nativeGeneration }),
      ...(input.controllerWorkspacePolicy === undefined ? {} : { controllerWorkspacePolicy: input.controllerWorkspacePolicy }),
      historyHash: input.historyHash,
      contextHash: input.contextHash,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      requestMessageHashes: input.requestMessageHashes,
      historyMessageHashes: input.historyMessageHashes,
      toolNames: input.toolNames,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingToolIds: [],
      cancelRequested: false,
      notes: [],
      usage: { input_tokens: 0, output_tokens: 0, estimated: true },
    };
    this.sessions.set(record.bridgeSessionId, record);
    this.flush(record);
    return record;
  }

  setState(id: string, state: SessionState): SessionRecord {
    const record = this.require(id);
    if (!isActive(record.state) && isActive(state)) this.requireCapacity();
    transition(record, state);
    this.flush(record);
    return record;
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    return this.applyUpdate(id, patch);
  }

  /** Roll back only changes that have not reached the authoritative journal. */
  updateAtomic(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const record = this.require(id);
    const before = structuredClone(record);
    let committed = false;
    try { return this.applyUpdate(id, patch, () => { committed = true; }); }
    catch (error) {
      if (!committed) {
        for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
        Object.assign(record, before);
      }
      throw error;
    }
  }

  private applyUpdate(id: string, patch: Partial<SessionRecord>, committed?: () => void): SessionRecord {
    const record = this.require(id);
    if (patch.state && !isActive(record.state) && isActive(patch.state)) this.requireCapacity();
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    // A host ending (hostEnded) ends the session just as a terminal state does.
    retirePendingTools(record);
    this.sessions.set(id, record);
    this.flush(record, committed);
    return record;
  }

  /** Persist a host receipt independently of admission to the next model turn. */
  recordHostCompletion(id: string, completion: RuntimeHostCompletion): "accepted" | "duplicate" {
    const record = this.require(id);
    const value = structuredClone({ ...completion, isError: Boolean(completion.isError), terminal: Boolean(completion.terminal) });
    if (typeof value.toolUseId !== "string" || !value.toolUseId || typeof value.toolName !== "string" || !value.toolName
        || value.input === undefined || !(typeof value.content === "string" || Array.isArray(value.content))) {
      throw new BridgeError(400, "invalid_host_completion", "A complete host action receipt is required.");
    }
    const previous = record.hostCompletionReceipts ?? [];
    const existing = previous.find(receipt => receipt.toolUseId === value.toolUseId);
    if (existing) {
      if (!sameToolInput(existing, value)) throw new BridgeError(409, "conflicting_host_completion", "The host action already has a different receipt.");
      return "duplicate";
    }
    if (!record.pendingToolIds.includes(value.toolUseId)) {
      throw new BridgeError(409, "unknown_tool_use_id", "The receipt does not belong to a pending host action.");
    }
    const receipts = [...previous, value];
    if (receipts.length > 128 || Buffer.byteLength(JSON.stringify(receipts)) > 8 * 1024 * 1024) {
      throw new BridgeError(409, "host_completion_capacity", "Pending host receipts must be reconciled before accepting more data.");
    }
    record.hostCompletionReceipts = receipts;
    try {
      this.flush(record);
      if (this.persist) {
        const fd = openSync(this.file, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } catch (error) {
      record.hostCompletionReceipts = previous;
      throw error;
    }
    return "accepted";
  }

  /**
   * Give up a session parked on a Droid tool: its native process is gone (a bridge
   * restart) or has just been stopped (reclaimed for its slot), so no result can
   * ever be delivered. Keep its identity but release its slot, and make sure it is
   * never matched, resumed or replayed. Other states are left alone.
   */
  interrupt(id: string, note: string): SessionRecord {
    const record = this.require(id);
    if (record.state !== "WAITING_DROID_TOOL") return record;
    interruptWaiting(record, note);
    this.flush(record);
    return record;
  }

  require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new BridgeError(404, "session_not_found", id);
    return record;
  }

  snapshot(): void {
    if (!this.persist) return;
    atomicWrite(join(this.dir, "sessions-snapshot.json"), JSON.stringify(this.list(), null, 2));
  }

  /** Never prune active work, callbacks, or a session pinned by the HTTP/control layer. */
  prune(protectedIds: ReadonlySet<string> = new Set(), now = Date.now()): string[] {
    const eligible = this.list().filter((record) => !protectedIds.has(record.bridgeSessionId) && !isActive(record.state) && !record.pendingToolIds.length
      && !Object.values(record.accountCooldowns ?? {}).some(until => Date.parse(until) > now))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const removed: string[] = [];
    for (const record of eligible) {
      if (this.sessions.size <= this.retention.maxRecords && now - Date.parse(record.updatedAt) < this.retention.maxAgeMs) continue;
      this.sessions.delete(record.bridgeSessionId);
      removed.push(record.bridgeSessionId);
    }
    if (removed.length) this.compact();
    return removed;
  }

  private flush(record: SessionRecord, committed?: () => void): void {
    record.notes = record.notes.slice(-128);
    if (!this.persist) { committed?.(); return; }
    this.terminateLastLine();
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // Readers now observe this complete record. A later durability or derived
    // snapshot failure must not revert only the in-memory copy.
    committed?.();
    if (committed) {
      const fd = openSync(this.file, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.writes++;
    if (this.writes >= 256 || statSync(this.file).size >= this.retention.journalMaxBytes) this.compact();
    else this.snapshot();
  }

  /** A crash can leave half a record behind. Never let the next append join that line. */
  private terminateLastLine(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const { size } = fstatSync(fd);
      if (size === 0) return;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) appendFileSync(this.file, "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private requireCapacity(): void {
    const active = this.list().filter((record) => isActive(record.state)).length;
    if (active >= this.maxSessions) {
      throw new BridgeError(429, "session_limit", `active session limit ${this.maxSessions} reached`, { retry_after: 1 });
    }
  }

  private load(): void {
    let readable = true;
    try {
      const raw = readFileSync(this.file, "utf8");
      raw.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        // One damaged line (a crash mid-write) must not hide the records after it.
        // Log where it is, never what it contains.
        try {
          const record = JSON.parse(line) as SessionRecord;
          if (!record || typeof record !== "object" || typeof record.bridgeSessionId !== "string" || typeof record.state !== "string") {
            throw new Error("not a session record");
          }
          this.sessions.set(record.bridgeSessionId, record);
        } catch {
          this.logger?.warn("session_store_corrupt_line", { line: index + 1, length: line.length });
        }
      });
    } catch (error) {
      // First run has no file. Anything else must not be compacted over.
      readable = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    // There is no process left to finish an interrupted generation. Keep its
    // identity and SDK checkpoint, but never silently replay unknown side effects.
    // A session parked on a Droid tool can no longer complete either: the SDK
    // callback that would receive the result died with the old process.
    for (const record of this.sessions.values()) {
      if (record.state === "NEW" || record.state === "GENERATING" || record.state === "RESUMING") {
        transition(record, "FAILED");
        record.notes.push("bridge-restarted-during-generation");
      } else if (record.state === "WAITING_DROID_TOOL") {
        interruptWaiting(record, "bridge-restarted-while-waiting-for-tool");
      } else {
        // Records written before ended sessions released their tool IDs.
        retirePendingTools(record);
      }
    }
    if (readable && this.sessions.size > 0) this.compact();
  }

  /** The log appends a full record per change. Rewrite it once as one record per session. */
  private compact(): void {
    if (!this.persist) return;
    atomicWrite(this.file, this.list().map((record) => `${JSON.stringify(record)}\n`).join(""));
    this.writes = 0;
    this.snapshot();
  }
}

/** Write a private file that readers see either complete or not at all. */
function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function interruptWaiting(record: SessionRecord, note: string): void {
  record.hostEnded = "interrupted";
  record.notes.push(note);
  transition(record, "IDLE");
}

function isActive(state: SessionState): boolean {
  return state === "NEW" || state === "GENERATING" || state === "WAITING_DROID_TOOL" || state === "RESUMING";
}
