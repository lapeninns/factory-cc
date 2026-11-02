---
id: implement
purpose: Deliver a scoped code change with reviewable evidence
---

# Implement

Read and apply the shared team execution policy before this workflow. This is
a reusable procedure, not authority to publish, deploy or spend money.

1. **Establish scope.** Restate the requested behaviour and acceptance criteria.
   Read repository guidance, inspect the assigned workspace and revision, and
   identify existing changes, owned paths, dependencies and integration owner.
   Preserve explicit execution-surface and checkout instructions.
2. **Inspect before editing.** Reproduce the issue or inspect the affected user
   path. Choose the smallest complete change. Record meaningful assumptions;
   do not invent product requirements to fill unrelated gaps.
3. **Implement.** Keep edits in owned paths. Delegate only independent parts
   with a self-contained brief and disjoint ownership. Coordinate shared files
   through the integration owner. Do not duplicate workers after the same
   failure; diagnose the failure.
4. **Verify.** Run relevant repository checks and inspect their output. Exercise
   the changed behaviour, including material failure paths. Apply the shared
   QA/e2e and Local CI rules. Capture executed checks and exit results; keep
   failed, blocked, skipped and passed states distinct.
5. **Review.** Inspect the final diff for scope, correctness, secrets and unwanted
   changes. Use an independent reviewer when the risk or repository requires
   one. Address actionable findings, then rerun only affected checks.
6. **Hand off.** Report changed behaviour, revision, acceptance-to-evidence
   mapping and limitations. Prepare the repository's one bundled PR if within
   the task authority. Keep merge, production changes and deployment as
   separate actions requiring their applicable authority and verification.

The workflow is complete when the requested behaviour and in-scope checks are
proven, the diff is reviewable, and remaining delivery steps are named honestly.
If a required check is blocked, report the implementation as ready for that
check rather than claiming completion of the blocked verification.
