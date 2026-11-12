import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, RuntimeHostCompletion } from "../../src/runtime/types.js";
import { historyMessageHashes } from "../../src/sessions/correlate.js";
import type { Message } from "../../src/types.js";
import { CHECKPOINT, FACTORY_SESSION, firstTurn, hostStart, recordingRuntime, startController } from "../helpers/native-restart.js";
import { postMessages } from "../helpers/server.js";

it.each([
  { format: "original", aliasFrom: 2 },
  { format: "rewritten", aliasFrom: 0 },
  { format: "mixed", aliasFrom: 1 },
])("continues the same Factory-native session with $format tool IDs and grouped receipts", async ({ aliasFrom }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-compact-")));
  const cwd = join(root, "workspace");
  const tools = ["one.txt", "two.txt"].map((path, index) => ({ type: "tool_use" as const, id: `toolu_${index}`, name: "Read", input: { path } }));
  const wireTools = tools.map((tool, index) => index < aliasFrom ? tool : { ...tool, id: `call_AbcD1234_efgh-567${index}` });
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
    const tickets: Message[] = [];
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

    const intro: Message = { role: "user", content: [
      { type: "text", text: "You summarized the conversation thus far earlier in this session, as follows:\nRead two files." },
      { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n# Session working directory\n\n% pwd\n${cwd}\n\n</system-reminder>` },
    ] };
    const assistant: Message = { role: "assistant", content: wireTools };
    const compactedMessages: Message[] = [
      intro,
      assistant,
      { role: "user", content: wireTools.map(tool => ({ type: "tool_result", tool_use_id: tool.id, content: `Read ${tool.input.path}` })) },
    ];
    const compacted = { ...firstTurn(bindingToken), messages: compactedMessages };
    const withoutProof = await postMessages(app.url, "client", compacted);
    expect(withoutProof.status, withoutProof.raw).toBe(409);
    expect(withoutProof.json.error).toMatchObject({ type: "desktop_binding_required" });
    const toolResultMessage = { role: "user" as const, content: wireTools.map(tool => ({ type: "tool_result" as const, tool_use_id: tool.id,
      content: "This body disagrees with the authenticated hook receipt", is_error: true })) };
    const wireHistory = [intro, assistant, toolResultMessage];
    // Exact IDs need only one adjacent ticket for the batch. Every rewritten
    // ID needs its own ticket because it no longer identifies the native call.
    const continuation = { ...compacted, messages: [...wireHistory, ...(aliasFrom === 2 ? tickets.slice(0, 1) : tickets)] };
    const alteredInstructions = await postMessages(app.url, "client", { ...continuation, system: "Alter the pending native instructions." });
    expect(alteredInstructions.status).toBe(409);
    const alteredMission = await postMessages(app.url, "client", continuation, { "x-bridge-mission-dir": join(root, "other") });
    expect(alteredMission.status).toBe(409);
    if (aliasFrom === 0) {
      const reject = async (messages: Message[]) => {
        const refused = await postMessages(app.url, "client", { ...compacted, messages });
        expect(refused.status, refused.raw).toBe(409);
        expect(refused.json.error).toMatchObject({ type: "desktop_binding_required" });
      };
      const results = toolResultMessage.content;
      await reject([...wireHistory, tickets[0]!]);
      await reject([intro, assistant,
        { role: "user", content: [results[0]!] }, tickets[1]!,
        { role: "user", content: [results[1]!] }, tickets[0]!,
      ]);
      await reject([intro, { role: "assistant", content: wireTools.map((tool, index) => index === 1
        ? { ...tool, input: { path: "changed.txt" } } : tool) }, toolResultMessage, ...tickets]);
      await reject([intro, { role: "assistant", content: [wireTools[0]!, { ...wireTools[1]!, id: wireTools[0]!.id }] },
        toolResultMessage, ...tickets]);
      const unknownId = "made_up_wire_id";
      await reject([intro, { role: "assistant", content: [wireTools[0]!, { ...wireTools[1]!, id: unknownId }] },
        { role: "user", content: [results[0]!, { ...results[1]!, tool_use_id: unknownId }] }, ...tickets]);
      for (const earlierId of [wireTools[1]!.id, tools[1]!.id]) {
        await reject([intro, { role: "user", content: [{ ...results[1]!, tool_use_id: earlierId }] }, assistant,
          toolResultMessage, ...tickets]);
      }
      const other = app.store.create({ role: "unknown", model: "opus", toolNames: ["Read"] });
      app.store.update(other.bridgeSessionId, { state: "WAITING_DROID_TOOL", pendingToolIds: [wireTools[1]!.id] });
      await reject(continuation.messages);
      expect(app.store.require(other.bridgeSessionId).pendingToolIds).toEqual([wireTools[1]!.id]);
      app.store.update(other.bridgeSessionId, { state: "CANCELLED" });
    }
    const sessionCount = app.store.list().length;
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    const resumed = await postMessages(app.url, "client", continuation);
    expect(resumed.status, resumed.raw).toBe(200);
    expect(resumed.session).toBe(opened.session);
    expect(app.store.list()).toHaveLength(sessionCount);
    expect(runtime.handle).toHaveBeenCalledTimes(2);
    expect(runtime.handle.mock.calls[1]![0]).toMatchObject({ session: { sdkSessionId: CHECKPOINT, nativeGeneration: 0 },
      factorySession: { sessionId: FACTORY_SESSION, cwd } });
    const nativeRequest = runtime.handle.mock.calls[1]![0].request;
    expect(JSON.stringify(nativeRequest)).not.toContain("factory-cc-continuation");
    // Retain Droid's result payload, translating only its ID to the native
    // callback. The independently recorded receipts remain authoritative.
    expect(nativeRequest.messages.at(-2)?.content).toEqual(tools);
    expect(nativeRequest.messages.at(-1)?.content).toEqual(toolResultMessage.content.map((block, index) => ({
      ...block, tool_use_id: tools[index]!.id,
    })));
    expect(nativeReceipts[0]).toMatchObject(tools.map(tool => ({
      toolUseId: tool.id, content: `Read ${tool.input.path}`, isError: false,
    })));
    const reply: Message = { role: "assistant", content: [{ type: "text", text: "Resumed" }] };
    expect(app.store.require(opened.session!)).toMatchObject({ state: "IDLE", hostCompletionReceipts: [],
      historyMessageHashes: historyMessageHashes([...wireHistory, reply]),
    });
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect([...completions.values()].map(completion => completion.content)).toEqual(["Read one.txt", "Read two.txt"]);
    const replay = await postMessages(app.url, "client", continuation);
    expect(replay.status).toBe(409);
    expect(runtime.handle).toHaveBeenCalledTimes(2);
    expect(app.store.list()).toHaveLength(sessionCount);

    const next = await postMessages(app.url, "client", { ...continuation, messages: [...continuation.messages,
      reply,
      { role: "user", content: `[factory-cc-session:${bindingToken}] Continue the same conversation.` },
    ] });
    expect(next.status, next.raw).toBe(200);
    expect(next.session).toBe(opened.session);
    expect(runtime.handle.mock.calls[2]![0]).toMatchObject({ session: { sdkSessionId: CHECKPOINT, nativeGeneration: 0 } });
    expect(runtime.handle.mock.calls[2]![0].request.messages.at(-3)).toEqual(toolResultMessage);
    expect(app.store.list()).toHaveLength(sessionCount);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
