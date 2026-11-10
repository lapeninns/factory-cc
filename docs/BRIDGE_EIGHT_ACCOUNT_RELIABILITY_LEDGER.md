# Bridge eight-account reliability ledger (BR-01 to BR-08)

Date: 2026-11-09. Base: `88b3e4212ad7464da080172ecce01bbe96e7efab`, branch
`codex/bridge-eight-account-reliability`. Evidence below uses sanitised aggregates
only: event names, counts, sizes, codes and account labels. No transcript, prompt,
credential or private configuration content was copied.

## BR-01 Baseline and reproduction

Source: the live controller log `reliable-20261103T123907Z/controller/logs/bridge.jsonl`,
read by a parser that printed only allowlisted numeric and code fields.

| Cold import (UTC) | Messages | Content bytes | Next turn |
| --- | --- | --- | --- |
| 2026-11-05 20:57 | 382 | 1,418,454 | continued |
| 2026-11-08 13:22 | 761 | 1,397,478 | continued |
| 2026-11-09 13:55 | 1,243 | 2,002,944 | continued |
| 2026-11-09 14:01 | 545 | 1,798,224 | continued |
| 2026-11-09 13:59 | 1,432 | 3,402,362 | none, no error event |
| 2026-11-09 14:00 | 1,434 | 3,403,476 | none, no error event |

Proven:

- Both failed attempts passed subscription verification. Every import up to
  2.0 MB continued. Only the two 3.4 MB imports stopped, and nothing was logged.
- `SdkRuntime.stop()` wrote no record. Every SDK error result became
  `502 sdk_execution_error` with the CLI's text, and the SDK's typed
  `terminal_reason` and `api_error_status` fields were discarded.
- A cold import sends the whole Droid history as one user message. Imported tool
  calls carried only the tool name, while results carried the ID, so a large
  history could not pair calls with results. Unanswered calls were not marked.
- The pinned CLI (SDK 0.3.300) reports an over-window input as an assistant API
  error starting `Prompt is too long`, with result `terminal_reason: prompt_too_long`.
  The installed Droid classifies `/prompt is too long/i` as a non-retryable
  context-length error.

Inferred, not proven: the 3.4 MB imports (roughly 850K tokens at 4 bytes per
token) exceeded the model window. Native Claude Code compacts its own transcript,
so Droid's history can grow far beyond what a fresh session can accept.

Unresolved: the provider's actual error for session `e92b48c1` was not retained.
The bridge has no model context-window metadata, so it cannot predict the limit.

Reproduced deterministically with injected SDKs: a 1,500-message history and an
SDK `prompt_too_long` result previously produced an opaque 502 and no log record.

## BR-02 Actionable failure reporting

Each stopped native generation logs `sdk_session_failed` (warn) or
`sdk_session_stopped` (cancellation and host exit, info). The record has:
code, status, lifecycle phase (`startup`, `prompted`, `continuation`,
`responding`, `waiting_host`, `idle`), allowlisted SDK `terminalReason`,
`apiErrorStatus`, `resultSubtype` and `assistantError`, account, native
generation, query age, user-turn count and cold-import counts. It never includes
the error message, prompts, CLI output or identities. Tests assert that a prompt
marker, a fake key in CLI errors and a mismatched account email do not appear.
Error results without a known reason keep `502 sdk_execution_error`; a known
reason is added as `sdk_terminal_reason`.

## BR-03 Safe large-history handling

- `prompt_too_long`, or the CLI's fixed text from producers without
  `terminal_reason`, returns `400 invalid_request_error` with
  `recovery_action: compact_conversation`, `retry_from_history: false` and
  import counts. It is never replayed on another account. The session ends
  explicitly instead of failing as an opaque 502.
- Imported tool calls now carry their IDs. Calls without a result are marked
  "outcome unknown, check the current state instead of repeating it", and failed
  results are marked `(error)`.
- No history is truncated. Short first turns are unchanged.
- Decision (decided by default, owner to confirm): no guessed pre-flight token
  limit. A byte or token threshold without model-window metadata would reject
  imports that work (2.0 MB succeeded). Options were a configured ceiling, an
  estimated ceiling, or classifying the provider's own rejection. The last is
  exact and reversible.

## BR-04 Capacity and queue observability

- `report_jobs(..., max_running=N)` adds `capacity`, derived from the shared lease
  ledger with the scheduler's own lane and occupancy predicates. It reports lanes
  (limit, occupied, free, waiting, waiting blocked by account), each account's
  controller and worker lane (`free`, `busy`, `excluded_until_cleanup_verified`),
  the oldest queue wait and recent admission delays. The worker limit is shown
  only when supplied, so the Python default of 2 is never mistaken for the live
  value of 8. `native_runtime report` accepts `--max-running`.
- Controller `/status` `desktopJobs.queue` and `desktopJobs.accounts` show that
  process's queued and running phases and recent admission delay.
- Both views state that they are admission capacity, not service health, login,
  successful inference or remaining provider allowance. No new state store.
- Live read-only snapshot, 2026-11-09 14:36:50 UTC, 505 ledger records, limit 8
  supplied: worker lane 1 of 8 occupied (team4), controller lane free, no queue,
  no excluded account; last 50 admissions median 0.093 s, maximum 14.233 s.
  Admission capacity was not the constraint at that time.

## BR-05 Eight-account routing and recovery

Existing tests already cover idle-first selection across eight accounts, sticky
operation routing, response-loss lookup without replay, settlement-gated capacity,
uncertain-account exclusion, cooling, and failover only after verified retirement.
Added: the helper at `--max-running 8` admits all eight accounts plus a controller
on a shared account, skips an older queued job blocked by its own busy account in
favour of a younger job on a free account, then admits the older job when its
account settles. No defect was found, so routing code is unchanged. Weights, the
global ceiling, workspace locks and sticky assignments are untouched.

## BR-06 Verification and candidate

Iteration on the working tree: typecheck, build, build:workers, vitest
(128 files, 1,632 passed, 3 skipped) and the native suite (118 tests) passed
before the review fix. After the review fix, the affected suites passed (267 tests).
The final local-CI run, package path and verification are recorded in the
candidate evidence file beside the packaged release, because recording them here
would change the reviewed commit.

Review: performed against the full diff by the implementing agent. No separate
review agent could be started in this session, so this is not an independent review.
It found that a completed import's counts could be attributed to a later stop;
fixed with a regression test.

## BR-07 Live acceptance and activation preparation

Not executed: active-service replacement and the eight-account live inference
scenario need the operator's activation decision. The prepared scenario and
activation plan are in the candidate evidence file.

## Review repair (coordinator review 1)

The first candidate (`96b54b5`, package `native-factory-20261109-96b54b5`) is
superseded. Its package and checks do not qualify the repaired tree. Each finding
was reproduced on `96b54b5` before the fix:

- P1: a logger that throws on `sdk_session_failed` left the failed turn unsettled
  after 1 s and raised an unhandled rejection. Terminal diagnostics are now best
  effort. The regression proves the original `prompt_too_long` error is delivered,
  the input queue is closed, the native query is closed and no session or slot
  remains, for both a throwing `warn` (failure) and a throwing `info` (cancellation).
- P2: a call ID containing a newline, echoed by Droid with an underscore, was
  labelled unanswered. Rendering and counts now use `canonicalToolUseId()`.
- P3: with 1,000 completed records and an uncertain team2 lease stored after
  them, capacity reported team2 free and 8 of 8 worker slots free. Capacity now
  counts every retained record and reports `complete: false` with null lanes,
  accounts and queue when any record is unreadable.

## BR-08 Durable native checkpoint recovery

Root cause: native lease generations belong to the controller process that
acquired them. After an orderly close, the lease is terminal (`cancelled`). Only
the marker-restore path (`restoreIdleDesktopBinding`, triggered by
`UserPromptSubmit`) advanced `nativeGeneration`. A fresh authenticated
`SessionStart` for the existing orchestrator created a new host binding but kept
`g0`. The helper refused that generation with `lease_binding_mismatch` (owner
changed and lease terminal), which the bridge reported as the generic
`desktop_job_protocol`. The app then marked the record FAILED and tried to
update the foreign lease during cleanup (`runtime_cancel_failed`). Session
correlation skips FAILED records, so the next request cold-imported the full
history into a new SDK session, which then failed with `prompt_too_long`.

Evidence (sanitised, read-only): the original record is FAILED at generation 0
with SDK checkpoint `11a7ce5d…`, no pending or ended tools, no cancel request or
host-end marker, and 1,857 completed message fingerprints. Its `g0` lease is
`cancelled` by `bridge_confirmed_session_end`, ended at 23:32:27, before the
record failed at 23:38:39. That lease records the same checkpoint, verified
cleanup, no external cleanup flag and no host reservation. No other generation
exists for that bridge session. The cold-import sibling is FAILED and never
completed a turn.

Repair:

- A fresh authenticated Desktop `SessionStart` advances the generation of each
  resumable (IDLE, not ended) record of that Factory session and workspace that
  this process does not hold, while keeping its SDK checkpoint and account.
- On first use of a generation, the lease helper refuses it in these cases: a
  newer generation exists; a predecessor is active, uncertain or held for a host
  action; a released predecessor still belongs to another controller (any
  controller for one waiting on a host, a live one for an idle one); or the
  latest recorded checkpoint differs from the one being resumed. These refusals
  happen before anything is written and carry a fixed `native_generation` reason.
- The bridge maps these refusals to `409 native_generation_refused`. It keeps the
  record and checkpoint, drops the refused process-local identity, and never
  marks the record FAILED or cold-imports it.
- A supported operator operation recovers a record that already failed this way.
  Its contract is in `OPERATIONS.md`, "Recover a failed native continuation".

Verification: `tests/unit/native-checkpoint-recovery.test.ts` runs the first
controller in a separate Node process with a real lease helper and orderly close,
then the second controller over HTTP. The continuation resumes the same checkpoint
under `g1` without a cold import, and the `g0` lease is unchanged. With the
generation advance disabled, the same test fails at generation 0. Further tests
cover inherited-generation refusal, the operator recovery over HTTP (dry run,
wrong identities, apply, repeat, continuation, repeat after later work), and every
recovery predicate. The Python lease tests cover predecessor states, stale
generations, checkpoint mismatch, the fixed refusal category and read-only
inspection.
