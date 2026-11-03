import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILES = 64;
const MAX_TAIL_BYTES = 1024 * 1024;
const END_REASONS = new Set(["completed", "cancelled", "model_request_rejected", "model_provider_unavailable", "error"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read only recent local transcripts. Keep exact pending IDs and outcome boundaries, never text or tool payloads. */
export async function droidEndedTools(directory: string, pending: ReadonlySet<string>, since: number): Promise<Map<string, symbol>> {
  const ended = new Map<string, symbol>();
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  const root = await lstat(directory).catch(() => undefined);
  if (!root?.isDirectory() || root.uid !== process.getuid?.() || root.mode & 0o022) return ended;

  const files: { path: string; mtime: number }[] = [];
  for (const group of await readdir(directory, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const folder = join(directory, group.name);
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(folder, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs >= since) files.push({ path, mtime: info.mtimeMs });
    }
  }
  for (const { path } of files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)) {
    const result = await readTranscript(path, pending).catch(() => undefined);
    if (!result) continue;
    for (const [id, outcome] of result) {
      if (seen.has(id)) ambiguous.add(id);
      seen.add(id);
      if (outcome) ended.set(id, outcome);
    }
  }
  for (const id of ambiguous) ended.delete(id);
  return ended;
}

async function readTranscript(path: string, pending: ReadonlySet<string>): Promise<Map<string, symbol | undefined>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const found = new Map<string, symbol | undefined>();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022) return found;
    const length = Math.min(info.size, MAX_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, info.size - length);
    const tail = bytes.subarray(0, bytesRead);
    if (![...pending].some((id) => tail.includes(id))) return found;
    const lines = tail.toString("utf8").split("\n");
    if (info.size > length) lines.shift();
    lines.pop(); // Ignore a partially written trailing record.
    const turn = new Set<string>();
    for (const line of lines) {
      let row: ReturnType<typeof object>;
      try { row = object(JSON.parse(line)); }
      catch { turn.clear(); continue; }
      if (row?.type === "agent_turn_outcome") {
        if (typeof row.turnId === "string" && typeof row.reason === "string" && END_REASONS.has(row.reason)) {
          const boundary = Symbol();
          for (const id of turn) found.set(id, boundary);
        }
        turn.clear();
      }
      const message = row?.type === "message" ? object(row.message) : undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const item of message.content) {
        const block = object(item);
        if (block?.type !== "tool_use" || typeof block.id !== "string" || !pending.has(block.id)) continue;
        turn.add(block.id);
        found.set(block.id, undefined);
      }
    }
    return found;
  } finally { await file.close(); }
}
