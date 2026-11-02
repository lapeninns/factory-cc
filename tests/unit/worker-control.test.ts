import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvalDigest, approvalSummary, sendWorkerDecision, startWorkerControl } from "../../src/workers/control.js";

describe("Exact-action worker decision channel", () => {
  it("refuses a changed or missing action and accepts only its current digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-control-")), path = join(root, "control.json");
    const input = { command: "npm test" }, approve = vi.fn();
    const control = await startWorkerControl({ status: () => ({ approvals: [{ id: "approval-1", input }] }), approve }, path);
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      expect((await fetch(config.url + "/decision", { method: "POST" })).status).toBe(401);
      await expect(sendWorkerDecision(path, { id: "worker-1", approvalId: "approval-1", actionDigest: "wrong", summary: approvalSummary({ input }), decision: "allow" })).rejects.toThrow();
      await expect(sendWorkerDecision(path, { id: "worker-1", approvalId: "approval-1", actionDigest: approvalDigest(input), summary: "A harmless unrelated action", decision: "allow" })).rejects.toThrow();
      expect(approve).not.toHaveBeenCalled();
      await sendWorkerDecision(path, { id: "worker-1", approvalId: "approval-1", actionDigest: approvalDigest(input), summary: approvalSummary({ input }), decision: "deny" });
      expect(approve).toHaveBeenCalledExactlyOnceWith({ id: "worker-1", approvalId: "approval-1", decision: "deny" });
    } finally { await control.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
