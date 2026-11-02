# Factory Workstream controller with isolated workers

This is the selected integration architecture. Factory's built-in Workstream
agents currently inherit the orchestrator's directory. The controller instead
delegates independent implementation tasks to the `factory-workers` MCP server.
Each supervised worker gets its own native session, Git branch and worktree.
Progress and final results return through the Workstream's tool calls; these
workers are not entries in Factory's built-in Agents list.

## Execution path

1. Start a Workstream in Factory Desktop and describe the outcome normally.
2. The shared controller instructions select `factory_worker_start` for
   independent implementation. The configured repository allowlist is checked.
3. The service creates a worktree from committed source, preserving dirty source
   edits. It starts the official Claude Agent SDK with an unmodified pinned
   Claude binary, Opus 5.5, medium effort and Ultracode.
4. Workers share the two-slot admission limit with the existing native job
   runtime. The controller uses status/wait/list/cancel tools to manage them.
5. Results, reported usage and observed command outcomes return to the Workstream.
   An exit code or successful command is not proof of acceptance or deployment.

The `implement`, `investigate` and `release-prepare` guides and shared team policy
are loaded into the worker preset. Production operations retain their required
user authority. No member-account rotation or subscription fallback is used.

## Configuration and readiness

The shared daemon starts with `node workers-dist/scripts/factory-workers.js
--serve --config /absolute/private/worker-config.json`. Factory's stdio MCP entry
uses the same command without `--serve`; it connects to the shared loopback
daemon. Separate Workstreams do not create competing worker-service owners.
The config must be a private regular file
owned by the operator. It contains paths, provider selection, the repository
allowlist, finite execution limits and an API-key **file path**, never a key
copied into Factory's MCP JSON. `--check` validates configuration without a model
request. `enabled` and `approvalGuardVerified` must remain false until the actual
provider and Desktop permission checks below pass.

The provider is either direct `anthropic` or the explicitly selected
`openrouter` route. API credits, key validity and prompt limits must be verified
for that provider. `maxBudgetUsd` is an SDK estimate checked after requests;
it is not a hard shared billing cap. The existing US$1 validation permission
does not authorise an unlimited production spend policy.

## Pending permissions

The service uses native permission checks and keeps permission requests pending
under unique single-use IDs. It does not expose an MCP approval tool. Pending
actions include their tool, redacted input and an action digest. A separate
local decision command can deliver a matching decision; its use must be guarded
by a verified Factory `ask` command rule before activation.

**This is an activation gate, not a claim of a proved human-authority boundary.**
The installed Factory MCP client does not support elicitation forms, and a
PreToolUse hook's `ask` output is not verified to force confirmation in this
version. The live test must show allow and deny behaviour at the actual autonomy
level and check alternate invocation routes. A private control token or a
configuration boolean alone is not proof. Keep workers disabled if this test
does not establish the required boundary; do not silently auto-approve requests.

The alternative direct-model bridge has an independently tested synthetic
Factory AskUser path for its own native Workflow permission. That path is opt-in
and is not evidence that MCP worker decisions have the same protection.

## Acceptance before activation

- Two worker tasks create different worktrees; the source checkout stays intact.
- Queue admission is shared with native jobs, and a cancelled queued task makes
  no model request.
- The intended provider, model, medium effort and native workflow are observed.
- Workflow permissions cannot bypass the broker merely because the native engine
  classifies a tool as safe. Child failure and pending background work cannot
  become successful parent completion.
- Factory Desktop displays progress/results and the real permission decisions.
- Cancellation closes only owned work and retains capacity when cleanup is
  uncertain. Missing or expired approval never grants permission.
- Usage is deduplicated; source revision, observed checks and unknowns are shown.
- Reopen the Workstream and verify the intended configuration loads without a
  terminal command. Existing unrelated Workstreams are not modified.

The current source is a candidate until this acceptance is recorded. Keep the
working bridge, Team launchers and backups intact. No binary patch, login-token
copying, automatic top-up or silent provider fallback is part of this design.
