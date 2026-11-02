# Team job operations

The team runtime starts native Claude Code through the existing assigned
Team profiles. It adds job-owned Git worktrees, a bounded shared queue, process
supervision, run evidence and reusable instructions. The Factory bridge can also use its shared lease helper for supervised
Workstreams. That helper supports `team1` through `team8`; the bridge owns
subscription authentication, routing and worker configuration. Installing this
package alone does not activate those bridge services or configure logins.

## Local configuration

The standalone runtime resolves `claude` from `PATH`, then falls back to
`~/.local/bin/claude`. Override it with `NATIVE_TEAM_CLAUDE_CLI` set to an
absolute executable path. Its private profile mapping defaults to
`~/.factory/config/native-ultracode-profiles.json`; an absolute
`NATIVE_TEAM_PROFILE_CONFIG` overrides that location. Identity validation and
private-file checks still apply. Do not commit this mapping or account stores.

## Start and inspect a job

Run from a Git repository or supply its absolute path:

```sh
team-job run --profile team1 --repo /absolute/path/to/repository --workflow implement -- "Implement the scoped change"
```

Choose one of `implement`, `investigate` or `release-prepare`. Each guide uses the
same shared team policy. Start with an explicit outcome and acceptance criteria.
The runtime records a job ID and gives that job its own worktree and branch.
Uncommitted changes in the source checkout are preserved and are not copied into
the new workspace. Environment files, OAuth stores and other secrets are not
automatically copied either. Prepare dependencies and authorised configuration
inside the job workspace when the repository requires them.

The existing `claude-team1-ultracode` through `claude-team4-ultracode` commands use
the current directory as the repository for a new supervised job. Each person
must use the command for their own assigned seat. `--check` checks the account
configuration without starting a model request.

```sh
team-job status
team-job show JOB_ID
team-job resume JOB_ID
team-job resume JOB_ID -- "Continue the recorded task"
team-job cancel JOB_ID
```

Resume the recorded job instead of handing an arbitrary session ID to a new
job. The recorded profile, session and workspace stay associated. Cancellation
is handled by the owning supervisor; it targets only verified processes
belonging to that job. A vanished supervisor or stale record is an investigation
state, not proof of completion. Do not delete a lock or kill a PID from age
alone, and do not use a broad `pkill claude` to recover a job.

Pass a new or resumed prompt as one quoted argument. The supervised launcher
forwards only the supported output/input-format and display flags; it rejects
arbitrary model, effort, session, worktree, background and administrative
options. Use `team-job resume` for a recorded session rather than native
`--resume`. These restrictions keep admission and workspace selection with the
supervisor. They do not turn the wrapper into an OS security boundary.

## Capacity and session behaviour

The initial policy allows one active job per profile and two active jobs across
the four standalone profiles. Factory integration can admit all eight configured
profiles through the same shared state root, subject to its explicit concurrency
limit. Other jobs wait for a slot. This is a conservative starting
point, not a measured optimum for the Mac. Change it only after observing memory
pressure, responsiveness, queue wait and workload duration.

These admission limits count top-level supervised jobs. They are not a hard cap
on the agents inside a native workflow, on all other Mac processes, or on other
tools launched outside this runtime. Coordinate expensive builds, browsers and
databases with the existing single Local CI runner. Keep using the real
`~/.local/bin/lci`; this runtime does not replace, copy or bypass that runner.

The startup preset is Opus 5.5, medium effort, Ultracode enabled and the small
workflow-size guideline. Small is advice to the model, not an enforced agent,
token or spending cap. Requested settings and actually observed session data
must be reported separately. A startup flag alone does not prove that later
interactive model or effort changes did not occur.

The launcher pins native permission mode to `manual` at startup. It does not
enable auto mode or bypass permissions. The shared policy instructs the agent
to retain applicable task authority and repository controls; startup flags and
written rules are not continuous proof of every interactive setting.

## Record useful evidence

```sh
team-job check --job JOB_ID --name unit-tests -- /absolute/path/to/test-command
team-job status
team-job show JOB_ID
```

Run checks from the job workspace and record their actual result. A label such
as `unit-tests` is a human-readable name, not proof that the command covers all
acceptance criteria. Prefer the repository's maintained test commands. Do not
put secrets in command-line arguments or check names.

The report should distinguish:

- Job state, process liveness and observation time.
- Source revision, job branch, workspace and assigned profile.
- Requested startup settings and observed model/session information.
- Actual check results and their evidence from a generic successful process exit.
- Reported input, output and cache tokens from remaining subscription allowance.
- Missing or partial telemetry from zero usage.
- Local verification from CI, approval, merge, deployment and live behaviour.

Process tracking covers the launched process group and descendants observed
with their process-start identity. It is not OS-level process containment: a
rapid, unobserved double-fork can escape that observed ancestry. Consequently,
`cleanupVerified` means cleanup of the tracked owned processes, not proof that
arbitrary code could not escape. Unknown, orphaned or cleanup-blocked work
retains its capacity reservation for investigation; do not delete its state or
release the slot merely because an old PID is absent.

Normal operation should retain metadata, not raw prompts, responses or tool
arguments in the runtime's shared reports. Native Claude may maintain its own
private session records under the selected profile; those are separate from
the runtime's sanitised evidence. The runtime cannot calculate an accurate
remaining Team quota percentage from token counts. Use the provider's supported
account usage view for allowance information.

## Shared rules and workflows

`policies/team-policy.md` is the canonical policy for this bundle. The native
launcher includes the policy and selected workflow in its job instructions;
Factory is directed to the same canonical policy. Existing project guidance
still applies. These documents guide model behaviour and do not replace OS
permissions, native permission prompts, sandbox controls or protected releases.

The workflow choices are:

| Workflow | Expected result |
| --- | --- |
| `implement` | A scoped change, relevant checks, reviewed diff and handoff |
| `investigate` | Evidence-supported conclusions, uncertainty and a next action |
| `release-prepare` | An exact candidate and evidence for a release decision |

A release-preparation selection is not approval to deploy. Respect prior user
authority; when a concrete release action has not been authorised, prepare it
fully before requesting the missing approval. Preserve explicit Workstream,
Mission, native-session and checkout instructions.

For every QA, full QA, regression check, user-journey verification or bug-bash
request, load
`~/.codex/skills/qa-with-e2e/SKILL.md`. Use e2e for
applicable browser/mobile journeys with the repository's required checks. The
runtime itself is a CLI and local process/workspace manager, so its deterministic
integration tests have no applicable browser/mobile journey. That does not
waive browser/mobile testing for a product changed by a job.

## Update and recovery

```sh
team-job doctor
team-job doctor --profile team1
team-job update-check
team-job rollback --release RELEASE_ID
```

`doctor` and `update-check` verify the installed release manifest and compare
the native CLI version with the version validated for that release. Supply
`--profile` for the additional configuration and account-login check. Neither
command installs or downloads an update, starts a model request, or proves a
live workflow works. The initial validated CLI version is `2.1.316`; an unknown
version refuses new job admission until that version has been reviewed and
validated for a new release.

Prepare a runtime update from a reviewed source directory. Run its offline
suite, then install it as a new, uniquely named release:

```sh
TEAM_RUNTIME_SOURCE="/absolute/path/to/reviewed/team-runtime"
TEAM_RUNTIME_RELEASE="reviewed-release-id"
PYTHONPATH="$TEAM_RUNTIME_SOURCE" PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s "$TEAM_RUNTIME_SOURCE/tests" -v
PYTHONPATH="$TEAM_RUNTIME_SOURCE" PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m native_runtime.install --source "$TEAM_RUNTIME_SOURCE" --release "$TEAM_RUNTIME_RELEASE"
team-job doctor --profile team1
```

The installer also runs the source tests before installation. Review changes to
the source's validated CLI version and perform a bounded live workflow check
when validating a new CLI version. Use only the member's authorised seat and
the agreed usage scope. Inspect configuration and private state permissions
alongside these checks; a version listing or successful login alone is not
workflow evidence. This runtime does not manage native Claude auto-update
settings or download native CLI releases.

Keep the prior release and a private installation receipt. An update or rollback
must preserve job state, worktrees and user configuration. Do not replace
unrelated profile settings or restore entire configuration files over newer
user changes. Compare the backed-up values and installation receipt first.
Do not restart the existing Factory bridge as part of a native-runtime update.

If an update check fails, retain the known installation, record the exact
failure and inspect the affected job state. If rollback is needed, use a
verified prior release; do not guess an arbitrary target. Restoring runtime
code does not revert product code, database changes or provider actions made
by a job.

## Preservation and access boundaries

Completed workspaces remain available for review and resume. Cleanup is an
explicit operation after the job is terminal and its processes are verified
stopped. There is no automatic or bundled workspace-cleanup command. Arrange
manual disposal only for a verified clean, disposable worktree; preserve its
branch and any dirty or untracked work for review. Never automatically delete
worktrees or branches based only on elapsed time.

Profiles can live under a shared macOS account. A fixed launcher
and private profile mapping prevent accidental account routing; they do not
enforce which human is allowed to run a command under that account. Separate
OS identities or an authenticated per-person entry point are still required
for person-level access isolation. This runtime adds no new OS accounts.

The supervised Factory integration shares the native lease scheduler and its
global and per-seat admission limits. Legacy or unmanaged Factory sessions and
jobs launched outside the supervised commands remain outside that scheduler;
their own limits and usage records do not cover native jobs. Report this
boundary when describing server-wide capacity or health.
