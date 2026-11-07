# Factory owns the harness; the bridge supplies the model connection

## Architecture

Native Factory owns Workstreams, SpawnAgent, agent conversations and messaging, interruption, custom Droid Task delegation, tools, skills, permissions and the right-hand Agents panel. The bridge provides the model connection, subscription authentication and inference admission. It does not create a parallel product worker hierarchy or execute workspace tools.

`subscription-desktop --worker-pool --controller-pool --host-tools --spawn-agents --factory-native` enables this mode with the launcher's existing required paths/profile arguments. The worker-pool options remain a configuration dependency of the older launcher. All `factory_worker_*` tools, including dynamically discovered tools, are excluded in native mode; no task is sent to those executors. `--approval-policy bypass` removes only the bridge-owned extra question. Factory still applies its own permissions and spec mode.

Every advertised Factory tool, including Read/LS/Grep/Glob, returns through the host MCP catalog. Claude Code built-ins are denied through the SDK tool list, PreToolUse hook and permission callback. SpawnAgent, SendMessage, ListAgents, InterruptAgent and Task are real host tool calls with real results. The official SDK system preset is retained with an appended transport policy; binaries and authentication are unmodified. The inference backend remains the official Claude Agent SDK/CLI, not a raw completion API.

## Trusted identity and native inference lanes

A scoped lifecycle hook reads the same bounded, owned `.settings.json` file that establishes the selected custom model. Only its top-level Factory `mission-v2` tag supplies the Workstream ID and `orchestrator`/`agent` kind. No transcript, tool output, prompt role claim or model header supplies this authority. Conflicting reserved tags are unclassified. The hook overwrites incoming role hints before sending enriched metadata through its private authenticated host-event endpoint.

The broker pins this metadata to the exact live host generation and rejects a changed Workstream role. Native inference receives the `factory-native` directory policy: an owned canonical folder, without invented Git provenance or bridge-owned workspace tools. The bridge does not hold a workspace reservation while Factory tools or child tasks run.

Verified orchestrators use the reserved controller lane; native agents use the worker lane. An ordinary authenticated native Droid session without Workstream metadata uses the unreserved worker lane, regardless of its model header. This avoids granting controller capacity from a display name or a copied `X-Bridge-Role` header.

The scheduler retains one controller slot and eight worker slots, derived from the eight configured subscription profiles. Each profile retains at most one active job per lane. Uncertain cleanup continues to reserve the account. This is compute admission, not a provider allowance measurement or a guarantee of eight concurrent native agents.

This separation fixes a demonstrated control failure: when parent and child both used the single controller lane, the parent's InterruptAgent call waited until the child finished and returned "already idle". The real lease regression now keeps a child generating while its parent reacquires inference, and native desktop execution confirms an active interruption.

## Account continuity and first assignments

A native session retains its verified account across stopped model turns and cold-retry cleanup. A queued replacement with no SDK execution does not change that assignment. A cooling assigned account waits for its own recovery; native mode does not automatically borrow another seat after a provider limit.

First assignments project the least occupied eligible lane from the owned shared job ledger, using configured weights only among equally occupied seats. Queued jobs count as load, uncertain accounts remain excluded, unreadable/symlinked ledgers fail closed, and the projection writes no state. The Python scheduler remains the admission authority and verifies ownership and cleanup before inference. Legacy pool behavior remains unchanged outside native mode.

## Model configuration

Use one bridge-backed custom model for the Workstream orchestrator and let agents inherit it. Factory's current agent picker exposes hosted choices and Inherit, while its orchestrator picker also exposes local custom models. Separate local agent-model selection was not available in the tested desktop build. The authenticated settings tag solves role scheduling without requiring a second model entry.

The custom model can retain the existing `X-Bridge-Role: orchestrator` connection header for compatibility. It does not determine native admission roles. Inspect custom Droid pinned models and Light/Medium/Heavy routing too; these may override inheritance. A loopback endpoint is local to the executing machine; the acceptance lane uses Local agents. Remote agents require their own approved reachable model connection.

Use model-scoped hooks. `BRIDGE_FACTORY_BINDING_NATIVE` isolates an experimental native connection from existing pooled/fixed-seat hooks. Missing/foreign/stale lifecycle generations remain rejected. Never remove historical markers or parse nested transcript content to force a reused Workstream onto another connection.

## Availability diagnosis and recovery

The initial test displayed "Workstreams are not available for this organization" before any model request reached the bridge. The native log identified `missions_v2_disabled`. Read-only inspection found an active Pro plan, Local-only delegation and a later feature cache with `missions_v2: true`. A fresh native Workstream then started successfully without changing flags, credentials, billing or binaries. The exact cause of the earlier false availability evaluation remains unproven; no entitlement bypass or permanent vendor fix is claimed.

Reusing an old test Workstream after changing its endpoint produced `stale_host_binding`, a separate lifecycle protection. A fresh Workstream with the intended model selected in its saved settings established the correct host generation. The desktop composer initially displayed a built-in label even while the saved Workstream model was custom; actual bridge ingress and saved settings were used to verify routing rather than relying on that label.

## Executed native acceptance, 2026-11-07

- Workstream `4ecf9980-a17b-454f-a9a4-ee62a3fe798f`: native agent `d3c02091-bfaf-46b2-a99d-d765bd978dba` appeared in the Agents tab, read the exact probe marker, accepted a direct acknowledgement message, was stopped during an active bridge request, and accepted a follow-up read in the same native conversation. Its row returned Idle.
- Native SendMessage and ListAgents were observed as real Factory host calls. The initial controller-lane InterruptAgent test returned already-idle and was not counted as an active-interruption pass.
- Workstream `96ed1b55-75a9-4644-b530-796d53cc45e0`: native agent `1dbe2647-6859-4594-af8e-472046c106ca` exercised the repaired worker lane and real active InterruptAgent. Its continuation exposed an account reassignment/queue issue, which was then repaired. The queued test request was cancelled before inference; no productive worker was cancelled.
- Final native agent `19802ea5-202f-4810-8ac0-bf6d549c6a37` exercised creation, file read, SendMessage, running-state observation, active InterruptAgent, follow-up read and Idle completion. It returned `NATIVE_STABLE_RESUMED FACTORY_BRIDGE_SMOKE_59B826B_20261107` and retained team1 across the stopped and resumed model turns. Both parent and agent reported `claude-opus-5-5` through the bridge.
- An observer captured two simultaneous running inference leases: controller and worker. This demonstrates parent/child steering concurrency, not an eight-agent load test.

Detailed private evidence lives in `evidence/local/reliability-20261107/native-factory-availability/` (ignored). No private capabilities or raw transcripts are included here. The macOS native panel has no applicable browser/mobile e2e target; no e2e runner pass is claimed. Custom Task tool transport is covered by protocol fixtures; a separate live custom-Droid Task journey is not included in this Workstream-panel certification.

## Before migrating NabaLens

Existing SDK workers cannot become native Factory agents by changing a model entry. Preserve their assignments, worktrees, results and callbacks; finish them or make an explicit bounded handoff.

Package one clean verified release containing the matching JS and Python scheduler code. Repoint every shared-runtime participant through a coordinated plan; do not permanently mix old scheduler classification with the new native policy. Update the scoped lifecycle hook to the same release so role metadata is present. Preserve tokens, ports and histories.

Controller activation waits for zero active requests/native turns, pending host calls, pending approvals and held host actions. Read back loaded entrypoints, config markers, runtime health and native role routing independently. Formal CI, immutable packaging, native desktop acceptance, activation and productive NabaLens continuation are separate claims. No NabaLens migration is claimed by the isolated acceptance above.

## Primary references

- https://docs.factory.com/workstreams/overview
- https://docs.factory.com/workstreams/steer
- https://docs.factory.com/workstreams/settings
- https://docs.factory.com/harness/subagents
- https://docs.factory.com/model-independence/byok
