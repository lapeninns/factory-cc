import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BridgeError } from "../types.js";

/** Workflow's remote-agent rejection is build-specific, not an SDK promise.
 * Keep this opt-in experiment on the exact inspected, unmodified binary.
 * Updating this pin requires a new remote-negative native execution probe. */
export const NATIVE_WORKFLOW_BUILD = Object.freeze({
  sdkVersion: "0.3.300",
  cliVersion: "2.1.300",
  platformPackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  sha256: "475517caa611e3318a2f298fa071287ec98955538df78c58f709ecc01e5ae2d3",
});

export interface NativeWorkflowSupport {
  executable: string;
  sdkVersion: string;
  cliVersion: string;
  sha256: string;
}

export function assertNativeWorkflowSupport(): NativeWorkflowSupport {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Only the inspected macOS arm64 workflow runtime is supported.");
    const require = createRequire(import.meta.url);
    const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
    const platformDir = dirname(require.resolve(`${NATIVE_WORKFLOW_BUILD.platformPackage}/package.json`));
    const platform = JSON.parse(readFileSync(join(platformDir, "package.json"), "utf8"));
    if (sdk.version !== NATIVE_WORKFLOW_BUILD.sdkVersion || sdk.claudeCodeVersion !== NATIVE_WORKFLOW_BUILD.cliVersion || platform.version !== NATIVE_WORKFLOW_BUILD.sdkVersion) {
      throw new Error("SDK or bundled CLI version differs from the inspected workflow build.");
    }
    const executable = join(platformDir, "claude");
    const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
    if (sha256 !== NATIVE_WORKFLOW_BUILD.sha256) throw new Error("Bundled CLI digest differs from the inspected workflow build.");
    // Recheck for each launch: npm can replace the file at the same path while
    // the bridge process remains running. Never reuse an earlier verification.
    return Object.freeze({ executable, sdkVersion: sdk.version, cliVersion: sdk.claudeCodeVersion, sha256 });
  } catch (error) {
    throw new BridgeError(503, "workflow_runtime_unverified", `Native workflows remain disabled: ${error instanceof Error ? error.message : "runtime verification failed"}`);
  }
}
