# Deletion Candidates

This is a retention ledger, not a deletion queue. Entries remain shipped and
tested until all evidence gates pass and a maintainer explicitly approves a
later removal change.

| Candidate | Status | Replacement | Required evidence | Fallback | Owner decision |
|---|---|---|---|---|---|
| Preserved incumbent CLI engine in `rlm_query.legacy` | retained fallback during convergence | `extensions/ypi/runtime-core.ts` plus thin `extensions/ypi/cli.ts` and `rlm_query` launcher | contract parity, CLI async/stdin tests, consumer-pack tests, real-model eval | `YPI_LEGACY_IMPL=1` | pending |
| Preserved incumbent native engine in `extensions/ypi/legacy-native-tool.ts` | retained fallback during convergence | `extensions/ypi/runtime-core.ts` plus thin `extensions/ypi/native-tool.ts` Pi adapter | contract parity, native harness, cancellation/output tests, package tests, real-model eval | `YPI_LEGACY_IMPL=1` | pending |

A status may move from `retained during convergence` to `marked for deletion`
only when every required evidence item is linked in this table. Marking does not
remove files, exclude package contents, or stop compatibility tests.
