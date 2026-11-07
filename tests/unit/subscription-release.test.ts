import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageSubscriptionRelease, releaseEntries, verifySubscriptionRelease } from "../../scripts/package-subscription-release.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subscription-release-"))); roots.push(root);
  mkdirSync(join(root, "runtime")); writeFileSync(join(root, "runtime/worker.js"), "immutable worker\n", { mode: 0o600 });
  const manifest = () => writeFileSync(join(root, "release-manifest.json"), JSON.stringify({ version: 1, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), files: releaseEntries(root) }));
  manifest(); return { root, manifest };
}
it("detects modifications, deletions, added overlays and changed executable modes", () => {
  const { root, manifest } = fixture();
  expect(() => verifySubscriptionRelease(root)).not.toThrow();
  const file = join(root, "runtime/worker.js");
  writeFileSync(file, "overlay\n"); expect(() => verifySubscriptionRelease(root)).toThrow();
  manifest(); chmodSync(file, 0o700); expect(() => verifySubscriptionRelease(root)).toThrow();
  manifest(); writeFileSync(join(root, "extra.js"), "overlay"); expect(() => verifySubscriptionRelease(root)).toThrow();
  manifest(); rmSync(file); expect(() => verifySubscriptionRelease(root)).toThrow();
});
it("records internal dependency links and rejects escaping or broken dependencies", () => {
  const { root, manifest } = fixture();
  symlinkSync("worker.js", join(root, "runtime/worker-link")); manifest();
  expect(() => verifySubscriptionRelease(root)).not.toThrow();
  rmSync(join(root, "runtime/worker-link")); symlinkSync("/bin/sh", join(root, "runtime/worker-link"));
  expect(() => releaseEntries(root)).toThrow("escapes");
  rmSync(join(root, "runtime/worker-link")); symlinkSync("missing", join(root, "runtime/worker-link"));
  expect(() => releaseEntries(root)).toThrow();
});
it("refuses to replace an existing directory before invoking builds or dependency installation", () => {
  const { root } = fixture(), before = readFileSync(join(root, "release-manifest.json"), "utf8");
  expect(() => packageSubscriptionRelease("/missing-source", root)).toThrow("new absolute");
  expect(readFileSync(join(root, "release-manifest.json"), "utf8")).toBe(before);
});
