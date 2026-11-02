# Factory Workstream controllers and supervised workers

Factory remains the controller. Independent tasks run through the
`factory_worker_start` MCP tool in separate Git worktrees, and progress, pending
permissions and results return to the originating Workstream. These workers do
not appear in Factory's built-in Agents list. Ordinary folders can be used for
controller operations when the explicit host-tools policy is enabled.

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

## Execution and recovery

1. A Factory lifecycle hook binds the Workstream to its real workspace and
   controller connection. An exact worker MCP namespace prevents crossing into
   another connection.
2. The controller delegates an independent task. A fixed connection uses its
   own seat; a pool selects a healthy configured worker backend. An uncertain
   start is retained for reconciliation instead of automatically replayed.
3. The worker creates a new Git branch and linked worktree from committed
   source, leaving dirty changes in the original checkout in place. It runs the
   official Claude Agent SDK with Opus 5.5, medium effort and Ultracode.
4. The Python lease helper shares admission with standalone native jobs:
   at most two active jobs in total and one active job per subscription seat.
   Paused model phases release capacity as appropriate; an outstanding host
   operation or uncertain cleanup retains its lease.
5. The pooled connection scopes status, wait, list and cancel calls to the
   owning Workstream. Fixed-seat connections share their seat service's worker
   ledger. A worker remains pinned to its selected backend. New work can use
   other healthy seats; a partially executed worker is not migrated.

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
Factory Execute, Create and Edit actions then require an exact native AskUser
decision before dispatch. Native direct writes, native Bash, built-in agent
spawning and unrelated MCP tools remain blocked in this controller path.

Workers default to an explicit repository allowlist. Subscription workers can
instead opt into `"repositoryPolicy": "owned-git"`: each request must identify
a canonical, owned, non-bare Git repository with a commit. This supports new
repositories without editing an allowlist. A plain directory is not a worker
repository. Native scheduling rejects conflicting parent/child host workspaces
and worker worktrees while retaining conservative cleanup accounting.

## Source package and build

The accompanying [native runtime](../native-runtime/README.md) is included in
this repository. It supplies the lease helper, standalone native launchers,
shared workflow instructions, recovery commands and deterministic Python tests.
The standalone native launchers cover `team1`–`team4`; Factory lease accounting
supports all eight seats.

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
created from that directory. Keep source and installed releases separate. The
native release installer takes `native-runtime` as its source root, not the
top-level bridge directory.

## Private configuration and startup

Provision the official CLI login for each intended seat separately. The default
mapping is `~/.factory/config/native-ultracode-profiles.json`, a private regular
file owned by the operator. Its `profiles` object maps `team1`–`team8` to `email`
and absolute `configDir` fields. Do not commit the mapping, OAuth state or private
runtime configuration. The current compatibility pins are Claude Code 2.1.316
and Agent SDK 0.3.300; other versions fail preflight until separately validated.

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
