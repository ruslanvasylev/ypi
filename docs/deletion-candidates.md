# Deletion Candidates

This is a retention ledger, not a deletion queue. Entries remain shipped and
tested until all evidence gates pass and a maintainer explicitly approves a
later removal change.

| Candidate | Status | Replacement | Required evidence | Fallback | Owner decision |
|---|---|---|---|---|---|
| Duplicated runtime policy inside `rlm_query` | retained during convergence | canonical shared runtime engine plus thin CLI adapter | contract parity, CLI async/stdin tests, consumer-pack tests, real-model eval | incumbent CLI implementation | pending |
| Duplicated runtime policy inside `extensions/ypi/native-tool.ts` | retained during convergence | canonical shared runtime engine plus thin Pi adapter | contract parity, native harness, cancellation/output tests, real-model eval | incumbent native implementation | pending |

A status may move from `retained during convergence` to `marked for deletion`
only when every required evidence item is linked in this table. Marking does not
remove files, exclude package contents, or stop compatibility tests.
