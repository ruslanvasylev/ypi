#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ypi_eval_contract.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

cat > "$TEST_TMP/fake-rlm" <<'MOCK'
#!/usr/bin/env bash
{
  printf 'RLM_CHILD_MODEL=%s\n' "${RLM_CHILD_MODEL-unset}"
  printf 'RLM_STDIN=%s\n' "${RLM_STDIN-unset}"
  printf 'YPI_SHELL_HELPER=%s\n' "${YPI_SHELL_HELPER-unset}"
  printf 'YPI_EXTENSION_PROMPT_MODE=%s\n' "${YPI_EXTENSION_PROMPT_MODE-unset}"
  printf 'YPI_CLI_ROOT_OVERRIDE=%s\n' "${YPI_CLI_ROOT_OVERRIDE-unset}"
  printf 'YPI_CLI_EXTENSION_OVERRIDE=%s\n' "${YPI_CLI_EXTENSION_OVERRIDE-unset}"
} > "$YPI_EVAL_PROBE"
printf '[]\n'
MOCK
chmod +x "$TEST_TMP/fake-rlm"
DEPTH_ROOT="$TEST_TMP/depth"
mkdir -p "$DEPTH_ROOT/depth-3/sessions"
printf '{}\n' > "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl"
set +e
RLM_CHILD_MODEL=ambient-model RLM_STDIN=1 YPI_SHELL_HELPER=1 YPI_EXTENSION_PROMPT_MODE=replace \
YPI_CLI_ROOT_OVERRIDE=/stale/root YPI_CLI_EXTENSION_OVERRIDE=/stale/extension \
YPI_EVAL_PROBE="$TEST_TMP/depth-env.txt" YPI_RLM_QUERY_BIN="$TEST_TMP/fake-rlm" YPI_EVAL_OUTPUT_ROOT="$DEPTH_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/depth-ablation/run-condition.sh" 3 >"$TEST_TMP/depth.out" 2>"$TEST_TMP/depth.err"
DEPTH_RC=$?
set -e
if [ "$DEPTH_RC" -ne 0 ]; then pass "depth eval rejects a successful but incorrectly scored answer"; else fail "depth eval rejects a successful but incorrectly scored answer" "rc=0"; fi
if [ ! -e "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl" ]; then pass "depth eval clears stale session evidence"; else fail "depth eval clears stale session evidence" "stale session survived"; fi
if ! grep -v '=unset$' "$TEST_TMP/depth-env.txt" | grep -q .; then pass "depth eval clears ambient routing and launcher overrides"; else fail "depth eval clears ambient routing and launcher overrides" "$(cat "$TEST_TMP/depth-env.txt")"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["true_positives"] == 0 and len(d["missing"]) == 12' "$DEPTH_ROOT/depth-3/score.json"; then pass "depth eval emits deterministic score evidence"; else fail "depth eval emits deterministic score evidence" "bad score"; fi

cat > "$TEST_TMP/fake-incomplete-rlm" <<'MOCK'
#!/usr/bin/env bash
python3 - "$YPI_EVAL_GT" <<'PY'
import json,sys
g=json.load(open(sys.argv[1]))
print(json.dumps([{"path":row["path"],"line":row["line"],"contract":row["needle"],"defect":"fixture","impact":"fixture"} for row in g]))
PY
printf '%s\n' '{"cost":1.25,"tokens":125}' '{"incomplete":true,"reason":"timeout"}' > "$RLM_COST_FILE"
printf '1\n' > "$RLM_CALL_COUNTER_FILE"
MOCK
chmod +x "$TEST_TMP/fake-incomplete-rlm"
set +e
YPI_EVAL_GT="$PROJECT_DIR/tests/eval/depth-ablation/ground-truth.json" \
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-incomplete-rlm" YPI_EVAL_OUTPUT_ROOT="$DEPTH_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/depth-ablation/run-condition.sh" 3 >"$TEST_TMP/incomplete.out" 2>"$TEST_TMP/incomplete.err"
INCOMPLETE_RC=$?
set -e
if [ "$INCOMPLETE_RC" -ne 0 ]; then pass "depth eval rejects incomplete cost evidence"; else fail "depth eval rejects incomplete cost evidence" "rc=0"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["cost_ledger_incomplete"] and d["complete_ledger_cost"] == 1.25 and d["allocated_call_attempts"] == 1' "$DEPTH_ROOT/depth-3/meta.json"; then pass "depth eval labels lower-bound cost and call attempts"; else fail "depth eval labels lower-bound cost and call attempts" "bad metadata"; fi

cat > "$TEST_TMP/fake-make" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'E9: full ypi recursive child call'
MOCK
chmod +x "$TEST_TMP/fake-make"
PARITY_ROOT="$TEST_TMP/parity"
set +e
YPI_MAKE_BIN="$TEST_TMP/fake-make" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-native >"$TEST_TMP/native.out" 2>"$TEST_TMP/native.err"
NATIVE_RC=$?
set -e
if [ "$NATIVE_RC" -ne 0 ]; then pass "native parity lane requires a real recursive transition"; else fail "native parity lane requires a real recursive transition" "label-only fake passed"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["expected_output_present"] and not d["recursive_transition_present"] and not d["contract_pass"]' "$PARITY_ROOT/canonical-native/meta.json"; then pass "native parity metadata separates label from recursion proof"; else fail "native parity metadata separates label from recursion proof" "bad metadata"; fi

cat > "$TEST_TMP/fake-cli" <<'MOCK'
#!/usr/bin/env bash
printf '2\n' > "$RLM_CALL_COUNTER_FILE"
printf '%s' 'RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA'
MOCK
chmod +x "$TEST_TMP/fake-cli"
set +e
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-cli" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-cli >"$TEST_TMP/cli.out" 2>"$TEST_TMP/cli.err"
CLI_RC=$?
set -e
if [ "$CLI_RC" -ne 0 ]; then pass "CLI parity lane requires two recursive calls, not answer text alone"; else fail "CLI parity lane requires two recursive calls, not answer text alone" "answer-only fake passed"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
