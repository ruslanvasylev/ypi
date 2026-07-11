# Deletion Candidates

This is a retention ledger, not a deletion queue. Entries remain shipped and
tested until all evidence gates pass and a maintainer explicitly approves a
later removal change.

| Candidate | Status | Replacement | Required evidence | Fallback | Owner decision |
|---|---|---|---|---|---|
| Preserved incumbent CLI engine in `rlm_query.legacy` | **marked for deletion; retained and tested** | `extensions/ypi/runtime-core.ts` plus thin `extensions/ypi/cli.ts` and `rlm_query` launcher | 45-case shared contract; 149-case guardrails; byte-preserving stdin/stream/async/cancellation tests; 35-case packed consumer; exact long-context real-model answer with genuine depth-2 recursion; final live E1–E9 gate 10/10 | `YPI_LEGACY_IMPL=1` | removal not approved; separate maintainer decision required after ≥1 release |
| Preserved incumbent native engine in `extensions/ypi/legacy-native-tool.ts` | **marked for deletion; retained and tested** | `extensions/ypi/runtime-core.ts` plus thin `extensions/ypi/native-tool.ts` Pi adapter | 45-case shared contract; 61-case native harness; bounded/cancellation/cost tests; 18-case pure-extension pack; canonical and retained E9 both returned `CHILD_OK` with identical measured cost/tokens | `YPI_LEGACY_IMPL=1` | removal not approved; separate maintainer decision required after ≥1 release |

A status may move from `retained during convergence` to `marked for deletion`
only when every required evidence item is linked in this table. Marking does not
remove files, exclude package contents, or stop compatibility tests.

## Evaluation snapshot (2026-07-10)

- Clean CLI pair: both implementations returned exactly
  `RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA`, used two calls, and reached
  child depth 2. Canonical used 539,469 tokens / $0.828014; retained used
  645,789 / $0.891560. Wall time was 112.355 s versus 105.411 s.
- Native E9 pair: both returned `CHILD_OK`; each recorded 34,584 tokens and
  $0.173095.
- Adapter-only residual: with an immediate mock child, canonical Node startup
  measured 42.35 ms / 53,280 KiB median versus retained shell 33.55 ms /
  4,204 KiB. The fallback remains important during the release window for
  high-concurrency or resource-constrained CLI workloads.
- Large-output proof: canonical drained 64 MiB stdout with exit 0 and 64,316 KiB
  max RSS while returning explicit stream/answer-bound warnings.
- Controlled depth audit: depth 3 found 12/12 planted defects with zero false
  positives in 732 s, using 1.529M tokens and $3.269840. Depth 4 timed out at
  900 s without an answer after 2.781M tokens and $4.387705. The evidence
  supports retaining depth 3 as the default while allowing explicit overrides.
- Final live E1–E9 gate: 10/10 checks passed, including task-context grounding,
  depth-3 leaf execution, timeout exit 124, max-call admission, self-similarity,
  and a recursive native child call. Focused E1/E2/E4 sessions used only the
  `read` tool against their projected task context, not persistent memory.

The first four attempted model lanes were rejected as evidence because they
inherited an exhausted call count or combined a budget with plain output. Only
the isolated reruns above support the status transition.
