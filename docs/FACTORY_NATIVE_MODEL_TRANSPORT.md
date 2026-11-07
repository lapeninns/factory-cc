# Factory owns the harness; the bridge supplies the model connection

## Accepted direction

The requested architecture uses native Factory Workstreams, SpawnAgent, agent messaging, custom Droid Task subagents, skills, tools, permissions and the right-hand Agents panel. The bridge provides the model connection, authentication and inference admission. It does not create a second product worker hierarchy or run workspace tools.

Interpretation recorded: the user's "module" means "model" (decided by default, owner to confirm). This replaces the proposed native-supervisor wrapper architecture. Existing running SDK workers must finish or receive an explicit handoff; changing the model connection cannot convert them into native Factory agents.

## Operator mode

`subscription-desktop --worker-pool --controller-pool --host-tools --spawn-agents --factory-native` enables the new mode with the existing required paths and profile arguments. `--approval-policy bypass` here removes only the bridge's extra confirmation: Factory retains its own mode, autonomy and approval enforcement. Existing modes retain their behavior.

The current launcher still requires the worker-pool configuration as part of its existing account/admission configuration contract. In Factory-native mode all `factory_worker_*` tools are excluded, including dynamically discovered tools. No work is sent to that executor pool. Removing that legacy configuration dependency is separate from the native lifecycle acceptance check.

Every advertised Factory tool, including Read/LS/Grep/Glob, is exposed through the host MCP catalog. Claude Code built-ins are denied through the SDK tool list, PreToolUse hook and permission boundary. SpawnAgent and Task return to Droid as real host tool calls and consume its real results. Agent messaging and lifecycle tools use the same host boundary. The native SDK system preset remains intact, with an appended transport policy; binaries and authentication are unmodified.

The inference backend remains the official Claude Agent SDK/CLI. This is an adapter using a native agent backend, not a claim that the SDK is a raw completion API. All task tool execution must occur in Factory. Account eligibility does not prove remaining allowance, and no provider or billing fallback is enabled.

The bridge does not keep a workspace reservation while a Factory tool or child task runs. Otherwise a synchronous Task can deadlock waiting for a child in the same folder. Real Python lease integration verifies that the child can acquire inference before the parent receives its Task result. Current reserved controller compute capacity remains one model phase at a time; account eligibility is not a promise of eight simultaneous native-agent generations. Fair parallel native inference admission is a remaining capacity design question, separate from native lifecycle visibility.

## Model routing

The pooled controller custom model uses `extraHeaders: {"X-Bridge-Role": "orchestrator"}` as in the existing approved model entry. Omitting this header in the isolated CLI probe caused a pre-inference workspace-policy rejection; correcting the test configuration produced the successful round trip. The header is a configured connection role, not authority to infer Workstream identity from transcript content.

Set the Workstream orchestrator AND agent model to the bridge-backed custom model (or verified inheritance). Check custom Droid pinned models and Light/Medium/Heavy routing too; these can override inheritance. A loopback model endpoint is local to the machine running the agent, so this acceptance lane uses Local agents. Remote machines require their own approved reachable model connection.

The NabaLens Flow Improvement native UI was inspected on 2026-11-07: its orchestrator is the existing bridge-backed custom model; its agent setting displays Inherit of that same custom model. The Workstream has zero native agents because it currently uses SDK pool workers. That observation is configuration evidence, not native SpawnAgent execution proof.

## Acceptance before migration

1. Isolated native Workstream uses the candidate bridge for both orchestrator and agent.
2. One bounded read-only SpawnAgent creates a real right-hand Agents row.
3. Open that row and verify its native session and tool activity; confirm corresponding bridge inference evidence using trusted host identity.
4. SendMessage, completion, follow-up and InterruptAgent operate on the same native agent. Do not count an MCP notification or assistant prose as lifecycle proof.
5. A native custom Droid Task uses the configured bridge model; nested Claude Agent/Task execution remains denied.
6. Reads and mutations return through Factory tools, including tool discovery updates; no bridge worker starts and no internal native workspace tools execute.
7. Factory permissions and spec mode still govern actions. No automatic hosted-model fallback is assumed: verify the model actually selected in every test session.
8. Existing work is preserved; controller activation waits for zero active turns, pending host calls and held host actions.

## Validation boundary

Focused SDK fixtures verify host action/result transport and internal-tool rejection. Native desktop UI execution is a separate required lane. The e2e browser/mobile runner has no applicable native macOS target here; it is not reported as executed. Formal CI and installed release must be recorded separately from local checks.

## Primary references

- https://docs.factory.com/workstreams/steer
- https://docs.factory.com/workstreams/settings
- https://docs.factory.com/harness/subagents
- https://docs.factory.com/model-independence/byok

## Candidate evidence, 2026-11-07

- Local typecheck, build and workers build passed.
- Full TypeScript suite: 1,583 passed; three platform-specific tests skipped.
- Focused host policy, launcher and real Python lease integration suite: 139 passed.
- Native Droid CLI via the isolated candidate endpoint: exit 0, exact probe marker returned, selected account team2, model claude-opus-5-5. Droid's host transcript records its Read tool; the backend transcript records only host-MCP Script calls for that read. This proves the bounded read path, not Workstream agent lifecycle.
- Native Factory desktop: candidate model selected for the isolated orchestrator and agent inheritance. The attempt displayed "Workstreams are not available for this organization" before any request reached the candidate endpoint. Stopped the test attempt. Right-hand native agent creation, steering and completion remain BLOCKED, not passed. The cause of the Factory availability message has not been established.
- Test model settings restored; the temporary custom model removed; existing model entries preserved; hook configuration restored exactly; the isolated endpoint stopped after authenticated idle readback.
- Existing NabaLens Workstream, running workers and production controller were preserved. No live migration or merge is claimed.

Detailed private local evidence is under `evidence/local/reliability-20261107/native-factory/` (ignored). No tokens or raw private transcripts are included in this document.
