import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ReleaseEntry = { path: string; sha256: string; mode: number } | { path: string; link: string };
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A release owns its entire executable closure; private configuration stays outside it. */
export function releaseEntries(root: string): ReleaseEntry[] {
  const result: ReleaseEntry[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), local = relative(root, path), info = lstatSync(path);
      if (local === "release-manifest.json") continue;
      if (info.isSymbolicLink()) {
        const target = relative(root, realpathSync(path));
        if (target === ".." || target.startsWith("../") || isAbsolute(target)) throw new Error("Release link escapes its artifact.");
        result.push({ path: local, link: readlinkSync(path) });
      } else if (info.isDirectory()) visit(path);
      else if (info.isFile()) result.push({ path: local, sha256: hash(readFileSync(path)), mode: info.mode & 0o777 });
      else throw new Error("Release contains an unsupported file type.");
    }
  }
  visit(root);
  return result;
}

export function verifySubscriptionRelease(root: string): void {
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
  if (manifest.version !== 1 || !/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit)
      || !/^[a-f0-9]{40,64}$/.test(manifest.sourceTree) || !Array.isArray(manifest.files)
      || JSON.stringify(manifest.files) !== JSON.stringify(releaseEntries(root))) throw new Error("Release manifest verification failed.");
}

/** Build a complete new artifact. Does not install services, read accounts, or change live pointers. */
export function packageSubscriptionRelease(source: string, output: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  if (!isAbsolute(output) || existsSync(output) || realpathSync(dirname(output)) !== resolve(dirname(output))) throw new Error("Use a new absolute release directory under a canonical existing parent.");
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Package only a clean committed source tree.");
  const sourceCommit = git("rev-parse", "HEAD"), sourceTree = git("rev-parse", "HEAD^{tree}");
  const staging = output + ".staging-" + randomUUID();
  mkdirSync(staging, { mode: 0o700 });
  try {
    rmSync(join(source, "workers-dist"), { recursive: true, force: true });
    execFileSync("npm", ["run", "build:workers"], { cwd: source, stdio: "inherit" });
    cpSync(join(source, "workers-dist"), join(staging, "runtime"), { recursive: true });
    // Never copy ignored local state, caches or credentials from the native source directory.
    const nativeFiles = execFileSync("git", ["-C", source, "ls-files", "-z", "--", "native-runtime"], { encoding: "utf8" }).split("\0").filter(Boolean);
    if (!nativeFiles.length) throw new Error("Native runtime source is missing.");
    for (const name of nativeFiles) {
      mkdirSync(dirname(join(staging, name)), { recursive: true });
      cpSync(join(source, name), join(staging, name));
    }
    for (const name of ["package.json", "package-lock.json"]) cpSync(join(source, name), join(staging, name));
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, stdio: "inherit" });
    // Verify the actual dependency closure inside this artifact, not the source node_modules.
    const module = pathToFileURL(join(staging, "runtime/src/runtime/native-workflow-support.js")).href;
    const runtime = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m=await import(${JSON.stringify(module)}); const r=m.assertNativeWorkflowSupport(); console.log(JSON.stringify({sdkVersion:r.sdkVersion,cliVersion:r.cliVersion,sha256:r.sha256}));`], { encoding: "utf8" }));
    if (git("rev-parse", "HEAD") !== sourceCommit || git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Source changed during packaging.");
    writeFileSync(join(staging, "release-manifest.json"), JSON.stringify({ version: 1, sourceCommit, sourceTree,
      dependencyLockSha256: hash(readFileSync(join(staging, "package-lock.json"))), runtime,
      modelRequestsMade: false, files: releaseEntries(staging) }, null, 2) + "\n", { mode: 0o600 });
    verifySubscriptionRelease(staging);
    if (existsSync(output)) throw new Error("Release destination appeared during packaging.");
    renameSync(staging, output);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [operation, output] = process.argv.slice(2);
  try {
    if (!output || process.argv.length !== 4 || !["--output", "--verify"].includes(operation!)) throw new Error();
    if (operation === "--verify") verifySubscriptionRelease(output);
    else packageSubscriptionRelease(resolve(dirname(fileURLToPath(import.meta.url)), ".."), output);
    console.log(JSON.stringify({ verified: true, liveServicesChanged: false, modelRequestsMade: false }));
  } catch { console.error("Release packaging or verification failed. No live service pointers were changed."); process.exitCode = 1; }
}
