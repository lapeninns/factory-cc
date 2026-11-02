import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { approvalSummary } from "./control.js";

export interface WorkerController {
  start(input: { repository: string; task: string; workflow: "implement" | "investigate" | "release-prepare" }): Promise<unknown>;
  status(id: string): unknown;
  list(): unknown;
  cancel(id: string): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object arguments required.");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A nonempty string is required.");
  return value;
}

/** Deliberately has no model-callable approval tool. Human approval is separate. */
export function createWorkerMcp(controller: WorkerController, options: { approvalCommand?: string } = {}): Server {
  const server = new Server({ name: "factory-supervised-workers", version: "1.0.0" }, {
    capabilities: { tools: {} },
    instructions: "Use these supervised workers for independent implementation tasks. Each worker has a separate Git worktree. Start, then poll status or wait. Report its recorded result and verification honestly. Never treat a running or exited process as product acceptance. For pending actions, keep polling status or wait so the configured controller can present the native human approval. Never approve an action yourself; there is no automatic approval tool.",
  });
  const properties = { id: { type: "string" } };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "factory_worker_start", description: "Start one supervised worker in its own worktree using this connection's fixed authentication route.", inputSchema: { type: "object", properties: { repository: { type: "string" }, task: { type: "string" }, workflow: { type: "string", enum: ["implement", "investigate", "release-prepare"] } }, required: ["repository", "task"], additionalProperties: false } },
    { name: "factory_worker_status", description: "Read worker state, result, usage and any pending human permission request.", inputSchema: { type: "object", properties, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "factory_worker_wait", description: "Wait up to 20 seconds for a worker state change, then return current progress.", inputSchema: { type: "object", properties, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "factory_worker_list", description: "List supervised workers and their current recorded state.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "factory_worker_cancel", description: "Cancel a specific supervised worker and clean up its owned execution.", inputSchema: { type: "object", properties, required: ["id"], additionalProperties: false } },
  ] }));
  const view = (value: unknown): unknown => {
    const item = value && typeof value === "object" && !Array.isArray(value) ? { ...value as Record<string, unknown> } : value;
    if (item && typeof item === "object" && options.approvalCommand) {
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.approvals) && record.approvals.length) {
        record.approvalInstructions = { command: options.approvalCommand, rule: "Run only through Factory Execute with the installed ask permission rule. The command checks the exact pending action digest. Do not invoke a different interpreter or bypass the rule.",
          requests: record.approvals.map((entry: unknown) => { const approval = object(entry); return { ...approval, actionDigest: createHash("sha256").update(JSON.stringify(approval.input)).digest("hex"), actionSummary: approvalSummary({ toolName: typeof approval.toolName === "string" ? approval.toolName : undefined, input: approval.input }) }; }) };
      }
    }
    return item;
  };
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = object(request.params.arguments ?? {});
      let result: unknown;
      if (request.params.name === "factory_worker_start") {
        const workflow = args.workflow ?? "implement";
        if (!["implement", "investigate", "release-prepare"].includes(String(workflow))) throw new Error("Unknown workflow.");
        result = await controller.start({ repository: string(args.repository), task: string(args.task), workflow: workflow as "implement" | "investigate" | "release-prepare" });
      } else if (request.params.name === "factory_worker_status") result = controller.status(string(args.id));
      else if (request.params.name === "factory_worker_list") result = controller.list();
      else if (request.params.name === "factory_worker_cancel") result = await controller.cancel(string(args.id));
      else if (request.params.name === "factory_worker_wait") {
        const id = string(args.id), before = JSON.stringify(controller.status(id));
        for (let attempt = 0; attempt < 40 && !extra.signal.aborted; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (JSON.stringify(controller.status(id)) !== before) break;
          const state = object(controller.status(id)).state;
          if (["completed", "failed", "cancelled", "unknown", "waiting_approval"].includes(String(state))) break;
        }
        result = controller.status(id);
      } else throw new Error("Unknown worker tool.");
      return { content: [{ type: "text", text: JSON.stringify(Array.isArray(result) ? result.map(view) : view(result)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Worker operation failed. Check the local worker configuration and the specific worker state; no provider or credential details are exposed here." }] };
    }
  });
  return server;
}
