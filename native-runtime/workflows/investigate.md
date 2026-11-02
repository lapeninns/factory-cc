---
id: investigate
purpose: Identify and substantiate a cause without unrequested production changes
---

# Investigate

Read and apply the shared team execution policy before this workflow. The
default deliverable is evidence and a bounded recommendation; perform a fix
only when the user's task authorises it.

1. **Define the question.** Record the observed symptom, expected behaviour,
   relevant time range, environment, revision and impact. Identify which
   evidence would distinguish the plausible explanations.
2. **Inspect safely.** Read applicable guidance and existing logs, code and
   configuration through supported interfaces. Avoid credentials, personal
   content and unrelated data. Confirm that a process, endpoint or database
   belongs to the intended target before drawing a conclusion.
3. **Reproduce or bound.** Use a disposable local fixture or authorised test
   account when possible. Record the exact trigger and observed result. Do not
   convert a failed reproduction into proof that no issue exists.
4. **Test explanations.** Pursue independent hypotheses with clear ownership.
   Prefer checks that can falsify a hypothesis. Correlation, a stored state and
   a single success are not proof of causality or universal health.
5. **Validate findings.** Separate confirmed causes, plausible contributors,
   rejected explanations and unknowns. If QA or a user journey is in scope,
   apply the shared e2e and repository-check rules. Do not make production
   corrections, send messages or spend money without the applicable authority.
6. **Hand off.** Give the supported conclusion first, followed by evidence,
   limits, impact and the smallest useful next action. When a fix is authorised,
   use the implementation workflow and preserve the reproduction as meaningful
   regression coverage.

The workflow is complete when the question is answered to the available
evidence, uncertainty is explicit, and the next decision has concrete support.
An unresolved cause must remain unresolved in the report.
