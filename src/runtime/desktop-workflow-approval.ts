import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { jsonSchemaToZod } from "../protocol/schema-to-zod.js";
import type { ContentBlock, MessagesRequest } from "../types.js";

export interface DesktopWorkflowQuestion {
  id: string;
  question: string;
  allowAnswer: string;
  input: Record<string, unknown>;
}

/** Keep untrusted script text on one questionnaire line, without control tags. */
function display(value: unknown): string {
  return JSON.stringify(value).replaceAll("[", "［").replaceAll("]", "］");
}

/** Generate only the installed Droid's documented plain-text AskUser shape. */
export function desktopWorkflowQuestion(request: MessagesRequest, cwd: string, input: Record<string, unknown>): DesktopWorkflowQuestion | undefined {
  const tool = request.tools?.find((item) => item.name === "AskUser");
  const properties = tool?.input_schema.properties;
  if (!tool || !properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const questionnaire = properties.questionnaire;
  if (!questionnaire || typeof questionnaire !== "object" || Array.isArray(questionnaire) || questionnaire.type !== "string"
      || !Array.isArray(tool.input_schema.required) || !tool.input_schema.required.includes("questionnaire")) return undefined;
  const rendered = display(input);
  // Approval must expose the complete input rather than silently truncate it.
  if (rendered.length > 16_000) return undefined;
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12);
  const question = `Allow this one native Workflow in ${display(cwd)}? Input ${digest}: ${rendered}`;
  const allowAnswer = "Allow this workflow once";
  const args: Record<string, unknown> = {
    questionnaire: `1. [question] ${question}\n[topic] Workflow approval\n[option] Deny this workflow\n[option] ${allowAnswer}`,
  };
  if (properties.blocking !== undefined) {
    const blocking = properties.blocking;
    if (!blocking || typeof blocking !== "object" || Array.isArray(blocking) || blocking.type !== "boolean") return undefined;
    args.blocking = true;
  }
  const converted = jsonSchemaToZod(tool.input_schema);
  if (!converted.lossless || !converted.schema.safeParse(args).success) return undefined;
  return { id: `workflow_approval_${randomUUID().replaceAll("-", "")}`, question, allowAnswer, input: args };
}

/** Only the exact successful response to the exact live question grants authority. */
export function desktopWorkflowApproved(question: DesktopWorkflowQuestion, result: { content: string | ContentBlock[]; is_error?: boolean }): boolean {
  if (result.is_error) return false;
  let text: string;
  if (typeof result.content === "string") text = result.content;
  else {
    if (!result.content.length || result.content.some((block) => block.type !== "text" || typeof block.text !== "string")) return false;
    text = result.content.map((block) => "text" in block ? String(block.text) : "").join("");
  }
  return text.replaceAll("\r\n", "\n").trim() === `1. [question] ${question.question}\n[answer] ${question.allowAnswer}`;
}

/** Read a bounded, regular policy bundle. No shell, settings or credential reads. */
export function desktopJobPolicy(config: BridgeConfig): string {
  if (!config.desktopJobs) return "";
  if (!config.desktopRuntimePath) throw new Error("Desktop jobs require a policy runtime path");
  const root = realpathSync(config.desktopRuntimePath);
  const workflow = config.desktopWorkflow ?? "implement";
  if (!["implement", "investigate", "release-prepare"].includes(workflow)) throw new Error("Unknown Desktop workflow");
  const read = (relative: string): string => {
    const path = join(root, relative);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Unsafe Desktop policy file");
    return readFileSync(path, "utf8");
  };
  return `\n\nShared execution policy:\n${read("policies/team-policy.md")}\n\nSelected workflow: ${workflow}\n${read(`workflows/${workflow}.md`)}`;
}
