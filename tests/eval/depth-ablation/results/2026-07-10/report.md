# Depth 3 vs 4 ablation

## Contract

- Source commit: `036f5d3` on `feat-unify-recursion-runtime`.
- Same planted TypeScript audit fixture and goal/acceptance prompt.
- Same `openai-codex/gpt-5.6-sol` route and `max` thinking.
- Same `RLM_MAX_CALLS=16`, `RLM_TIMEOUT=900`, explicit read-only no-jj mode, and isolated counters/sessions.
- Only `RLM_MAX_DEPTH` changed.
- Ground truth: 12 contract violations across six files.

## Result

| Metric | Depth 3 | Depth 4 |
|---|---:|---:|
| Exit | 0 | 124 timeout |
| Final answer | yes | none |
| True positives | 12 | 0 |
| False positives | 0 | 0 |
| Calls/attempts | 10 | 10 |
| Maximum observed child depth | 3 | 4 |
| Elapsed | 732.267 s | 900.071 s |
| Cost | $3.269840 | $4.387705 |
| Tokens | 1,529,367 | 2,780,716 |
| Max RSS | 273,284 KiB | 328,284 KiB |

Depth 3 found every planted defect with no unsupported finding. Depth 4 used
1.342× cost, 1.818× tokens, and 1.201× RSS, then exhausted the tree-wide timeout
without producing a final answer.

## Decision

Keep `RLM_MAX_DEPTH=3` rather than promoting the tested depth-4 default. Preserve depth 4+ as an explicit per-run
override coupled to call and time/budget controls. This paired benchmark rejects
a global depth-4 promotion; it does not claim deeper recursion can never help on
a different task. Depth 2 was not evaluated, so this result does not claim that
3 is globally optimal.

Tracked evidence: `score.json`, the fixture, ground truth, scorer, and runner in
this directory tree. Raw `depth-*/meta.json`, model output, traces, and sessions
remain in the branch-local evaluation workdir recorded by the original run.
