# Factory Workstream controllers and supervised workers

Factory remains the controller. Independent tasks run through the
`factory_worker_start` MCP tool in separate Git worktrees, and progress, pending
permissions and results return to the originating Workstream. These workers do
not appear in Factory's built-in Agents list. Ordinary folders can be used for
controller operations when the explicit host-tools policy is enabled. Subscription workers can use the owned-workspace policy for bounded snapshots of ordinary folders and new repositories.

## Connection choices

| Connection | Account selection | Workspace policy |
| --- | --- | --- |
| Fixed subscription controller | One configured `team1`–`team8` seat | Read-only controller; its own worker namespace |
| Subscription pool controller | Eight preflighted accounts, weighted selection for new sessions | Pool workers; optional approved host operations |
| Legacy desktop bridge | Existing `claude-config` profiles and optional weighted pool | Legacy tool bridge and lifecycle compatibility |
| Explicit API workers | Direct Anthropic or OpenRouter credentials | Separate opt-in provider configuration |

The subscription entrypoints reject API keys, API budgets and shell approval
helpers in subscription worker configuration. There is no automatic fallback
from a subscription to a paid API route. Each selected account is checked through
the official CLI and again through SDK account information before its first
prompt. Private mappings bind profile names to expected account identities and
separate Claude configuration directories.

The pooled controller currently assigns weights of 5 to `team1`–`team4` and 1 to
`team5`–`team8`. Worker-pool weights are specified in its private configuration.
These are scheduling preferences, not measurements of plan allowances. Pooling
does not grant additional account rights; operators must establish permission
and provider eligibility for every configured account.

The supervised worker path is an explicit connection choice. Keep the legacy
connection as the normal Workstream default until an installed release has
completed worker launch, execution, result collection and recovery checks.
Selecting this path does not establish a throughput improvement over legacy.

## Execution and recovery

1. A Factory lifecycle hook binds the Workstream to its real workspace and
   controller connection. An exact worker MCP namespace prevents crossing into
   another connection.
2. The controller delegates an independent task. A fixed connection uses its
   own seat. A pool selects the least occupied healthy backend across all eight
   profiles, then applies configured weights among equally occupied profiles. An uncertain
   start is retained for reconciliation instead of automatically replayed.
   A confirmed rejection before workspace creation returns a failed result
   with a bounded reason code and `retrySafe: true`. A missing response or an
   error after workspace creation remains uncertain. Neither case retries
   automatically. Each assignment supplies a stable `operationId`. Repeating
   that ID with the same payload returns its existing job. Status queries use
   the backend operation record to reconcile lost start responses.
3. The worker creates an isolated input snapshot, including relevant dirty and
   untracked source files. The original checkout retains its working files. It runs the
   official Claude Agent SDK with Opus 5.5, medium effort and Ultracode.
4. The Python lease helper shares admission with standalone native jobs.
   It allows two active worker jobs and reserves one additional controller slot.
   A subscription seat can run one worker and one controller concurrently.
   A published host action releases inference capacity while a separate
   reservation protects its workspace. Unverified native cleanup continues to
   reserve the account and inference capacity.
5. The pooled connection scopes status, wait, list and cancel calls to the
   owning Workstream. Fixed-seat connections share their seat service's worker
   ledger. A worker remains pinned to its selected backend. New work can use
   other healthy seats; a partially executed worker is not migrated.

The Factory stdio adapter supports `--factory-session-scope`. In this mode it
uses Factory's host-added MCP `assemblySessionId` metadata to derive a stable
owner with the private pool capability. Reconnecting the adapter or resuming
the same Workstream retains access to its running and completed workers. A
different Workstream receives separate ownership, even in the same directory.
Changing the working directory does not change the Workstream owner. Model
tool arguments cannot supply this identity, and missing or malformed host
metadata rejects the operation before dispatch.

The installed Factory Workstream implementation retains its session UUID for
resume and automatic or current-session compaction. A fork receives its own
identity. Keep the pool capability during routine updates, because changing
that key changes the derived worker owner. Generic MCP clients without the
Factory-specific flag keep their connection-lifetime scope.

Older random-scope records remain intact. Drain their live workers before
switching an adapter to the new mode. Historical records cannot be reassigned
by repository path, because several Workstreams can share a repository.

Use `factory_worker_accounts` to inspect all eight profiles, their health,
cooldown, active workers and assignment counts. These values describe observed
routing activity. Provider allowance remains a separate account property.

Subscription workers execute in independent per-job processes. A private
authenticated local channel preserves status, approvals, cancellation and
result collection across worker API restarts. A bounded durable launch queue
keeps `maxConcurrent` executor processes per service. The default pending-job
limit is 16. Executor-process death retains an explicit uncertain outcome.

Worker results move through `result_ready` and `cleaning`. A completed worker
has settled its tracked-process cleanup and lease release.

Worker and controller queues are ordered independently, so running workers
cannot consume the controller's reserved capacity. Workspace conflicts still
apply across both queues. An uncertain or unowned execution holds its capacity
and blocks reuse of its account across both queues until cleanup is verified.

A limited pooled controller can change accounts only after the previous native
process has been cleaned up and there is no unsafe pending tool action. The
replacement starts from reference history; it does not resume another account's
native session. Permanent workspace and policy failures return 400/422 instead
of a retryable 503. Existing eligible idle or pre-inference failed sessions can
recover their trusted lifecycle binding; pending, ended and cancelled sessions
are not eligible for that recovery.

## Folder and repository policies

The fixed-seat controller defaults to `controller-readonly`, which requires a
Git checkout and blocks host mutations. The pool can explicitly enable
`--host-tools` with `--controller-pool --worker-pool`. That policy accepts an
existing canonical directory owned by the operator, including a non-Git folder.
Factory Execute, Create and Edit actions follow the configured approval
policy. With `ask`, dispatch requires an exact native AskUser decision. The host-tools policy supports advertised
MCP operations, with conservative workspace reservations. Delegation uses the
managed worker pool; Factory `Task` and `SpawnAgent` are excluded so child work
retains the pool's account routing, workspace ownership and completion tracking.
Factory spec mode and native-tool permission boundaries continue to apply.

Workers default to an explicit repository allowlist. Subscription workers can
instead opt into `"repositoryPolicy": "owned-git"`: each request must identify
a canonical, owned, non-bare Git repository with a commit, or its subdirectory.
The assigned subdirectory bounds worker writes. The subscription-only
`"repositoryPolicy": "owned-workspace"` additionally supports ordinary folders
and unborn repositories through a private Git snapshot. Snapshots are bounded
to 10,000 files and 64 MiB. Folder and unborn snapshots use a private backing
repository and a linked worker worktree so native admission validates the same
workspace contract. Retain the backing repository with its worker worktree. Recorded exclusions cover generated caches and
private credential state. Tracked PEM files containing exactly one validated
public key or certificate are admitted. Private keys, mixed PEM content and
escaping symlinks cause a
pre-execution refusal. Repository instructions and skills remain available in
the snapshot. Native scheduling rejects conflicting parent/child host workspaces
and worker worktrees while retaining conservative cleanup accounting.

## Source package and build

The accompanying [native runtime](../native-runtime/README.md) is included in
this repository. It supplies the lease helper, standalone native launchers,
shared workflow instructions, recovery commands and deterministic Python tests.
The standalone native launchers and Factory lease accounting support `team1`
through `team8`. Each profile still requires its own valid private mapping.

```sh
npm ci
npm run typecheck
npm run build
npm run build:workers
npm test -- --configLoader runner --no-cache
npm run test:native
```

Use an absolute `nativeRuntimePath` (worker config) or `--runtime-path`
(controller) pointing to `<checkout>/native-runtime`, or to an immutable release
created from that directory. Keep source and installed releases separate. The controller and Python lease
helper must come from the same tested release because workspace reservations
and admission deferral use their shared protocol. The
native release installer takes `native-runtime` as its source root, not the
top-level bridge directory.

## Private configuration and startup

Provision the official CLI login for each intended seat separately. The default
mapping is `~/.factory/config/native-ultracode-profiles.json`, a private regular
file owned by the operator. Its `profiles` object maps `team1`–`team8` to `email`
and absolute `configDir` fields. Do not commit the mapping, OAuth state or private
runtime configuration. Authentication uses the version-specific official CLI
at `~/.local/share/claude/versions/2.1.316`. Updating the ordinary
`~/.local/bin/claude` launcher does not change that selection. The pinned
installation must remain available. The native workflow executable is verified
separately against the Agent SDK 0.3.300 bundled CLI 2.1.300 and its recorded
digest. Other versions require separate validation.

Each fixed worker service has a private config with `provider: "subscription"`,
its exact `subscriptionProfile`, `stateRoot`, `workspaceRoot`, `nativeRuntimePath`,
`sharedStateRoot`, `clientTokenFile`, `port`, finite `maxMs`/`maxTurns`, and
`allowedRepositories`. `repositoryPolicy` defaults to `allowlist`; select
`owned-git` explicitly if appropriate. Start with `enabled: false` and
`approvalGuardVerified: false` until authentication and actual Desktop
permission handling have been validated.

```sh
node workers-dist/scripts/subscription-workers.js --check --config /absolute/private/team1.json
node workers-dist/scripts/subscription-workers.js --serve --config /absolute/private/team1.json
```

Factory's stdio MCP entry uses the same command without `--serve`. It connects to
the existing loopback service rather than creating another worker owner. A
pooled MCP service uses `subscription-pool.js` with a separate private config:
`version: 1`, `enabled`, `stateRoot`, `port`, `clientTokenFile`, and eight `seats`
entries containing distinct `profile`, `weight` and fixed-worker `configFile`.
Its Factory stdio entry adds `--factory-session-scope` after the config path.
The HTTP dispatcher uses `--serve` without that adapter-only flag.

The subscription controller entrypoint is
`workers-dist/scripts/subscription-desktop.js`. Required options are `--profile`,
`--project`, `--data-dir`, `--port`, `--runtime-path`, `--state-root`,
`--worker-control`, and `--worker-mcp-prefix`. A fixed connection uses the exact
namespace `factory-workers-teamN___`; the pool uses `factory-workers-pool___`
and `--worker-pool --controller-pool`. Add `--host-tools` only for the approved
folder-operation policy. `--check` performs preflight without a model request.

These are service entrypoints, not an automatic installer for global Factory
settings, lifecycle hooks, launch agents or account logins. Deployment must wire
the matching private tokens, hook bindings, model connection and MCP namespace
without replacing unrelated settings. The legacy `npm run desktop -- install`
command remains the installer for the separate legacy bridge.

Global lifecycle hooks should use `modelScope` with the exact candidate custom
model IDs and the absolute Factory sessions directory. The hook checks the
persisted selected model in the session's bounded settings file before binding
or emitting context. This permits a candidate connection to coexist with active
legacy connections. A valid existing candidate binding can still deliver its
session-end cleanup after a model change. Fresh Workstreams provide the clearest
cutover boundary.

## Routine decisions and approval policy

Controllers and workers choose the recommended option for routine, reversible
decisions within the user's existing scope and authority. They record a concise
assumption and continue. Without a recommendation, they choose a safe reversible
default. They ask for essential information that cannot be retrieved or reasonably
inferred, or for new permissions. Explicit instructions to ask or wait still apply.
Workers return a blocked handoff with essential questions and their context. The
controller collects the actual user response through Factory AskUser and supplies
it in a new assignment. The worker service has no in-place question-answer channel.

Pooled subscription controllers with `--host-tools --controller-pool --worker-pool`
default to `--approval-policy bypass`. Subscription worker service configurations
default to `"approvalPolicy": "bypass"`. These defaults suppress extra bridge
confirmation for allowed host actions and native worker actions within the current
execution boundaries. Set either policy explicitly to `ask` to retain those
confirmations. Controllers without host tools and API workers use `ask`.

The model policy determines when an essential question is necessary. A question
that reaches Factory AskUser remains pending until its actual response arrives.
A recommendation label never supplies consent or authorizes a new action.
Factory permissions, spec and planning modes, workspace limits, blocked tools,
account identity checks, shared admission and cleanup requirements still apply.

Existing controller state markers reject policy drift, including the new default
when an older marker records `ask`. Retain `--approval-policy ask` for that state,
or perform a deliberate idle-service configuration migration. Controller and
worker `--check` output reports the effective approval policy. Active services
require a controlled restart to load these changes.

## Validation boundaries

Automated checks cover account and namespace isolation, protocol and approval
contracts, workspace policies, capacity sharing, cancellation, uncertain-start
handling, quota recovery and the actual TypeScript-to-Python lease protocol.
They use fixtures and do not spend API credit or subscription allowance.

The development installation was also exercised in Factory Desktop: an existing
Workstream in a non-Git home folder completed an approved read-only command; a
worker read a newly created repository outside the old allowlist; and an older
Git Workstream recovered its binding and completed a read. These observations
apply to that installation and do not establish every account's entitlement or
every future CLI version's behavior. Native macOS Desktop is not a browser/mobile
journey; no browser/mobile e2e runner coverage is claimed for it.

Before enabling another installation, verify actual allow and deny behavior,
worker isolation, results, cancellation and reopening in that Desktop version.
A configuration boolean or passing mock test alone is not proof of the human
approval boundary. Keep worker starts disabled until that check succeeds.
Successful command execution is not acceptance, a merge or a deployment.

Optional API-native workflow configuration is documented separately in
[API_NATIVE_WORKFLOWS.md](API_NATIVE_WORKFLOWS.md).
