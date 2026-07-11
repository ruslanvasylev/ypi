# Canonical-versus-retained parity report

This report records the 2026-07-10 convergence-branch run before the final
adversarial-hardening commits. The tracked `run-lane.sh` now makes the same four
lanes repeatable against any exact checkout; this historical result is not a
substitute for rerunning after behavior changes.

## Evidence validity

The first four attempted lanes are rejected as parity evidence:

- CLI lanes inherited a pre-used call counter and failed admission.
- Native E9 lanes combined a configured budget with E9-local plain mode and
  correctly failed closed.

The isolated reruns below use unique counters/cost ledgers. The clean CLI pair
also unsets ambient `RLM_CALL_COUNT` and proves an actual depth-2 child.

## Real-model outcomes

| Surface | Canonical | Retained | Verdict |
|---|---:|---:|---|
| Native E9 answer | PASS (`CHILD_OK`) | PASS (`CHILD_OK`) | parity |
| Native cost/tokens | $0.173095 / 34,584 | $0.173095 / 34,584 | exact parity |
| Native wall time | 20.149 s | 16.157 s | retained faster in one stochastic sample |
| Clean CLI long-context answer | exact expected | exact expected | parity |
| Clean CLI recursive depth/calls | depth 2 / 2 | depth 2 / 2 | parity |
| Clean CLI cost | $0.828014 | $0.891560 | canonical 7.1% lower |
| Clean CLI tokens | 539,469 | 645,789 | canonical 16.5% lower |
| Clean CLI wall time | 112.355 s | 105.411 s | retained 6.6% faster |
| Clean CLI max RSS | 229,336 KiB | 235,928 KiB | canonical 2.8% lower in end-to-end run |

Both CLI implementations also returned the exact answer in the earlier
correctness-only sample, but its stale starting call count makes its performance
numbers supplemental rather than decisive.

## Deterministic adapter-only cost

With an immediate mock Pi child (25 latency runs, 5 RSS runs):

- canonical median 42.35 ms versus retained 33.55 ms: +8.80 ms;
- canonical median max RSS 53,280 KiB versus retained 4,204 KiB.

This is the cost of a Node adapter process. Against real recursive Pi work it did
not prevent outcome parity and the clean recursive run used fewer model tokens,
but high-concurrency shell fan-out remains a reason to retain the fallback for
at least the documented release window.

## Large-output resilience

A canonical CLI child emitted 64 MiB of stdout. The call exited 0 in 0.07 s,
reported both stream and answer bounds, and held max RSS to 64,316 KiB because
raw stdout is drained/count-only rather than retained.

## Decision

At the evaluated branch state, the canonical engine met behavioral parity on native and CLI surfaces and had
materially stronger bounds, cancellation, admission, context-snapshot, and
package guarantees. Both incumbent paths may be **marked for deletion**, but
remain shipped, selectable through `YPI_LEGACY_IMPL=1`, and tested for at least
one release window. Removal still requires a separate maintainer decision. The
CLI ledger must preserve the adapter-only RSS/startup tradeoff as residual risk.
