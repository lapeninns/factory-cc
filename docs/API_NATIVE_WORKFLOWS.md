# API-backed native workflows (development candidate)

This document describes the opt-in API-backed Ultracode path being added to
the bridge. It is not an activation record. The existing desktop installation
and its subscription routes are not changed by building or testing this branch.

## Identity and authority

- The default path requires explicit `anthropic-api` authentication and an
  organisation-owned API credential. An explicit `openrouter` provider option
  permits the separately approved OpenRouter API credential and exact Opus route.
  Neither path uses a member's subscription, pooled accounts or automatic
  cross-account fallback.
- Run a dedicated loopback instance with its own private data directory and
  an explicit API budget. Do not reuse the current bridge's session database.
- Factory owns the requested outcome, approval boundaries, repository tools,
  independent verification and release. Native workflows may decompose work;
  their external actions still go through the currently advertised Droid MCP
  tools. Native shell, file-writing, scheduling and unrelated registries remain
  unavailable.
- A native workflow does not grant permission to merge, deploy, apply hosted
  migrations, message people or alter real data. Existing Factory authority
  continues to apply.

## Intended configuration

The implementation introduces local bridge options; they are not built-in
Factory settings. The existing mode defaults to off.

| Option | Meaning |
| --- | --- |
| `BRIDGE_NATIVE_WORKFLOWS=1` | Explicit API-backed workflow mode |
| `BRIDGE_WORKFLOW_PROVIDER=anthropic` | Default provider; explicit `openrouter` enables only the approved route below |
| `BRIDGE_AUTH=anthropic-api` | Default direct API authentication; the OpenRouter path requires `byok` |
| `BRIDGE_WORKFLOW_MAX_BUDGET_USD` | Required finite positive SDK estimated-spend stopping threshold per query |
| `BRIDGE_WORKFLOW_MAX_MS` | Absolute deadline from workflow launch, including tool round trips |
| `BRIDGE_MAX_SESSIONS=1` | One root workflow session in the dedicated instance |

The SDK receives `ultracode: true` and `workflowSizeGuideline: "small"` only
for the explicit workflow path. The latter is advice, not a hard child-agent
count. The model's effort comes from Factory; use Opus 5.5 / medium for this
candidate. Workflow launch still requires a live approval channel.

The native engine is pinned to SDK `0.3.300`, bundled Claude Code `2.1.300`,
and the SHA-256 of the inspected macOS arm64 binary. The bridge uses that
verified binary explicitly. Custom executables and other platforms fail
closed in this experimental mode. This build rejects remote isolation from
inside Workflow's `agent()` dispatcher, including computed options. Ordinary
native Agent, RemoteTrigger and scheduling tools remain denied. Updating the
pin requires renewed native compatibility and remote-denial validation.

`maxBudgetUsd` is **not a hard billing cap**. The SDK checks estimated spend
after requests; a request can cross the threshold, helper calls may be outside
that accounting, and a new query has a new allowance. The setting does not
guarantee a shared total across sessions or restarts. Do not run a US$1-capped
live test solely on the strength of `BRIDGE_WORKFLOW_MAX_BUDGET_USD=1`.

## Runtime requirements

1. Reject conflicting authentication, account profiles, pool routes and
   unapproved endpoints before starting a model request.
2. Keep the root SDK session ID distinct from every child session ID.
3. Associate each host tool invocation with its exact native tool-use ID.
   Parallel identical child calls must not receive each other's results.
4. Serialize externally visible host-tool handoffs when identity cannot be
   carried safely by the native callback. Never guess a missing identity.
5. Do not report workflow completion while tracked children or host actions
   remain pending. Child failure/cancellation must not become parent success.
6. Cancelling a root cancels queued handoffs, late callbacks and owned native
   processes. Process cleanup failure remains visible and occupies capacity.
7. The absolute deadline spans all HTTP/tool round trips rather than resetting
   whenever Factory supplies a tool result.
8. Preserve the existing behaviour when workflow mode is disabled.

## Verification and activation

Offline unit/protocol tests establish the bridge's own decisions and lifecycle
behaviour. The additional `scripts/probe-native-workflows.ts` exercises the
unmodified native engine against a loopback API fixture with a dummy credential
and isolated home/config directories. It has passed two parallel children with
identical tool arguments, correct result attribution, actual Opus/medium request
parameters, computed remote-isolation refusal, and owned-process cleanup. It
makes no paid API calls. It does not prove organisation authentication, billing
or a live Factory-to-provider round trip.

Before activation, a disposable API-backed bridge probe must verify:

- Opus 5.5 and medium effort are effective;
- a workflow runs two child tasks;
- both child host-tool calls return to the correct child, including identical
  inputs and out-of-order arrival;
- native Write/Bash and non-advertised tools are denied;
- cancellation rejects a waiting child's later action and cleans up resources;
- no subscription credential or pool account is used;
- usage is attributed without adding cumulative SDK totals twice.

The owner approved a US$1 validation cap. No API credential was present in the
agent environment when this candidate began. Do not fetch a key from unrelated
credential stores or print a key into chat, logs or evidence. Configure the
organisation credential locally and establish a conservative bounded-request
test or a verified provider-enforced cap before performing that probe. No
top-up or automatic reload is authorised.

The isolated launcher accepts a private local credential file; the value is
never a command-line argument. This example validates configuration only:

```sh
BRIDGE_WORKFLOW_MAX_BUDGET_USD=0.25 npm run api-workflows -- \
  --check \
  --project /absolute/path/to/disposable-project \
  --data-dir /absolute/path/to/new-private-api-state \
  --api-key-file /absolute/path/to/private-key-file
```

The key file must be an owned regular file with no group/other permission
bits (for example, mode `600`). Check mode makes no model request and starts
no server; it creates isolated state directories and an ownership marker.
It does not prove that the key works or that billing is available. Launching
without `--check` starts the separate service. Do not switch the live Factory
route until the native child, permission, cancellation and budget checks pass.

## Explicit OpenRouter API option

The separate launcher also accepts `--provider openrouter`. It selects only
`https://openrouter.ai/api`, model `anthropic/claude-opus-5.5`, and the dedicated
`BRIDGE_OPENROUTER_API_KEY` variable. Its Factory-visible model ID remains
`claude-opus-5-5`. Arbitrary BYOK providers, model substitutions and endpoint
variations are rejected in native workflow mode. The direct Anthropic provider
remains the default.

```sh
BRIDGE_WORKFLOW_MAX_BUDGET_USD=0.25 npm run api-workflows -- \
  --check --provider openrouter \
  --project /absolute/path/to/disposable-project \
  --data-dir /absolute/path/to/new-private-openrouter-state \
  --api-key-file /absolute/path/to/private-openrouter-key-file
```

The file value is assigned only to `BRIDGE_OPENROUTER_API_KEY`; it is not placed
in `ANTHROPIC_API_KEY`. The existing BYOK environment builder passes the selected
credential as bearer authentication to the selected endpoint, pins all model
slots, and excludes subscription credentials. Conflicting direct API/OAuth
credentials and model-routing environment variables are rejected. The native
runtime still uses its private Claude configuration directory, the verified
binary, medium effort, one root session, the declared budget/deadline, and host
tool approval boundaries.

State markers include the provider. Reusing an Anthropic state directory for
OpenRouter, or vice versa, is refused; create a separate directory. Check mode
restores the prior credential environment, including on validation failure, and
never validates the key against a provider or makes a paid request.

OpenRouter billing may use a linked upstream provider account. An OpenRouter
credit balance alone therefore does not establish whether a request can run
or where its cost will be charged. Any live validation must account for both
OpenRouter and upstream provider usage within the owner's existing approval.

## Backups and rollback

The private pre-change backup contains the Factory settings/rules, bridge
launcher and installation metadata, bridge-local secret files, a source Git
bundle and the installed built runtime archive. Its location is recorded in
the user-facing backup receipt; credential contents are not included there.

The source changes live in a separate worktree. Until explicitly activated,
rollback means leaving the current installation alone and stopping only owned
test instances. After a future activation, stop new admissions, finish or
cancel owned work with evidence, restore the exact backed-up runtime/config,
and verify health and normal non-workflow behaviour. Do not overwrite newer
settings or restore a session database over active work.

## References

- <https://code.claude.com/docs/en/model-config>
- <https://code.claude.com/docs/en/workflows>
- <https://code.claude.com/docs/en/legal-and-compliance>
- <https://docs.factory.com/model-independence/byok>
