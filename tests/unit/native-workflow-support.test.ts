import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { assertNativeWorkflowSupport, NATIVE_WORKFLOW_BUILD } from "../../src/runtime/native-workflow-support.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(readFileSync).mockReset().mockImplementation(actual.readFileSync);
});

describe("native workflow build pin", () => {
  it("accepts only the inspected bundled runtime, with an explicit executable", () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      expect(() => assertNativeWorkflowSupport()).toThrow(/inspected macOS arm64/);
      return;
    }
    const support = assertNativeWorkflowSupport();
    expect(support.sha256).toBe(NATIVE_WORKFLOW_BUILD.sha256);
    expect(support.sdkVersion).toBe("0.3.300");
    expect(support.cliVersion).toBe("2.1.300");
    expect(support.executable).toMatch(/claude-agent-sdk-darwin-arm64\/claude$/);
    expect(assertNativeWorkflowSupport()).toEqual(support);
  });
  it("rejects replaced binary bytes after an earlier successful check", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    assertNativeWorkflowSupport();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync)
      .mockImplementationOnce(actual.readFileSync)
      .mockImplementationOnce(actual.readFileSync)
      .mockReturnValueOnce(Buffer.from("replacement runtime"));
    expect(() => assertNativeWorkflowSupport()).toThrow(/digest differs/);
  });
});
