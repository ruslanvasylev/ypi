# Depth 3 versus depth 4 ablation

This tracked benchmark reproduces the bounded comparison used to decide whether
to promote ypi's default maximum depth from 3 to 4. It does **not** establish a
globally optimal depth or compare depth 2.

The fixture contains 12 contract-grounded defects. `score.py` matches path,
line, and a defect-specific semantic token; unsupported answer items count as
false positives.

Run both conditions concurrently because they are independent and costly:

```bash
mkdir -p tmp/depth-ablation
# Use separate tmux windows or another concurrent runner.
tests/eval/depth-ablation/run-condition.sh 3
tests/eval/depth-ablation/run-condition.sh 4
```

Environment overrides:

- `PI_E2E_PROVIDER`, `PI_E2E_MODEL`, `PI_E2E_THINKING`
- `RLM_EVAL_MAX_CALLS` (default 16)
- `RLM_EVAL_TIMEOUT` (default 900 seconds)
- `YPI_EVAL_OUTPUT_ROOT`

The 2026-07-10 result summary and machine-readable score are retained under
`results/2026-07-10/`. Raw sessions, cost ledgers, and model outputs remain
branch-local under `tmp/`.
