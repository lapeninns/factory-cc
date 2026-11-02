---
id: release-prepare
purpose: Prepare a specific candidate for an authorised release decision
---

# Release preparation

Read and apply the shared team execution policy before this workflow. Selecting
this workflow authorises preparation only. It does not independently authorise
a merge, production migration, deployment or rollback.

1. **Identify the candidate.** Record the repository, exact commit/tree, target
   environment, proposed release action, owner and existing authority. Inspect
   repository release instructions and current provider state. Preserve all
   unrelated changes and active work.
2. **Establish prerequisites.** List required code review, local checks, CI,
   migration planning, compatibility, backups and rollback prerequisites for
   this candidate. Use the repository's guarded migration workflow; never
   replace it with a raw command merely because that command is shorter.
3. **Verify the final head.** Finish local iteration, rebase as the repository
   requires, then use the real `~/.local/bin/lci` once on the final PR head under
   the shared Local CI policy. Do not bypass a gate, invent a passing result or
   rerun after merge when a valid same-tree result can be reused.
4. **Prepare the decision.** Produce the exact candidate, passing and missing
   evidence, material risks, migration scope, target and recovery plan. Check
   prior authorisation before asking; if the release action lacks authority,
   obtain it for this concrete reviewable candidate.
5. **Execute only when authorised.** Use the repository's supported release
   procedure. Verify exact deployed revision and migration state independently.
   A provider accepting a deployment or reporting ready is one evidence layer,
   not proof that every customer journey succeeds.
6. **Close each layer.** Report prepared, approved, merged, CI-passed, deployed,
   migration-aligned and live-journey-verified separately. Apply the shared
   QA/e2e rule to applicable post-release journeys. On failure, follow the
   authorised recovery plan and preserve evidence; do not improvise destructive
   rollback or stop another job's processes.

Preparation is complete when the exact candidate and its release decision are
reviewable. A release is complete only when the specifically required runtime
and user-journey evidence has also been collected. Keep those outcomes separate.
