# Run the desktop bridge for weeks

## Completed host actions after a lost connection

`recover-completed-host` is a separate administrator operation for a cancelled native checkpoint whose ended host actions all have authenticated successful receipts. It requires settled native leases, no live callback or approval, exact checkpoint contents and complete tool-result pairing. It refuses recorded administrator or host cancellation. A receipt-less or partially completed handoff requires separate investigation.

Create a private JSON request file with the exact values from the retained session record. Choose a new operation ID for this cancellation.

```json
{
  "operationId": "operator-selected-unique-id",
  "bridgeSessionId": "sess_example",
  "factorySessionId": "factory-session-id",
  "sdkSessionId": "11111111-2222-4333-8444-555555555555",
  "nativeGeneration": 0,
  "expectedUpdatedAt": "2026-11-10T02:19:52.000Z"
}
```

```sh
npm run control -- recover-completed-host --input /absolute/private/recovery.json --dry-run
```

For a historical record without cancellation provenance, include `"acknowledgeHistoricalDisconnect": true` only after establishing that the loss was a transport interruption. The audit keeps this as an operator attestation of an unknown historical origin. It does not label the origin as verified.

The dry run returns `checkpointSha256` and `receiptsSha256`. Add those two values to the same request file and run the command without `--dry-run`. It refuses a changed session, checkpoint, receipt set or lease. `BRIDGE_ADMIN_TOKEN` and the loopback `BRIDGE_CONTROL_URL` use the existing control interface.

Recovery preserves the original cancellation and successful receipts in the session audit, advances the native generation, and reconciles the actual completed outcomes in the first resumed native turn. It never edits the original native history. That first turn is reconciliation-only. An exact repeated tool name and input returns a clearly labelled historical receipt. Every new host action and native tool is denied. When the turn finishes, the audit records `reconciledAt`, and a subsequent normal user turn can resume ordinary work or intentionally perform an identical operation. Ambiguous duplicate actions and restoration context exceeding 64 KiB are refused during recovery preparation. A new cancellation requires a new recovery operation and current evidence.

## Native checkpoint retries after provider limits

An established supervised subscription session keeps its SDK checkpoint and assigned account after a verified clean upstream failure. The next attempt resumes that checkpoint under a new native lease generation. Fresh sessions that have no checkpoint retain their existing retry behavior.

Observed account cooldowns are minimum wait times. They are retained in session records, restored from those records and owned controller logs after restart, and excluded from session pruning while unexpired. An elapsed deadline permits another provider attempt. It does not establish remaining allowance or successful inference.

For a legacy clean upstream-retry record whose SDK field was already cleared, `restore-upstream-checkpoint` requires matching durable failure and cooling events, the exact current record version, complete native tool pairing, and a settled predecessor lease with the same SDK identity. The current generation must be unused. Explicit cancellation, unresolved work and newer conflicting evidence refuse restoration. Residual successful nonterminal host receipts are accepted only when their exact tool IDs, names, inputs and complete serialized results match the native checkpoint. The same atomic recovery record archives those full receipts and retires their consumed queue entries.

Prepare a private request file using the actual record identities and a new operation ID.

```json
{
  "operationId": "operator-selected-unique-id",
  "bridgeSessionId": "sess_example",
  "factorySessionId": "factory-session-id",
  "account": "team5",
  "sdkSessionId": "11111111-2222-4333-8444-555555555555",
  "nativeGeneration": 5,
  "expectedUpdatedAt": "2026-11-10T10:39:15.320Z"
}
```

```sh
npm run control -- restore-upstream-checkpoint --input /absolute/private/restore.json --dry-run
```

Add the returned `checkpointSha256`, `evidenceSha256` and `receiptsSha256` to that request file, then repeat the command without `--dry-run`. The operator supplies neither an account transfer nor a shorter cooldown. The bridge derives and preserves the greatest observed account deadline. Preserve the still-open Factory session until restoration is applied when its older runtime cannot preserve an SDK-absent record on host end.

On a fresh warm continuation, only exact previously settled tool IDs and result payloads may be omitted from the resent tool results. The proof retains these identities across repeated quota failures. Changed payloads and unrelated tool results are refused. Native history stays intact. Arbitrary extra native result blocks are refused during consumed-receipt restoration.

### Explicit retirement of an unused predecessor

An older idle checkpoint can block recovery even when its current generation never acquired a lease. After explicit operator approval, `retire-dormant-checkpoint` can permanently end that exact old record for one intended recovery target. It requires the old Factory, bridge, SDK, account, workspace, generation and record version, plus the target bridge identity and current version. Set `confirmNonResumable` to `true` in the private input file.

```json
{
  "operationId": "operator-selected-retirement-id",
  "bridgeSessionId": "sess_old",
  "factorySessionId": "factory-session-id",
  "sdkSessionId": "11111111-2222-4333-8444-555555555555",
  "account": "team5",
  "factoryCwd": "/absolute/verified/workspace",
  "nativeGeneration": 1,
  "expectedUpdatedAt": "2026-11-10T10:30:58.305Z",
  "targetBridgeSessionId": "sess_target",
  "targetExpectedUpdatedAt": "2026-11-10T11:47:01.835Z",
  "confirmNonResumable": true
}
```

```sh
npm run control -- retire-dormant-checkpoint --input /absolute/private/retirement.json --dry-run
```

The dry run requires an unused current generation, an exact terminal predecessor lease with verified cleanup and stopped owners, complete native tool pairing and an unchanged checkpoint. Runtime work, callbacks, approvals, receipts, state changes and newer leases cause refusal. Add the returned `checkpointSha256` and `evidenceSha256` before applying the same command without `--dry-run`.

The atomic record preserves the full original state and proof, retains its generation, SDK, history and cooldown, and marks the old session terminal and non-resumable. Recovery of the intended target revalidates that audit against the current native file and complete lease lineage. Before restoration, the target must retain its audited version, account and generation. After restoration, its unique matching recovery audit anchors the SDK and account while allowing ordinary progress and increasing generations. Ordinary cancellation and old timestamps alone provide insufficient evidence for the unused-generation exception. Recovery operations publish a complete journal through a private temporary file and atomic rename. A failure before rename preserves the earlier journal. If cleanup, snapshot or compaction maintenance fails after rename, the committed state remains published and a repeated operation verifies its existing audit.

A purpose-built retained-checkpoint proof permits an orderly host end after the in-memory SDK object has been retired. The bridge rechecks identity, file hash and settled leases before recording a resumable host end. A generic idle record receives no such exemption. If checkpoint retry preparation cannot be verified, the original SDK reference remains recorded and further cold imports for that Workstream are refused pending operator recovery.

Changed or compacted history cannot create a sibling native conversation in the same authenticated Factory scope while a retained checkpoint is unresolved. The caller must continue the exact lineage or complete its operator restoration. A different Factory session retains its independent admission path. A same-generation cancellation received while orderly host shutdown is awaiting proof remains terminal, including cancellation through the owning launch.

## Upgrade an existing installation

Merge the reviewed source into the checkout recorded in the desktop installation, then run these commands from that checkout:

```bash
npm ci
npm test
npm run desktop -- restart
npm run desktop -- status
```

`restart` rebuilds `dist/`, writes the new home-resident launcher and plist, then replaces the service. Existing native turns and in-memory tool callbacks end during replacement. Finish or explicitly stop your current Mission before upgrading. A successful build does not upgrade an already running service.

The LaunchAgent starts `/bin/sh` in its private home-volume state directory. That launcher waits for Node, `dist/index.js`, `dist/desktop-supervisor.js`, and the three token files. Its delay grows from 5 seconds to 60 seconds. It never creates a replacement directory under `/Volumes`.

After files return, the supervisor starts the bridge. Config errors, missing token files, and a port already in use do not trigger a tight launchd loop. Failed child starts back off at 5, 10, 20, 40, then 60 seconds. A child that ran for five minutes resets that backoff. `ThrottleInterval` remains 30 seconds for failures of the launcher or supervisor itself. The supervisor never stops an unrelated listener.

On service termination, the supervisor sends SIGTERM and allows the bridge's own ten-second shutdown to finish. Its separate ownership check waits up to twelve seconds before escalating to group TERM/KILL. A bridge that ignores SIGTERM cannot keep the supervisor waiting indefinitely.

If a Node upgrade removes the installed executable, run `restart` with the new Node executable. Keep the repository at its registered path. Restart does not move the installation to your current worktree.

## Check the service before restarting

```bash
npm run desktop -- status
launchctl print gui/$(id -u)/ai.factory-cc.bridge
```

`status` reads `/healthz` and uses the private admin-token file to summarize `/internal/runtime`. It prints no token or account address. `/healthz` stays limited to `{ ok, mode }`; it does not verify provider access.

Inspect these runtime values together:

- `slotsInUse`, `maxSlots`, and `maxIdleSessions` describe Claude query reservations and registered process trees. A stopping tree keeps its slot until OS exit is verified. The Cursor section reports its agent slots separately.
- `processes.liveProcesses` counts registered roots and observed descendants. It is sampled once per second; `lastScanAt` identifies the sample. `ownedTrees` also includes trees still being verified or retried after cleanup failure.
- `pendingHostCalls`, `pendingApprovals`, `activeNativeTurns`, and `oldestTurnMs` distinguish a generation from a parked Mission. An old turn with a live tool callback is not evidence of a wedged process.
- `processes.reaperKills` counts orphan-owner reclamations, and `reaperFailures` reports failed cleanup or sampling. `cursor.cleanupTimeouts` reports cancellation or store-disposal deadlines.
- `activeRequests`, `retainedSessions`, `workerEndTimers`, `compactionLinks`, and `memory` expose other retained work and process memory.

The bridge samples only PID, PPID, process group, birth identity, and process state. It does not scan process arguments or environments. New Claude queries use the official SDK spawn hook and a dedicated process group. Release closes the SDK/input, waits up to 2 seconds, sends TERM, waits up to 2 seconds, then sends KILL and verifies for up to 1 second. Escalation uses process identity rather than Node's `child.killed` flag. The periodic reaper retries registered owners no live query owns. It never uses `pkill claude` or adopts another application's CLI.

Keep recent idle sessions warm to avoid startup on every turn. The default retains at most four resumable idle Claude queries and four idle Cursor agents; each runtime has a hard limit of 32. The session store also limits active work across providers to 32. LRU eviction preserves the native checkpoint. Requests returning during retirement wait for the old process to die before resuming it. Pending tools, approvals, background tasks, and active requests prevent idle eviction.

If all slots hold live work, expect 429. The bridge does not restart itself or discard callbacks to make that response disappear. Existing idle/max turn watchdogs interrupt stalled generation. A Mission waiting on a person or its workers remains parked until an authenticated end/cancel, confirmed compaction, or its tool deadline. Check the host before ending that work.

## Diagnose startup and provider errors

Read the private `stdout.log`, `stderr.log`, and `bridge-data/logs/bridge.jsonl` under `~/Library/Application Support/factory-cc`. Keep credentials and conversation bodies out of reports.

- For `desktop_waiting_for_files`, check the external volume, registered repository and Node paths, built entrypoints, and nonempty private token files. Do not recreate the mountpoint on the internal disk.
- For `desktop_retry`, inspect the preceding child error. `EADDRINUSE` means another listener owns the port. A token-file read error or config validation error needs the named local file or setting corrected. The supervisor retries without killing the port owner.
- For `sdk_start_timeout`, inspect CPU/memory pressure and process/slot counts. No prompt was sent. `startupMs` measures the `accountInfo()` initialization handshake, not model generation or total HTTP latency. `request_admitted.admissionMs` covers parsing/correlation/state writes after body upload. `sdk_turn_prepared.preparationMs` covers runtime preparation through prompt submission, with `queryReused`, `coldImport`, and imported message counts. `sdk_imported.importMs` and changed `droid_catalog_updated.catalogMs` isolate first import and catalog refresh. The default startup limit is 60 seconds, capped by the turn's idle limit.
- For HTTP 429 `rate_limit_error`, wait for `retry-after` when supplied. Explicit SDK `api_retry` events can hand back 429/529 early, using the SDK delay when available. Exact accepted requests with complete prior client history can retry through a fresh query after verified cleanup. Only requests without unresolved callbacks, background tasks, or native work qualify; previous tool results become reference history, never re-executed callbacks. If native work prevents safe reimport, the SDK keeps its retry and `upstreamBackoffs` reports why. HTTP 529 is `overloaded_error`. The bridge translates explicit upstream types/statuses and does not guess a cooldown from arbitrary prose. Failed queries are closed and their OS ownership remains until verified dead.
- For an error after SSE content began, inspect the Anthropic `error` event. HTTP headers cannot change after content. Before the first content, the bridge can return a JSON error with its real HTTP status and known `retry-after`; keepalive pings start with the stream.
- For old launchd exit 78, inspect launchd diagnostics as well as application logs. A missing `WorkingDirectory` can fail before Node starts and leave no application error. A `runs` count alone does not identify the configuration error.

## Recover a failed native continuation

Before BR-08, a continuation after a controller restart could reuse the previous
controller's lease generation. The lease helper refused it, the bridge marked the
record FAILED before any prompt was sent, and the next request cold-imported the
whole Factory history. Current builds give that continuation a new generation.
A record that already failed this way needs one explicit operator action. Run it
while the Workstream is held, because a continuation sent first is cold-imported
into a new session again.

```bash
BRIDGE_CONTROL_URL=http://127.0.0.1:<controller-port> BRIDGE_ADMIN_TOKEN=<from the private token file> \
  npm run control -- recover-checkpoint <bridgeSessionId> \
    --factory-session <factorySessionId> --sdk-session <sdkSessionId> --generation <failedGeneration> --dry-run
```

Run it again without `--dry-run` to apply. The command calls the admin-only
`POST /internal/native-checkpoint-recovery`. All four identities are required and
must come from the owning records (the bridge session record and its lease). The
bridge never picks a checkpoint itself. A refusal prints a fixed code such as
`native_recovery_refused (lease_owner_alive)`. A refusal or dry run changes nothing.

The operation succeeds only when every check holds:

- The controller runs the supervised subscription pool. The record exists, is not
  a Cursor session, and its Factory session, SDK session ID, generation and
  configured account equal the request. The next generation stays within the limit.
- The record is FAILED, without a cancel request, host end marker, pending or
  ended tool IDs, or stored host receipts. Its notes do not record a restart during
  generation, a restart while waiting for a tool, or an interrupted timeout. It has
  completed at least one turn.
- No HTTP request, approval, live native query, protected native work, pending host
  call or process-local lease identity holds the record. The same applies to
  every other record of that Factory session.
- No other record of that Factory session completed a turn after this record was
  created, or still has completed turns and is not ended. A later cold import that
  never completed a turn does not block recovery and stays FAILED.
- Read-only lease inspection finds exactly one lease for this generation that
  matches the Factory session, workspace, policy and account. That lease is
  `cancelled` by a session-level update (an orderly close or cancel confirmed
  while no phase was admitted). It has verified cleanup, no external cleanup
  flag, no host reservation, and no live owner or helper process. Its recorded
  checkpoint equals the requested SDK session ID.
- That lease ended before the record's last change. No newer generation exists.
  Every other generation is terminal, clean and has no live owner or helper.

When the operation is applied, the record becomes IDLE under the next generation.
The SDK checkpoint and history fingerprints are kept, and a
`native-checkpoint-recovered:gN->gN+1` note and a `checkpointRecoveries` receipt
are added. The receipt records the failure time and the lease end. Lease files,
the failed attempt and later failed siblings are not changed. Repeating the call
returns `alreadyRecovered` and never rewrites later work. The next continuation
resumes the retained checkpoint with official SDK resume. The lease helper checks
the new generation again at that point.

Limitations: recovery returns the checkpoint to service. It does not shrink a
conversation that is too large for the model. The continuation must still match
the record's completed history, so a Factory transcript that was rewritten after
the failure may still start a new session. Refused requests log
`native_checkpoint_recovery_refused` with the fixed reason only.
## Keep state bounded

JSONL logs default to 10 MiB per file plus one `.1` generation. An individual record larger than the cap becomes a size-only omission marker. Desktop stdout and stderr each retain 2 MiB plus one generation; the supervisor reopens files for every append, so rotation does not leave it writing to a renamed file descriptor. Private file modes remain 0600.

Every minute, the bridge expires inactive session metadata older than seven days and retains at most 1,000 inactive records. It protects active requests, authenticated live hosts, native background work, approvals, and pending callbacks. The journal compacts after 256 writes or 8 MiB of updates. A snapshot itself can exceed 8 MiB when retained records require it. Active work can exceed the retention count; the count is not permission to delete it.

Expired Cursor checkpoints are removed through the SDK store's exact `agentIds` filter, after closing an inactive agent. A checkpoint referenced by another retained session is preserved. Never delete an open SQLite file or use an empty delete filter. Claude transcripts outside the bridge data directory belong to Claude Code and are not deleted by bridge retention. Long active native transcripts can still consume disk.

Completed mailbox records retain at most 256 calls and 2 MiB of payloads. Older duplicate results fail closed. Request/completion fingerprints use SHA-256. SDK/Cursor event arrays retain 1,000 recent entries; usage deduplication retains 4,096 recent provider-message identities and cumulative counters. After that window, usage coverage is marked partial rather than claiming exact historical deduplication.

For a directly launched bridge, the relevant environment overrides are `BRIDGE_MAX_SESSIONS`, `BRIDGE_MAX_IDLE_SESSIONS`, `BRIDGE_SDK_START_TIMEOUT_MS`, `BRIDGE_LOG_MAX_BYTES`, `BRIDGE_SESSION_MAX_RECORDS`, and `BRIDGE_SESSION_RETENTION_MS`. The desktop plist uses the defaults and intentionally does not import arbitrary shell environment variables. Do not put provider keys into the plist.

## Reproduce the isolated acceptance checks

Run the offline soak with real owned Node children and a fake SDK protocol:

```bash
npm run test:soak -- 500
npm run test:soak:sdk-local
```

Both fixtures use port 18797, isolated state under `tmp/`, bounded logs, and explicit process ownership. The fake-protocol soak has a ten-minute deadline and forced-GC heap samples. It asserts zero surviving child processes, zero slots after close, and bounded retained state. The fake recorder keeps only recent query objects so the test does not measure its own history retention. The real SDK/CLI localhost fixture has a five-minute deadline and verifies warm reuse, 429/529 with safe retries, and cancellation after stream content.

The provider check requires an existing helper-based Claude configuration and the bridge-owned Cursor credential. It reads the original helper configuration at execution time, runs that helper in its original HOME, and gives the actual CLI a temporary HOME and configuration directory. It does not copy keys or the original helper command. `BRIDGE_CURSOR_AUTH_FILE` is a read-only credential source override; writes/login still target the test data directory.

```bash
npm run verify:long-run -- --run --mission
```

This command spends configured provider quota. It checks port 18797 before starting, launches `dist/index.js`, records owned PIDs, forces SDK startup timeout, runs short Haiku/Composer sessions, cancels a real stream, drives isolated Droid, and attempts one tiny Claude-orchestrated Composer Mission. Its total deadline is 25 minutes. Inspect its `result.json`, private logs, and cleanup result; a product test alone does not certify Mission completion. Native browser/desktop GUI acceptance and weeks of wall-clock soak are separate checks.

The Mission profile uses four slots so its orchestrator can park while workers run. Without `--mission`, the profile uses one slot to force idle eviction. `--mission --mission-only` runs just the Haiku check and Mission. Provider and SDK-local fixtures refuse nonempty output directories; use a fresh path for each `BRIDGE_LIVE_DIR` or `BRIDGE_SOAK_DIR`. `BRIDGE_EVIDENCE_DIR` and `BRIDGE_EVIDENCE_PIDS` can point to a separate append-only evidence trail.
