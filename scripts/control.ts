import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const usage = `Usage: npm run control -- <command>

  approvals                       List pending native tool approvals
  sessions                        List bridge sessions
  approve <id> [--input <file>]    Allow once; optionally supply an updated JSON input object
  deny <id> [--message <text>]     Deny a pending request
  cancel <sessionId>              Cancel a bridge session
  recover-checkpoint <bridgeSessionId> --factory-session <id> --sdk-session <id> --generation <n> [--dry-run]
                                  Return one failed pre-prompt continuation to its retained native
                                  checkpoint under a new lease generation. Every identity is required.
  recover-completed-host --input <file> [--dry-run]
                                  Reconcile a cancelled checkpoint whose exact host actions completed.
                                  JSON must contain explicit identity, operationId and expectedUpdatedAt.
                                  Apply also requires checkpointSha256 and receiptsSha256 from dry-run.
  restore-upstream-checkpoint --input <file> [--dry-run]
                                  Restore a clean quota-retry record's missing SDK reference from
                                  exact checkpoint, durable failure, cooldown and lease evidence.
                                  Apply includes returned hashes, including receiptsSha256 when receipts exist.

  retire-dormant-checkpoint --input <file> [--dry-run]
                                  Permanently retire one proven unused successor for an exact target.
                                  Requires explicit confirmation and full identity, version and proof hashes.

Set BRIDGE_ADMIN_TOKEN. BRIDGE_CONTROL_URL defaults to http://127.0.0.1:18787.
Only local HTTP(S) origins are accepted. The token is never accepted in arguments.`;

export function controlBaseUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? "http://127.0.0.1:18787"); }
  catch { throw new Error("BRIDGE_CONTROL_URL must be a local HTTP(S) origin."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("BRIDGE_CONTROL_URL must be a local HTTP(S) origin without credentials, query, or path.");
  }
  return url.origin;
}

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command, id, flag, value, ...rest] = args;
  if (command === "--help" || command === "-h" || !command) return usage;
  let path: string;
  let body: Record<string, unknown> | undefined;
  if (command === "approvals" || command === "sessions") {
    if (args.length !== 1) throw new Error(`Unexpected arguments for ${command}. Use --help.`);
    path = `/internal/${command}`;
  } else if (command === "approve" || command === "deny") {
    if (!id || id.startsWith("-") || rest.length || (flag && (flag !== (command === "approve" ? "--input" : "--message") || !value)) || (!flag && args.length !== 2)) {
      throw new Error(`Invalid arguments for ${command}. Use --help.`);
    }
    path = `/internal/approvals/${encodeURIComponent(id)}`;
    body = { decision: command === "approve" ? "allow" : "deny" };
    if (command === "approve" && flag) {
      let input: unknown;
      try { input = JSON.parse(readFileSync(value, "utf8")); }
      catch { throw new Error("Unable to read --input as JSON; no approval was sent."); }
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("--input must contain a JSON object; no approval was sent.");
      body.updatedInput = input;
    }
    if (command === "deny") body.message = value ?? "User denied this request through Relay Bridge CLI.";
  } else if (command === "recover-checkpoint") {
    path = "/internal/native-checkpoint-recovery";
    body = recoveryBody(args.slice(1));
  } else if (command === "recover-completed-host" || command === "restore-upstream-checkpoint" || command === "retire-dormant-checkpoint") {
    if (id !== "--input" || !flag || (value !== undefined && value !== "--dry-run") || rest.length) {
      throw new Error(`${command} requires --input <file> and optional --dry-run. Use --help.`);
    }
    let input: unknown;
    try { input = JSON.parse(readFileSync(flag, "utf8")); }
    catch { throw new Error("Unable to read recovery --input as JSON; no recovery was sent."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Recovery --input must contain a JSON object.");
    body = { ...input as Record<string, unknown>, ...(value ? { dryRun: true } : {}) };
    path = command === "recover-completed-host" ? "/internal/completed-host-recovery"
      : command === "retire-dormant-checkpoint" ? "/internal/dormant-checkpoint-retirement" : "/internal/upstream-checkpoint-recovery";
  } else if (command === "cancel") {
    if (!id || id.startsWith("-") || args.length !== 2) throw new Error("cancel requires exactly one session ID. Use --help.");
    path = "/internal/cancel";
    body = { sessionId: id };
  } else {
    throw new Error("Unknown control command. Use --help.");
  }

  const baseUrl = controlBaseUrl(env.BRIDGE_CONTROL_URL);
  const token = env.BRIDGE_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("BRIDGE_ADMIN_TOKEN is required.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Do not expose fetch causes, URLs, headers, or user-provided input in errors.
    // A failed response may follow a successful mutation: no implicit retries.
    throw new Error("Could not reach the local bridge. Check the URL and server, then list requests before retrying a decision.");
  }
  if (!response.ok && ["recover-checkpoint", "recover-completed-host", "restore-upstream-checkpoint", "retire-dormant-checkpoint"].includes(command) && response.status !== 401 && response.status !== 403) {
    let refusal: { type?: unknown; reason?: unknown } | undefined;
    try { refusal = ((await response.json()) as { error?: { type?: unknown; reason?: unknown } }).error; }
    catch { /* fall through to the generic message */ }
    // Only fixed refusal codes are shown; no server text is echoed.
    const code = (value: unknown): string | undefined => typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
    if (code(refusal?.type)) throw new Error(`Recovery refused: ${code(refusal!.type)}${code(refusal!.reason) ? ` (${code(refusal!.reason)})` : ""}.`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Administrator authentication failed or admin access is disabled.");
    if (response.status === 404 || response.status === 409) throw new Error("The request or session is unknown, expired, or already handled. Refresh the list.");
    throw new Error(`Bridge control request failed (HTTP ${response.status}).`);
  }
  try { return await response.json(); }
  catch { throw new Error("Bridge returned invalid JSON; list requests before retrying a decision."); }
}

function recoveryBody(args: string[]): Record<string, unknown> {
  const [bridgeSessionId, ...flags] = args;
  const fields: Record<string, string> = { "--factory-session": "factorySessionId", "--sdk-session": "sdkSessionId", "--generation": "nativeGeneration" };
  const body: Record<string, unknown> = { bridgeSessionId };
  const invalid = (): Error => new Error("recover-checkpoint requires a bridge session ID, --factory-session, --sdk-session and --generation. Use --help.");
  if (!bridgeSessionId || bridgeSessionId.startsWith("-")) throw invalid();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "--dry-run" && body.dryRun === undefined) { body.dryRun = true; continue; }
    const field = fields[flag];
    const value = flags[++index];
    if (!field || body[field] !== undefined || value === undefined || value.startsWith("-")) throw invalid();
    body[field] = field === "nativeGeneration" ? (/^(0|[1-9]\d{0,5})$/.test(value) ? Number(value) : Number.NaN) : value;
  }
  if (Object.values(fields).some(field => body[field] === undefined) || Number.isNaN(body.nativeGeneration)) throw invalid();
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControl(process.argv.slice(2)).then((result) => {
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Bridge control failed.");
    process.exitCode = 1;
  });
}
