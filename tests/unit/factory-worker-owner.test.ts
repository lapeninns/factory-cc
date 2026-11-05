import { describe, expect, it } from "vitest";
import { factorySessionIdentity, factoryWorkerScope } from "../../src/workers/factory-owner.js";

const session = "9c622def-ff42-4698-9c2b-20472bc572f3";
const otherSession = "7c1925a7-ea52-4bb7-b986-06163716684a";
const token = "b".repeat(64);

describe("Factory worker ownership", () => {
  it("uses the host metadata and normalizes UUID case", () => {
    expect(factorySessionIdentity({ assemblySessionId: session.toUpperCase(), caller: "AGENT" })).toBe(session);
  });

  it.each([
    undefined, null, [], session, {}, { assemblySessionId: session },
    { assemblySessionId: "unknown-session", caller: "AGENT" },
    { assemblySessionId: session + "\n", caller: "AGENT" },
    { assemblySessionId: session, caller: "USER" },
  ])("rejects unavailable or invalid host metadata", meta => {
    expect(() => factorySessionIdentity(meta)).toThrow("session");
  });

  it("keeps ownership stable for a Factory session and separates other owners", () => {
    const scope = factoryWorkerScope(token, session);
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(factoryWorkerScope(token, session.toUpperCase())).toBe(scope);
    expect(factoryWorkerScope(token, otherSession)).not.toBe(scope);
    expect(factoryWorkerScope("c".repeat(64), session)).not.toBe(scope);
    expect(() => factoryWorkerScope("bad", session)).toThrow();
    expect(() => factoryWorkerScope(token, "unknown-session")).toThrow();
  });
});
