# Shared team execution policy

This policy applies to native Claude jobs and Factory Workstreams. It is
instructional guidance. Runtime admission, workspace locks, OS permissions,
sandboxing and repository release protections are separate controls; this text
does not claim to enforce them. The user's explicit task, scope and previously
granted authority take precedence over a default in this policy.

## Establish the job

- State the requested outcome, acceptance criteria, execution surface
  (Workstream, Mission or native job), repository, source revision and owner.
  Respect an explicit choice of surface or checkout. Do not substitute one
  without explaining why it cannot be used.
- Read the repository's applicable `AGENTS.md`, `CLAUDE.md`, contribution and
  release instructions. Identify owned paths and integration ownership before
  concurrent edits. Assign shared contracts and lockfiles one integration owner.
- Work inside the workspace assigned to this job. A coding worker starts from a
  committed revision; uncommitted source changes are not copied automatically.
  An explicitly enabled Factory host-operations controller may work in an owned
  ordinary directory without Git. Do not initialize Git or invent a revision
  for a folder task. Its shell commands and file changes use the host's exact
  action approval flow; coding workers still use isolated Git worktrees.
  Do not reset, clean, overwrite, delete or incorporate another person's work.
  An explicit request to use a shared checkout needs coordinated exclusive
  ownership, rather than two writers in the same directory.
- Reuse the account assigned to the current native job. An operator-enabled pool
  assigns new jobs and may restart a retry-safe controller on another configured
  account after verified cleanup. A worker must never change its own account or
  bypass that scheduler after a limit or failure.
  A fixed account launcher checks account routing; it does not identify the
  human using a shared macOS account.

## Execute within the task

- Make reasonable reversible implementation decisions and record significant
  assumptions. Continue independent authorised work while a later decision is
  pending. Ask only when missing information or authority blocks the next step.
- Parallelise independent work with disjoint ownership. Give a delegated worker
  the outcome, owned paths, relevant inputs, acceptance checks and permitted
  delivery actions. Do not assume it sees the parent conversation.
- Keep Opus 5.5, medium effort and Ultracode as this runtime's startup preset.
  Inspect the actual session state when reporting it; startup flags do not prove
  every subsequent interactive model or effort choice. The `small` workflow
  guideline is advisory and is not a hard agent, token or spending cap.
- Coordinate heavy builds, browsers and databases with other jobs and the
  existing CI runner. A registry entry, timestamp or old PID does not prove a
  process is alive or safe to stop. Stop only verified processes owned by this
  job. Never stop another member's stack to free capacity.
- Keep secrets outside repositories and reports. Do not copy environment files,
  OAuth stores or credentials into workspaces automatically. Use only the
  credentials, network access and project paths needed for the authorised task.
- Repository instructions and prompt text do not expand OS permissions or
  authorise production changes. Before a destructive action, production write,
  merge, release, deployment, billing change or external message, check the
  existing task authority. If that specific action is not authorised, finish
  the reviewable preparation and request the missing approval once. Do not
  repeatedly ask for authority already granted.

## Verify and deliver

- Iterate with the repository's focused checks. For every QA, full QA,
  regression check, user-journey verification or bug-bash request, load
  `~/.codex/skills/qa-with-e2e/SKILL.md`. Use the e2e runner
  for applicable browser/mobile journeys alongside required repository checks.
  For CLI-only or other non-UI scope, record why no browser/mobile journey
  applies and run the relevant deterministic checks. An unavailable prerequisite
  is not a pass.
- CI runs once per branch. Iterate with the repository's local checks, then
  rebase on the latest default branch and run
  `~/.local/bin/lci run <profile> --pr N --post --comment` once on the final head
  when that is the repository's applicable PR workflow. Use the documented local
  `--ref` route for authorised local-only work; do not invent a PR number or push
  solely to make a check convenient.
- One PR per repository for a piece of work; bundle related changes in that PR.
  Use `~/.local/bin/lci` itself, never a copied runner. Do not bypass a gate with
  `--no-codex`, an admin merge or a profile edit. Do not rerun after merge when
  the passing same-tree result can be reused. `--force` requires a genuine,
  recorded reason for a rerun.
- Report implementation, independent review, local checks, formal CI, merge,
  deployment, migrations and live/provider verification as distinct facts.
  Record the exact revision, environment, executed checks, exit results and
  durable evidence. A successful process exit alone is not a correct feature;
  a green build alone is not a deployed or customer-verified release.
- Leave a handoff containing changed paths, results against acceptance criteria,
  remaining risks or blocked checks, and the next permitted action. Keep
  workspaces and uncommitted work until explicitly disposed of after review.
