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
printf 'RLM_CHILD_MODEL=%s\n' "${RLM_CHILD_MODEL-unset}" > "$YPI_EVAL_PROBE"
printf '[]\n'
MOCK
chmod +x "$TEST_TMP/fake-rlm"
DEPTH_ROOT="$TEST_TMP/depth"
mkdir -p "$DEPTH_ROOT/depth-3/sessions"
printf '{}\n' > "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl"
set +e
RLM_CHILD_MODEL=ambient-model YPI_EVAL_PROBE="$TEST_TMP/depth-env.txt" \
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-rlm" YPI_EVAL_OUTPUT_ROOT="$DEPTH_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/depth-ablation/run-condition.sh" 3 >"$TEST_TMP/depth.out" 2>"$TEST_TMP/depth.err"
DEPTH_RC=$?
set -e
if [ "$DEPTH_RC" -ne 0 ]; then pass "depth eval rejects a successful but incorrectly scored answer"; else fail "depth eval rejects a successful but incorrectly scored answer" "rc=0"; fi
if [ ! -e "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl" ]; then pass "depth eval clears stale session evidence"; else fail "depth eval clears stale session evidence" "stale session survived"; fi
if grep -q 'RLM_CHILD_MODEL=unset' "$TEST_TMP/depth-env.txt"; then pass "depth eval clears ambient child routing"; else fail "depth eval clears ambient child routing" "$(cat "$TEST_TMP/depth-env.txt")"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["true_positives"] == 0 and len(d["missing"]) == 12' "$DEPTH_ROOT/depth-3/score.json"; then pass "depth eval emits deterministic score evidence"; else fail "depth eval emits deterministic score evidence" "bad score"; fi

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
