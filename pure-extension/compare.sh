#!/usr/bin/env bash
# Run the pure extension and current ypi wrapper side by side and record the
# observable behavioral differences.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION="$PROJECT_DIR/extensions/recursive.ts"

PI_E2E_PROVIDER="${PI_E2E_PROVIDER:-openrouter}"
PI_E2E_MODEL="${PI_E2E_MODEL:-openai/gpt-5.5:xhigh}"
SCRATCH_ROOT="${YPI_PROOF_TMPDIR:-$HOME/scratch/ypi-pure-extension}"
mkdir -p "$SCRATCH_ROOT"
RUN_DIR=$(mktemp -d "$SCRATCH_ROOT/compare.XXXXXX")

run_case() {
	local label="$1"
	local grandchild_marker="$2"
	shift 2

	local trace="$RUN_DIR/$label.trace"
	local stdout_file="$RUN_DIR/$label.stdout"
	local stderr_file="$RUN_DIR/$label.stderr"
	local status_file="$RUN_DIR/$label.status"
	local child_prompt_file="$RUN_DIR/$label.child.prompt"
	cat > "$child_prompt_file" <<EOF
Use the bash tool to run exactly this command: rlm_query "Reply with exactly $grandchild_marker". Then reply with exactly the grandchild answer and no other text.
EOF
	local prompt='Use the bash tool to run exactly this command: rlm_query "$(cat "$YPI_CHILD_PROMPT_FILE")". Then reply with exactly the child answer and no other text.'

	local counter="$RUN_DIR/$label.counter"
	local cost="$RUN_DIR/$label.cost.jsonl"
	rm -f "$counter" "$cost"
	set +e
	PI_TRACE_FILE="$trace" YPI_CHILD_PROMPT_FILE="$child_prompt_file" \
	RLM_TRACE_ID="compare-$label" RLM_CALL_COUNTER_FILE="$counter" RLM_COST_FILE="$cost" \
	RLM_CALL_COUNT=0 RLM_MAX_CALLS=4 RLM_MAX_DEPTH=2 RLM_JSON=1 \
	RLM_JJ=0 RLM_SHARED_SESSIONS=0 "$@" "$prompt" >"$stdout_file" 2>"$stderr_file"
	local rc=$?
	set -e
	printf "%s" "$rc" > "$status_file"
}

COMPARE_FAIL=0
count_pattern() {
	local pattern="$1"
	local file="$2"
	grep -c "$pattern" "$file" 2>/dev/null || printf "0"
}

check_case() {
	local label="$1"
	local marker="$2"
	local status
	status=$(cat "$RUN_DIR/$label.status")

	if [ "$status" != "0" ]; then
		echo "FAIL: $label exited $status" >&2
		COMPARE_FAIL=1
	fi
	if ! grep -q "$marker" "$RUN_DIR/$label.stdout"; then
		echo "FAIL: $label did not return $marker" >&2
		COMPARE_FAIL=1
	fi
	if [ "$(count_pattern "depth=0→1" "$RUN_DIR/$label.trace")" -ne 1 ]; then
		echo "FAIL: $label trace does not show exactly one depth=0→1 call" >&2
		COMPARE_FAIL=1
	fi
	if [ "$(count_pattern "depth=1→2" "$RUN_DIR/$label.trace")" -ne 1 ]; then
		echo "FAIL: $label trace does not show exactly one depth=1→2 call" >&2
		COMPARE_FAIL=1
	fi
	if [ "$(count_pattern "COMPLETED exit=0" "$RUN_DIR/$label.trace")" -ne 2 ]; then
		echo "FAIL: $label trace does not show two clean completions" >&2
		COMPARE_FAIL=1
	fi
}

echo "artifacts=$RUN_DIR"

# Parity is checked over the shell-helper path, so the bare `pi -e` case opts into the
# helper with YPI_SHELL_HELPER=1 (the wrapper sets this implicitly). The native-tool-only
# default for a bare extension load is proven separately in pure-extension/test.sh.
run_case "pure-extension" "PURE_COMPARE_OK" \
	env -u RLM_PROVIDER -u RLM_MODEL \
		YPI_EXTENSION_ROOT="$PROJECT_DIR" \
		YPI_EXTENSION_DEBUG=1 \
		YPI_SHELL_HELPER=1 \
		timeout 120 pi -p --no-session \
		--provider "$PI_E2E_PROVIDER" --model "$PI_E2E_MODEL" \
		-e "$EXTENSION"

run_case "wrapper" "WRAPPER_COMPARE_OK" \
	env RLM_PROVIDER="$PI_E2E_PROVIDER" RLM_MODEL="$PI_E2E_MODEL" \
		timeout 120 "$PROJECT_DIR/ypi" -p --no-session

for label in pure-extension wrapper; do
	echo ""
	echo "=== $label ==="
	echo "status=$(cat "$RUN_DIR/$label.status")"
	echo "stdout=$(tr '\n' ' ' < "$RUN_DIR/$label.stdout" | sed 's/[[:space:]]*$//')"
	echo "trace:"
	cat "$RUN_DIR/$label.trace" 2>/dev/null || true
	echo "stderr markers:"
	grep "__YPI_EXTENSION" "$RUN_DIR/$label.stderr" 2>/dev/null || true
done

check_case "pure-extension" "PURE_COMPARE_OK"
check_case "wrapper" "WRAPPER_COMPARE_OK"

exit "$COMPARE_FAIL"
