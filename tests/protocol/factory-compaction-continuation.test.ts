import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, RuntimeHostCompletion } from "../../src/runtime/types.js";
import { CHECKPOINT, FACTORY_SESSION, firstTurn, hostStart, recordingRuntime, startController } from "../helpers/native-restart.js";
import { postMessages } from "../helpers/server.js";

it("continues the same Factory-native session across automatic compaction with grouped tool receipts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-compact-")));
  const cwd = join(root, "workspace");
  const tools = ["one.txt", "two.txt"].map((path, index) => ({ type: "tool_use" as const, id: `toolu_${index}`, name: "Read", input: { path } }));
  const completions = new Map<string, RuntimeHostCompletion>();
  const nativeReceipts: RuntimeHostCompletion[][] = [];
  const runtime = {
    ...recordingRuntime(),
    pendingHostCalls: () => tools.map(tool => ({ toolUseId: tool.id, toolName: tool.name, input: tool.input })),
    recordHostToolCompletion: vi.fn(async (_id: string, completion: RuntimeHostCompletion) => {
      completions.set(completion.toolUseId, completion);
      return "accepted" as const;
    }),
    validateHostToolCompletion: vi.fn(),
    cancel: vi.fn(async () => {}),
    handle: vi.fn<BridgeRuntime["handle"]>()
      .mockImplementationOnce(async () => ({ response: assistantMessage("opus", tools, "tool_use"),
        pendingToolIds: tools.map(tool => tool.id), sdkSessionId: CHECKPOINT }))
      .mockImplementation(async input => {
        nativeReceipts.push(structuredClone(input.session.hostCompletionReceipts ?? []));
        return { response: assistantMessage("opus", [{ type: "text", text: "Resumed" }], "end_turn"), pendingToolIds: [], sdkSessionId: CHECKPOINT };
      }),
  };
  const app = await startController(root, runtime);
  try {
    const bindingToken = await hostStart(app, root);
    const opened = await postMessages(app.url, "client", firstTurn(bindingToken));
    expect(opened.status, opened.raw).toBe(200);
    const tickets = [];
    for (const tool of tools) {
      // Desktop reports each completion without the Anthropic tool-use ID.
      const hook = await fetch(`${app.url}/internal/host-events`, {
        method: "POST", headers: { authorization: "Bearer hook", "content-type": "application/json" },
        body: JSON.stringify({ eventId: randomUUID(), bindingToken, event: { session_id: FACTORY_SESSION, cwd,
          hook_event_name: "PostToolUse", tool_name: tool.name, tool_input: tool.input, tool_response: `Read ${tool.input.path}` } }),
      });
      expect(hook.status).toBe(200);
      const payload = await hook.json() as { matched?: boolean; completionRecorded?: boolean; additionalContext?: string };
      expect(payload).toMatchObject({ matched: true, completionRecorded: true });
      expect(payload.additionalContext).toMatch(/^\[factory-cc-continuation:[a-f0-9]{64}\]$/);
      tickets.push({ role: "user", content: [{ type: "text", text: payload.additionalContext! }] });
    }
    expect(runtime.recordHostToolCompletion).toHaveBeenCalledTimes(2);
    expect(app.store.require(opened.session!)).toMatchObject({ state: "WAITING_DROID_TOOL", sdkSessionId: CHECKPOINT });

    const compacted = { ...firstTurn(bindingToken), messages: [
      { role: "user", content: [
        { type: "text", text: "You summarized the conversation thus far earlier in this session, as follows:\nRead two files." },
        { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n# Session working directory\n\n% pwd\n${cwd}\n\n</system-reminder>` },
      ] },
      { role: "assistant", content: tools },
      { role: "user", content: tools.map(tool => ({ type: "tool_result", tool_use_id: tool.id, content: `Read ${tool.input.path}` })) },
    ] };
    const withoutProof = await postMessages(app.url, "client", compacted);
    expect(withoutProof.status, withoutProof.raw).toBe(409);
    expect(withoutProof.json.error).toMatchObject({ type: "desktop_binding_required" });
    const toolResultMessage = { role: "user", content: tools.map(tool => ({ type: "tool_result", tool_use_id: tool.id,
      content: "This body disagrees with the authenticated hook receipt", is_error: true })) };
    const continuation = { ...compacted, messages: [...compacted.messages.slice(0, -1), toolResultMessage, ...tickets] };
    const alteredInstructions = await postMessages(app.url, "client", { ...continuation, system: "Alter the pending native instructions." });
    expect(alteredInstructions.status).toBe(409);
    const alteredMission = await postMessages(app.url, "client", continuation, { "x-bridge-mission-dir": join(root, "other") });
    expect(alteredMission.status).toBe(409);
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    const resumed = await postMessages(app.url, "client", continuation);
    expect(resumed.status, resumed.raw).toBe(200);
    expect(resumed.session).toBe(opened.session);
    expect(app.store.list()).toHaveLength(1);
    expect(runtime.handle).toHaveBeenCalledTimes(2);
    expect(runtime.handle.mock.calls[1]![0]).toMatchObject({ session: { sdkSessionId: CHECKPOINT, nativeGeneration: 0 },
      factorySession: { sessionId: FACTORY_SESSION, cwd } });
    const nativeRequest = runtime.handle.mock.calls[1]![0].request;
    expect(JSON.stringify(nativeRequest)).not.toContain("factory-cc-continuation");
    // The wire result stays intact for history matching. SDK delivery uses the
    // independent receipts which already exist at the native admission boundary.
    expect(nativeRequest.messages.at(-1)?.content).toEqual(toolResultMessage.content);
    expect(nativeReceipts[0]).toMatchObject(tools.map(tool => ({
      toolUseId: tool.id, content: `Read ${tool.input.path}`, isError: false,
    })));
    expect(app.store.require(opened.session!)).toMatchObject({ state: "IDLE", hostCompletionReceipts: [] });
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect([...completions.values()].map(completion => completion.content)).toEqual(["Read one.txt", "Read two.txt"]);
    const replay = await postMessages(app.url, "client", continuation);
    expect(replay.status).toBe(409);
    expect(runtime.handle).toHaveBeenCalledTimes(2);
    expect(app.store.list()).toHaveLength(1);

    const next = await postMessages(app.url, "client", { ...continuation, messages: [...continuation.messages,
      { role: "assistant", content: [{ type: "text", text: "Resumed" }] },
      { role: "user", content: `[factory-cc-session:${bindingToken}] Continue the same conversation.` },
    ] });
    expect(next.status, next.raw).toBe(200);
    expect(next.session).toBe(opened.session);
    expect(runtime.handle.mock.calls[2]![0]).toMatchObject({ session: { sdkSessionId: CHECKPOINT, nativeGeneration: 0 } });
    expect(app.store.list()).toHaveLength(1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
