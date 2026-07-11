---
name: bounded-recursive-delegation
description: Use when a coding task is large enough to benefit from ypi child agents and the root must choose efficient review versus implementation delegation without duplicate work, hidden VCS changes, dollar stops, or blind child absorption.
---

# Bounded Recursive Delegation

## Goal

Keep the root focused on the user's goal and final acceptance while fresh child
contexts absorb bounded exploration, review, or implementation work.

## Workflow

1. Size the task with deterministic tools before delegating.
2. Delegate work that is expensive to produce but cheaper to verify:
   - large-surface reading and research;
   - independent audits or counterprobes;
   - a bounded implementation unit with explicit files, constraints, and gates.
3. Use native `rlm_query` `mode=review` for one bounded review. Native calls are
   sequential to prevent overlap with root mutations. When parallel evidence is
   justified, launch at most three shell `rlm_query --async` read-only reviews
   with disjoint charters after notification delivery is proven. Do not expose
   sibling reports.
4. Parent adjudication is root work. Deduplicate findings by mechanism and
   reproduce accepted blockers; do not spawn an adjudicator child.
5. Only the root may use `mode=implement`, for at most one implementation head.
   Never run parallel implementers. The implementer keeps checkout-confined
   `edit`/`write` but not process-spawning `bash`; external/symlink escapes and
   repository-metadata writes are blocked, and the parent runs gates. Existing jj repositories and
   clean Git checkouts both use one repository-wide writer lease. If the checkout
   is dirty or another writer owns it, continue implementation in the root
   instead of changing VCS state or asking the user to understand workspace tooling.
6. Never install or initialize Git, jj, or another VCS. Existing repository VCS
   state is a user-owned boundary.
7. Require each child result to state goal verdict, evidence, files read,
   files changed, commands run, blockers, risks, and stop reason. Keep at most
   eight findings and 12 KiB inline; put overflow in a cited artifact.
8. Before accepting writable work, inspect the changed-path report and final
   diff, run deterministic gates, and obtain an independent read-only review for
   high-risk changes.
9. If the child-call cap is reached, stop spawning children and continue the
   task directly. Do not ask the user to choose another cap.
10. Treat cost and elapsed time as visibility only. Never set or recommend a
    dollar budget. Staleness warnings observe; they do not terminate work.

## Publication Boundaries

- Resolve the actual push URL, not the remote name.
- Remotes outside the exact `ruslanvasylev` owner namespace are read-only unless
  the current user request explicitly authorizes that exact remote operation.
- Never infer release, package publication, or tagging authority from delivery,
  landing, or release-readiness work. Do not ask whether to release.

## Acceptance

The root accepts a child only when direct evidence satisfies the delegated
charter and remains aligned with the original user goal. Passing tests without
changed-scope and final-diff review are insufficient for writable work.
