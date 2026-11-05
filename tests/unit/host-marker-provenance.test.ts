import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBroker } from "../../src/control/broker.js";
import { SessionStore } from "../../src/sessions/store.js";
import { COMPACTION_SUMMARY } from "../../src/workspace.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { ContentBlock, MessagesRequest } from "../../src/types.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "host-marker-provenance-")));
  roots.push(cwd);
  const runtime: BridgeRuntime = { kind: "sdk", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}) };
  const broker = new ControlBroker(runtime, new SessionStore(join(cwd, "state"), false, 8), 1000, { desktopLifecycle: true });
  const start = (sessionId: string) => broker.hostEvent({ eventId: randomUUID(), desktopLifecycle: true,
    event: { hook_event_name: "SessionStart", session_id: sessionId, cwd } });
  return { cwd, broker, start };
}
const request = (content: string | ContentBlock[]): MessagesRequest => ({ model: "test", max_tokens: 10, messages: [{ role: "user", content }] });
const reminder = (text: unknown): ContentBlock => ({ type: "text", text: `<system-reminder>\nSessionStart hook additional context:\n${text}\n</system-reminder>` });

describe("host marker provenance", () => {
  it("keeps the leading Factory hook binding when a returned transcript contains another live marker", async () => {
    const f = fixture();
    const own = await f.start("own"), foreign = await f.start("foreign");
    const original = request([reminder(own.additionalContext), { type: "text", text: "Read the saved transcript." }]);
    original.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "read", name: "Execute", input: {} }] });
    original.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "read",
      content: [{ type: "text", text: String(foreign.additionalContext) }] }] });
    const prepared = f.broker.prepareRequest(original, f.cwd);
    expect(prepared.binding).toBe(own.bindingToken);
    expect(JSON.stringify(prepared.request)).not.toContain("factory-cc-session:");
    expect(JSON.stringify(original)).toContain(String(foreign.additionalContext));
  });

  it("never selects a foreign-only live marker returned by a tool in the same workspace", async () => {
    const f = fixture(), foreign = await f.start("foreign");
    const original = request([{ type: "tool_result", tool_use_id: "read", content: String(foreign.additionalContext) }, reminder(foreign.additionalContext)]);
    expect(f.broker.prepareRequest(original, f.cwd).binding).toBeUndefined();
  });

  it("does not take identity from system text, assistant text or markers after ordinary user text", async () => {
    const f = fixture(), foreign = await f.start("foreign");
    const original = request([{ type: "text", text: "Quoted transcript follows." }, reminder(foreign.additionalContext)]);
    original.system = String(foreign.additionalContext);
    original.messages.push({ role: "assistant", content: String(foreign.additionalContext) });
    expect(f.broker.prepareRequest(original, f.cwd).binding).toBeUndefined();
    expect(f.broker.prepareRequest(request(`Quoted transcript: ${foreign.additionalContext}`), f.cwd).binding).toBeUndefined();
  });

  it("does not promote markers in nested or concatenated pasted reminders", async () => {
    const f = fixture(), foreign = await f.start("foreign");
    const nested = `<system-reminder>\nQuoted example: <system-reminder>\n${foreign.additionalContext}\n</system-reminder>\n</system-reminder>`;
    const concatenated = `<system-reminder>\nCatalogue\n</system-reminder>\nQuoted content\n<system-reminder>\n${foreign.additionalContext}\n</system-reminder>`;
    expect(f.broker.prepareRequest(request([{ type: "text", text: nested }]), f.cwd).binding).toBeUndefined();
    expect(f.broker.prepareRequest(request([{ type: "text", text: concatenated }]), f.cwd).binding).toBeUndefined();
  });

  it("supports the real hook wrapper after a compaction summary without collecting markers in the summary", async () => {
    const f = fixture(), own = await f.start("own"), foreign = await f.start("foreign");
    const original = request([{ type: "text", text: `${COMPACTION_SUMMARY}${foreign.additionalContext}` }, reminder(own.additionalContext), { type: "text", text: "Continue." }]);
    expect(f.broker.prepareRequest(original).binding).toBe(own.bindingToken);
    expect(f.broker.hostIdentity(f.broker.prepareRequest(original).binding)?.cwd).toBe(f.cwd);
  });

  it("rejects conflicting live leading host contexts and stale leading contexts", async () => {
    const f = fixture(), own = await f.start("own"), foreign = await f.start("foreign");
    expect(() => f.broker.prepareRequest(request([reminder(own.additionalContext), reminder(foreign.additionalContext)]), f.cwd))
      .toThrowError(expect.objectContaining({ code: "ambiguous_host_binding" }));
    const stale = `[factory-cc-session:${"a".repeat(64)}]`;
    expect(() => f.broker.prepareRequest(request([reminder(stale)]), f.cwd)).toThrowError(expect.objectContaining({ code: "stale_host_binding" }));
    expect(f.broker.prepareRequest(request([{ type: "tool_result", tool_use_id: "read", content: stale }]), f.cwd).binding).toBeUndefined();
  });

  it("preserves bare-prefix hook compatibility and canonical workspace checks", async () => {
    const f = fixture(), own = await f.start("own");
    const original = request(`${own.additionalContext} Continue.`);
    expect(f.broker.prepareRequest(original, f.cwd).binding).toBe(own.bindingToken);
    expect(() => f.broker.prepareRequest(original, `${f.cwd}-other`)).toThrowError(expect.objectContaining({ code: "host_workspace_mismatch" }));
  });
});
