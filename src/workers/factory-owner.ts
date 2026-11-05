import { createHmac } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Factory adds this metadata to the MCP request, outside model tool arguments. */
export function factorySessionIdentity(meta: unknown): string {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Factory session metadata is required for this worker connection.");
  const value = meta as Record<string, unknown>;
  if (value.caller !== "AGENT" || typeof value.assemblySessionId !== "string" || value.assemblySessionId.length !== 36 || !UUID.test(value.assemblySessionId)) {
    throw new Error("A valid Factory agent session identity is required for this worker connection.");
  }
  return value.assemblySessionId.toLowerCase();
}

/** The private capability makes a session UUID insufficient to claim its workers. */
export function factoryWorkerScope(token: string, sessionId: string): string {
  if (token.length !== 64 || !/^[a-f0-9]{64}$/.test(token) || sessionId.length !== 36 || !UUID.test(sessionId)) throw new Error("Invalid Factory worker ownership input.");
  return createHmac("sha256", token).update(JSON.stringify([
    "factory-worker-owner-v1", sessionId.toLowerCase(),
  ])).digest("hex");
}
