#!/usr/bin/env bash
# Prove that ypi's core recursion behavior works as a pure Pi extension.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION="$PROJECT_DIR/extensions/recursive.ts"

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

if ! command -v pi >/dev/null 2>&1; then
	fail "pi installed" "pi is not on PATH"
else
	pass "pi installed ($(pi --version 2>/dev/null || echo unknown))"
fi

PI_E2E_PROVIDER="${PI_E2E_PROVIDER:-}"
PI_E2E_MODEL="${PI_E2E_MODEL:-}"
if [ -z "$PI_E2E_PROVIDER" ]; then
	if [ -n "${OPENROUTER_API_KEY:-}" ]; then
		PI_E2E_PROVIDER="openrouter"
		PI_E2E_MODEL="${PI_E2E_MODEL:-openai/gpt-5.5:xhigh}"
	elif [ -n "${OPENAI_API_KEY:-}" ]; then
		PI_E2E_PROVIDER="openai"
		PI_E2E_MODEL="${PI_E2E_MODEL:-gpt-5.5}"
	elif [ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_OAUTH_TOKEN:-}" ]; then
		PI_E2E_PROVIDER="anthropic"
		PI_E2E_MODEL="${PI_E2E_MODEL:-claude-haiku}"
	else
		echo "SKIP: no supported live-test API key found"
		exit 0
	fi
fi

SCRATCH_ROOT="${YPI_PROOF_TMPDIR:-$HOME/scratch/ypi-pure-extension}"
mkdir -p "$SCRATCH_ROOT"
TEST_TMP=$(mktemp -d "$SCRATCH_ROOT/run.XXXXXX")

MINIMAL_ROOT="$TEST_TMP/minimal-root"
mkdir -p "$MINIMAL_ROOT/extensions"
cp "$PROJECT_DIR/extensions/recursive.ts" "$MINIMAL_ROOT/extensions/recursive.ts"
cp -R "$PROJECT_DIR/extensions/ypi" "$MINIMAL_ROOT/extensions/ypi"
EXTENSION="$MINIMAL_ROOT/extensions/recursive.ts"

TRACE="$TEST_TMP/pure-extension.trace"
COUNTER_FILE="$TEST_TMP/pure-extension.counter"
COST_FILE="$TEST_TMP/pure-extension.cost.jsonl"
STDOUT_FILE="$TEST_TMP/pure-extension.stdout"
STDERR_FILE="$TEST_TMP/pure-extension.stderr"
STATUS_FILE="$TEST_TMP/pure-extension.status"

CHILD_PROMPT='Use the native rlm_query tool directly, not bash, with this exact prompt: Reply with exactly EXTENSION_RECURSION_OK. Then reply with exactly the tool result and no other text.'
PROMPT="Use the native rlm_query tool directly, not bash, with this exact prompt: $CHILD_PROMPT Then reply with exactly the tool result and no other text."

echo ""
echo "=== Pure Extension Proof ==="
echo "provider=$PI_E2E_PROVIDER model=${PI_E2E_MODEL:-default}"
echo "artifacts=$TEST_TMP"
echo ""

if [ ! -e "$MINIMAL_ROOT/rlm_query" ] && [ ! -e "$MINIMAL_ROOT/SYSTEM_PROMPT.md" ]; then
	pass "minimal proof root has no shell helper or external prompt"
else
	fail "minimal proof root has no shell helper or external prompt" "$(find "$MINIMAL_ROOT" -maxdepth 1 -type f -printf '%f ' 2>/dev/null || true)"
fi

set +e
env -u RLM_PROVIDER -u RLM_MODEL -u RLM_CALL_COUNT -u RLM_START_TIME -u RLM_ROOT_PROMPT_FILE \
	YPI_EXTENSION_ROOT="$MINIMAL_ROOT" \
	YPI_EXTENSION_DEBUG=1 \
	RLM_TRACE_ID=pure-extension-e2e \
	RLM_CALL_COUNTER_FILE="$COUNTER_FILE" RLM_COST_FILE="$COST_FILE" \
	RLM_MAX_CALLS=4 RLM_MAX_DEPTH=2 \
	RLM_JJ=0 \
	RLM_JSON=1 \
	PI_TRACE_FILE="$TRACE" \
	timeout 120 pi -p --no-session \
		--provider "$PI_E2E_PROVIDER" \
		${PI_E2E_MODEL:+--model "$PI_E2E_MODEL"} \
		-e "$EXTENSION" \
		"$PROMPT" \
		>"$STDOUT_FILE" 2>"$STDERR_FILE"
RC=$?
set -e
printf "%s" "$RC" > "$STATUS_FILE"

if [ "$RC" -eq 0 ]; then
	pass "plain pi -e extensions/recursive.ts exits 0"
else
	fail "plain pi -e extensions/recursive.ts exits 0" "exit=$RC stderr=$(head -5 "$STDERR_FILE")"
fi

if grep -q "EXTENSION_RECURSION_OK" "$STDOUT_FILE"; then
	pass "root answer returned grandchild output"
else
	fail "root answer returned grandchild output" "stdout=$(head -5 "$STDOUT_FILE")"
fi

if grep -q "__YPI_EXTENSION_LOADED__" "$STDERR_FILE"; then
	pass "extension loaded"
else
	fail "extension loaded" "missing debug marker"
fi

if grep -q "__YPI_EXTENSION_PROMPT_PATCHED__" "$STDERR_FILE"; then
	pass "extension patched system prompt"
else
	fail "extension patched system prompt" "missing debug marker"
fi

MODEL_MARKER=$(grep "__YPI_EXTENSION_MODEL__" "$STDERR_FILE" | head -1 || true)
if [ -n "$MODEL_MARKER" ] && [[ "$MODEL_MARKER" == *"$PI_E2E_PROVIDER/"* ]] && {
	[ -z "${PI_E2E_MODEL:-}" ] || [[ "$MODEL_MARKER" == *"${PI_E2E_MODEL%%:*}"* ]];
}; then
	pass "extension copied active Pi model into RLM env"
else
	fail "extension copied active Pi model into RLM env" "stderr=$(grep "__YPI_EXTENSION_MODEL__" "$STDERR_FILE" || true)"
fi

ROOT_CALLS=$(grep -c "depth=0→1" "$TRACE" 2>/dev/null || true)
ROOT_CALLS=${ROOT_CALLS:-0}
if [ "$ROOT_CALLS" -eq 1 ]; then
	pass "trace shows exactly one root-to-child call"
else
	fail "trace shows exactly one root-to-child call" "depth=0→1 count=$ROOT_CALLS trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

GRANDCHILD_CALLS=$(grep -c "depth=1→2" "$TRACE" 2>/dev/null || true)
GRANDCHILD_CALLS=${GRANDCHILD_CALLS:-0}
if [ "$GRANDCHILD_CALLS" -eq 1 ]; then
	pass "trace shows exactly one child-to-grandchild call"
else
	fail "trace shows exactly one child-to-grandchild call" "depth=1→2 count=$GRANDCHILD_CALLS trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

if grep -q "caller=tool" "$TRACE"; then
	pass "trace records native tool caller"
else
	fail "trace records native tool caller" "trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

if grep -q "jj=off" "$TRACE"; then
	pass "native recursion works with jj disabled"
else
	fail "native recursion works with jj disabled" "trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

if ! grep -q "Use the bash tool" "$TRACE"; then
	pass "trace does not use bash rlm_query"
else
	fail "trace does not use bash rlm_query" "trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

if grep -q "prompt: Reply with exactly EXTENSION_RECURSION_OK" "$TRACE"; then
	pass "trace records the grandchild prompt"
else
	fail "trace records the grandchild prompt" "trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

COMPLETIONS=$(grep -c "COMPLETED exit=0" "$TRACE" 2>/dev/null || true)
COMPLETIONS=${COMPLETIONS:-0}
if [ "$COMPLETIONS" -eq 2 ]; then
	pass "both recursive calls completed cleanly"
else
	fail "both recursive calls completed cleanly" "COMPLETED exit=0 count=$COMPLETIONS trace=$(cat "$TRACE" 2>/dev/null || true)"
fi

echo ""
echo "stdout:"
cat "$STDOUT_FILE"
echo ""
echo "trace:"
cat "$TRACE" 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
	echo ""
	echo "Failures:"
	echo -e "$ERRORS"
	exit 1
fi

echo ""
echo "Pure extension proof passed."
