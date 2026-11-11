# Native Workstream recovery supervision

The local scheduler's `lastRunStatus: success` proves that a prompt was dispatched. It does not prove that Factory accepted a Workstream turn. On 2026-11-08 the native daemon rejected the scheduled turn with `missions_v2_disabled` immediately after a successful dispatch receipt. The agent could not report its own failure because its turn never started.

`scripts/workstream-supervisor.ts` runs independently of the agent. Factory continues to own Workstreams, agents, tools, interruption and the panel; the bridge supplies inference and read-only runtime evidence. This supervisor does not alter Factory feature flags, binaries, credentials, entitlements, models or account assignments.

## Evidence and recovery rules

- Bind an exact native orchestrator UUID and expected custom model using owned top-level session settings. Never infer identity from transcripts.
- Read the native logger's top-level rejection context, the original scheduler's receipt, bridge completed-turn metadata, authenticated matched host-tool events and assigned-account health.
- Require both a completed model response and a completed host tool after the recovery boundary before reporting `progress-verified`. A dispatch receipt alone remains unverified.
- For an explicit `missions_v2_disabled` or `workstreams_v2_disabled` rejection, wait two minutes, then schedule up to three native continuation attempts with delays of 5, 15 and 30 minutes from the respective rejection. Keep the incident budget across retries. Respect account cooldown; never rotate accounts.
- Use a separate owned native automation targeting the SAME session, with no model override. It resumes the checkpoint under existing user instructions. Never edit the original automation.
- Pause a queued delivery while the target, an unknown writer, an approval or an unclassified host action is active. Positively identified foreign Workstreams and their native child agents do not starve recovery. Unknown ancestry fails closed.
- Cancellation requires explicit operator resume. An idle run, missing scheduler receipt, unproductive dispatched retry or unknown rejection raises attention rather than blindly replaying work.
- Persist an intended automation hash before delivery. Accept only that hash or the prior acknowledged hash after a crash. Preserve external edits and report a fault.
- Hold one OS kernel lock across Python-to-Node exec. A crash releases the lock without a stale-lock timeout.

## Configuration and service

Use a private owner-only state directory and a private JSON config. `SupervisorConfig` lists the exact required paths. Set `recoveryEnabled: true` for bounded recovery; false is observation mode (a planned retry is reported but not delivered). `notificationExecutable` optionally names the Homebrew `terminal-notifier` executable. Notifications are deduplicated; durable `alert.json` remains authoritative, and a successful notification submission does not prove the user saw it.

The compiled entry point is `runtime/scripts/workstream-supervisor.js` inside a verified immutable subscription release. Launch with absolute paths:

```sh
/usr/bin/python3 /absolute/release/native-runtime/run_workstream_supervisor.py \
  /absolute/node /absolute/release/runtime/scripts/workstream-supervisor.js \
  --config /absolute/private/config.json
```

Install this as its own user LaunchAgent with `RunAtLoad`, `KeepAlive`, a 30-second throttle and private stdout/stderr logs. Do not restart productive bridge services to install it. It probes serially every 30 seconds. The launcher also accepts `--once` for acceptance checks.

`status.json` records checked time, mode, target, status, attempt budget and current evidence boundary. `alert.json` is null when clear. `supervisor.json` is internal durable state; do not hand-edit live state. Operator controls bypass the service lock safely through atomic intent delivery:

```sh
/absolute/node /absolute/release/runtime/scripts/workstream-supervisor.js \
  --config /absolute/private/config.json --intent pause
# Use complete when the agreed work finishes; continue explicitly rearms from now.
```

Mark completed work with `complete` to stop idle warnings. Rearming deliberately excludes older rejections and proof. Human changes to the owned retry automation produce a fault; reconcile them explicitly instead of allowing the supervisor to overwrite them.

## Acceptance and limits

The focused suites replay the actual overnight logger format through HTTP bridge observation and a real MCP pool server, check productive proof, cancellation, cooldown, budgets, crash reconciliation, external edits, ancestry, unknown writers and a real kernel lock including SIGKILL.

A native acceptance canary should first read a known file in a disposable repository, then exercise a seeded pending-retry intent through the real local scheduler. Confirm the same native UUID, expected exact output, matched host tool, completed model response and unchanged assigned account. Seeding a pending intent is a scheduler/restart acceptance test, not a claim that a real vendor access outage was induced or repaired.

Browser/mobile e2e is not applicable to this daemon and native scheduler. Native UI and runtime evidence are required. No watcher can guarantee upstream entitlement availability, operation while the Mac is asleep/off, or delivery while Factory's scheduler is stopped. Missed/unverified delivery remains visible. This is bounded recovery and detection, not a fix to Factory's organization-level gate.
