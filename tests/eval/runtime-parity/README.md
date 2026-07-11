# Canonical versus retained runtime parity

This manual, paid evaluation exercises all four shipped lanes:

- `canonical-cli`
- `legacy-cli`
- `canonical-native`
- `legacy-native`

Run independent lanes concurrently in separate tmux windows. Each lane owns an
isolated counter, cost ledger, trace, and output directory:

```bash
tests/eval/runtime-parity/run-lane.sh canonical-cli
tests/eval/runtime-parity/run-lane.sh legacy-cli
tests/eval/runtime-parity/run-lane.sh canonical-native
tests/eval/runtime-parity/run-lane.sh legacy-native
```

CLI lanes must return exactly
`RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA` from a generated 3,000-line
context, allocate exactly two attempts, and show observed `depth=0→1` plus
native-tool `depth=1→2` trace transitions; a counter alone is not proof, and an
extra blocked attempt fails the lane. Native lanes run
focused E9 and must report its recursive child-call pass. Compare the four generated
`meta.json` files only when provider, model, thinking, timeout, and checkout are
identical.

The default CLI lane deadline is 600 seconds (native: 180 seconds) because the
long-context two-call lane has exceeded 300 seconds under provider variance.
Environment overrides: `PI_E2E_PROVIDER`, `PI_E2E_MODEL`,
`PI_E2E_THINKING`, `RLM_EVAL_TIMEOUT`, `RLM_EVAL_BUDGET`, and
`YPI_EVAL_OUTPUT_ROOT`.

The historical 2026-07-10 report is retained under `results/`; raw model output
and session evidence remain ignored under `tmp/`.
