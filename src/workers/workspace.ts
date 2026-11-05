import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_GIT_BYTES = 128 * 1024 * 1024;
const CACHES = new Set(["node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo"]);
const PRIVATE_STATE = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
const APPLICATION_STATE = new Set(["sessions", "logs", "backups", "workers", "subscription-runtime", "team-runtime", "auth", "projects", "debug", "session-env"]);

interface SnapshotFile { path: string; mode: number; digest?: string; link?: string }
export interface WorkerWorkspaceSource {
  repository: string;
  directory: string;
  kind: "git" | "folder" | "unborn";
  sourceCommit?: string;
  sourceDirty: boolean;
  files: SnapshotFile[];
  originalFiles: string[];
  snapshot: { files: number; bytes: number; ignoredUntrackedFiles: boolean; excluded: Array<{ path: string; reason: string }> };
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(".." + sep) && part !== ".." && !isAbsolute(part));
}

function pathName(value: string): string {
  if (!value || isAbsolute(value) || value.split(/[\\/]/).some(part => part === ".." || part === ".git") || value.includes("\0")) throw new Error("Unsafe workspace input path.");
  return value;
}

function excluded(path: string, tracked: boolean, publicPemCandidate = false): string | undefined {
  const names = path.split(/[\\/]/);
  if (names.includes(".git")) return "Git metadata";
  if (names.some(name => PRIVATE_STATE.has(name))) return "Private application or credential state";
  if (names.some((name, index) => [".factory", ".claude", ".codex"].includes(name) && APPLICATION_STATE.has(names[index + 1] ?? ""))) return "Private application runtime state";
  if (names.some(name => /^\.env(?:\.|$)/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name)
      || /^(?:credentials(?:\.json)?|\.credentials(?:\.json)?|id_rsa|id_ed25519|\.npmrc|\.netrc)$/i.test(name)
      || /\.(?:p12|pfx)$/i.test(name)
      || (!publicPemCandidate && /\.(?:pem|key)$/i.test(name)))) return "Credential or private environment file";
  if (!tracked && names.some(name => CACHES.has(name))) return "Generated dependency or cache directory";
  return undefined;
}

function containsOnlyPublicPem(bytes: Buffer): boolean {
  const match = /^\s*-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY|CERTIFICATE)-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END \1-----\s*$/.exec(bytes.toString("utf8"));
  if (!match) return false;
  const encoded = match[2]!.replace(/[\r\n]/g, ""), der = Buffer.from(encoded, "base64");
  if (der.toString("base64") !== encoded) return false;
  try {
    const parsed = match[1] === "CERTIFICATE" ? new X509Certificate(bytes).raw
      : createPublicKey(bytes).export({ format: "der", type: match[1] === "RSA PUBLIC KEY" ? "pkcs1" : "spki" });
    return parsed.equals(der);
  } catch { return false; }
}

function containsCredentialConfig(path: string, bytes: Buffer): boolean {
  if (!/(?:^|[\\/])\.(?:factory|claude|codex)(?:[\\/]|\.json$)/.test(path)) return false;
  if (!/\.(?:json|jsonc|toml|ya?ml)$/i.test(path)) return false;
  const text = bytes.toString("utf8");
  const credentialFields = credentialScanText(path, text);
  return /(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)["']?\s*[:=]\s*["']?[^\s"'\]}]+)/i.test(credentialFields)
    || /(?:sk-ant-(?:api|oat)[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,})/.test(text);
}

function credentialScanText(path: string, text: string): string {
  if (!/(?:^|[\\/])\.claude[\\/]launch\.json$/.test(path)) return text;
  try {
    const launch = JSON.parse(text);
    if (!Array.isArray(launch?.configurations)) return text;
    let credentialFields = text;
    for (const configuration of launch.configurations) {
      if (typeof configuration?.runtimeExecutable !== "string"
          || !["sh", "bash", "zsh"].includes(basename(configuration.runtimeExecutable))
          || !Array.isArray(configuration.runtimeArgs) || configuration.runtimeArgs[0] !== "-c"
          || typeof configuration.runtimeArgs[1] !== "string") continue;
      const command = configuration.runtimeArgs[1];
      // Recognize only leading, unquoted assignment words. Quoting, expansion
      // and shell operators end this prefix and retain the original scan.
      const prefix = /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+,\-]*[ \t]+)+/.exec(command)?.[0];
      if (!prefix) continue;
      // KEY= NEXT=value clears KEY. Keep NEXT available for credential checks.
      const scannedCommand = prefix.replace(/\b[A-Za-z_][A-Za-z0-9_]*=(?=[ \t]+[A-Za-z_][A-Za-z0-9_]*=)/g, "=")
        + command.slice(prefix.length);
      // Retain the original JSON, including duplicate fields, for the scan.
      credentialFields = credentialFields.replaceAll(JSON.stringify(command), JSON.stringify(scannedCommand));
    }
    return credentialFields;
  } catch { return text; }
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repository, ...args], {
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.stdout;
}

/** Inspect inputs before creating any worker-owned state. The source remains read-only. */
export async function inspectWorkerWorkspace(path: string, allowFolders: boolean): Promise<WorkerWorkspaceSource> {
  if (!isAbsolute(path)) throw new Error("Workspace paths must be absolute.");
  const directory = realpathSync(path), info = lstatSync(directory);
  if (directory !== resolve(path)) throw new Error("Use the canonical workspace path without symlink ancestors.");
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("Workspace must be owned by this user.");
  let repository = directory, kind: WorkerWorkspaceSource["kind"] = "folder", sourceCommit: string | undefined;
  try {
    if ((await git(directory, ["rev-parse", "--is-bare-repository"])).trim() === "true") throw new Error("Use a non-bare repository.");
    repository = realpathSync((await git(directory, ["rev-parse", "--show-toplevel"])).trim());
    const marker = lstatSync(join(repository, ".git"));
    if (marker.isSymbolicLink() || marker.uid !== process.getuid?.()) throw new Error("Owned Git metadata must not be redirected through a symlink.");
    const metadata = realpathSync((await git(repository, ["rev-parse", "--absolute-git-dir"])).trim());
    if (lstatSync(metadata).uid !== process.getuid?.()) throw new Error("Git metadata must be owned by this user.");
    try { sourceCommit = (await git(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim(); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    kind = sourceCommit ? "git" : "unborn";
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr !== "string" || !stderr.includes("not a git repository")) throw error;
  }
  if (kind !== "git" && !allowFolders) throw new Error("This worker policy requires a committed Git repository. Use owned-workspace for ordinary folders and new repositories.");
  if (!inside(repository, directory)) throw new Error("Workspace directory escaped its repository.");
  const tracked = new Set<string>();
  let candidates: string[];
  let originalFiles: string[] = [];
  const exclusions: Array<{ path: string; reason: string }> = [];
  if (kind !== "folder") {
    for (const name of (await git(repository, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean)) tracked.add(pathName(name));
    candidates = [...new Set([...tracked, ...(await git(repository, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).map(pathName)])];
    if (sourceCommit) originalFiles = (await git(repository, ["ls-tree", "-r", "--name-only", "-z", sourceCommit])).split("\0").filter(Boolean).map(pathName);
  } else {
    candidates = [];
    const walk = (prefix: string): void => {
      for (const name of readdirSync(join(repository, prefix))) {
        const path = prefix ? join(prefix, name) : name;
        const reason = excluded(path, false);
        if (reason) { exclusions.push({ path, reason }); continue; }
        const stat = lstatSync(join(repository, path));
        if (stat.isDirectory()) walk(path);
        else candidates.push(pathName(path));
        if (candidates.length > MAX_FILES || exclusions.length > MAX_FILES) throw new Error("Workspace exceeds the 10000-file snapshot limit.");
      }
    };
    walk("");
  }
  const files: SnapshotFile[] = [];
  const maxBytes = kind === "git" ? MAX_GIT_BYTES : MAX_BYTES;
  const snapshotLimitError = `Workspace exceeds the ${maxBytes / (1024 * 1024)} MiB snapshot limit.`;
  let bytes = 0;
  let untrackedBytes = 0;
  for (const path of candidates.sort()) {
    if (files.length >= MAX_FILES || exclusions.length >= MAX_FILES) throw new Error("Workspace exceeds the 10000-file snapshot limit.");
    const publicPemCandidate = tracked.has(path) && /\.(?:pem|key)$/i.test(path);
    const reason = excluded(path, tracked.has(path), publicPemCandidate);
    if (reason) {
      if (tracked.has(path)) throw new Error("A tracked credential file cannot enter a worker snapshot. Remove it from the task input before continuing.");
      exclusions.push({ path, reason }); continue;
    }
    const source = join(repository, path);
    let stat: Stats;
    try { stat = lstatSync(source); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
    if (!inside(repository, realpathSync(source))) throw new Error("A workspace input resolves outside the assigned source.");
    if (stat.uid !== process.getuid?.()) throw new Error("Every workspace input must be owned by this user.");
    if (stat.isSymbolicLink()) {
      if (publicPemCandidate) throw new Error("A tracked public PEM input must be a regular file.");
      const target = realpathSync(source);
      if (!inside(repository, target)) throw new Error("A workspace symlink points outside the assigned source.");
      if (excluded(relative(repository, target), false)) throw new Error("A workspace symlink resolves into an excluded input.");
      files.push({ path, mode: stat.mode & 0o777, link: relative(dirname(source), target) });
    } else if (stat.isFile()) {
      if (bytes + stat.size > maxBytes) throw new Error(snapshotLimitError);
      const untrackedGitInput = kind === "git" && !tracked.has(path);
      if (untrackedGitInput && untrackedBytes + stat.size > MAX_BYTES) throw new Error("Workspace exceeds the 64 MiB untracked input limit.");
      const content = readFileSync(source);
      if (publicPemCandidate && !containsOnlyPublicPem(content)) throw new Error("A tracked credential file cannot enter a worker snapshot. Only a single validated public key or certificate is allowed.");
      if (containsCredentialConfig(path, content)) {
        if (tracked.has(path)) throw new Error("A tracked credential configuration cannot enter a worker snapshot.");
        exclusions.push({ path, reason: "Credential-bearing application configuration" }); continue;
      }
      bytes += content.length;
      if (untrackedGitInput) untrackedBytes += content.length;
      if (bytes > maxBytes) throw new Error(snapshotLimitError);
      if (untrackedBytes > MAX_BYTES) throw new Error("Workspace exceeds the 64 MiB untracked input limit.");
      files.push({ path, mode: stat.mode & 0o777, digest: createHash("sha256").update(content).digest("hex") });
    } else if (stat.isDirectory() && tracked.has(path)) throw new Error("Submodule directories need their own explicit worker workspace.");
    else if (!stat.isDirectory()) throw new Error("Unsupported workspace input file type.");
  }
  const sourceDirty = kind !== "git" || Boolean((await git(repository, ["status", "--porcelain", "--untracked-files=normal"])).trim());
  return { repository, directory, kind, sourceCommit, sourceDirty, files, originalFiles,
    snapshot: { files: files.length, bytes, ignoredUntrackedFiles: kind !== "folder", excluded: exclusions } };
}

/** Materialize a bounded input snapshot in a linked worker worktree. */
export async function prepareWorkerWorkspace(source: WorkerWorkspaceSource, worktree: string, branch: string): Promise<{ inputCommit: string; workingDirectory: string }> {
  const snapshotRepository = source.sourceCommit ? undefined : worktree + ".snapshot-source";
  if (snapshotRepository) {
    // These paths are allocated for one worker. Refuse existing paths before
    // taking ownership so failure cleanup cannot remove another workspace.
    for (const path of [snapshotRepository, worktree]) {
      try { lstatSync(path); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
      throw new Error("Worker snapshot paths must be unused.");
    }
    // Retain this repository beside the successful worktree because its Git
    // object store and worktree metadata remain part of the worker result.
    mkdirSync(snapshotRepository, { mode: 0o700 });
  }
  let snapshotWorktreeCreated = false;
  try {
    if (snapshotRepository) {
      mkdirSync(worktree, { mode: 0o700 });
      snapshotWorktreeCreated = true;
      await git(snapshotRepository, ["init", "-q"]);
      await git(snapshotRepository, ["-c", "user.name=Factory Worker", "-c", "user.email=worker@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Initialize private worker snapshot"]);
      await git(snapshotRepository, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    } else {
      await git(source.repository, ["worktree", "add", "-b", branch, worktree, source.sourceCommit!]);
    }
    const copied = new Set(source.files.map(file => file.path));
    for (const path of source.originalFiles) if (!copied.has(path)) rmSync(join(worktree, path), { force: true, recursive: true });
    for (const file of source.files) {
      const input = join(source.repository, file.path), destination = join(worktree, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      if (file.link !== undefined) {
        if (realpathSync(input) !== resolve(dirname(input), file.link)) throw new Error("A workspace symlink changed during snapshot preparation.");
        rmSync(destination, { force: true, recursive: true });
        symlinkSync(file.link, destination);
      } else {
        if (!lstatSync(input).isFile() || createHash("sha256").update(readFileSync(input)).digest("hex") !== file.digest) throw new Error("A workspace input changed during snapshot preparation.");
        // A source change can replace a committed directory or link with a
        // regular file; remove whatever non-file entry the checkout left there.
        const existing = lstatSync(destination, { throwIfNoEntry: false });
        if (existing && !existing.isFile()) rmSync(destination, { force: true, recursive: true });
        copyFileSync(input, destination);
        chmodSync(destination, file.mode);
        if (createHash("sha256").update(readFileSync(destination)).digest("hex") !== file.digest) throw new Error("A workspace input changed while copying.");
      }
    }
    await git(worktree, ["add", "-A"]);
    if (!source.sourceCommit || (await git(worktree, ["status", "--porcelain"])).trim()) {
      await git(worktree, ["-c", "user.name=Factory Worker", "-c", "user.email=worker@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Capture worker input snapshot"]);
    }
    const workingDirectory = resolve(worktree, relative(source.repository, source.directory));
    if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
    return { inputCommit: (await git(worktree, ["rev-parse", "HEAD"])).trim(), workingDirectory };
  } catch (error) {
    if (snapshotRepository) {
      if (snapshotWorktreeCreated) {
        await git(snapshotRepository, ["worktree", "remove", "--force", worktree]).catch(() => {});
        rmSync(worktree, { recursive: true, force: true });
      }
      rmSync(snapshotRepository, { recursive: true, force: true });
    }
    throw error;
  }
}
