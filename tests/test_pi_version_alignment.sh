#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$PROJECT_DIR/scripts/check-pi-version-alignment"
PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ypi-version-alignment.XXXXXX")"
trap 'if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf -- "$TMP_ROOT"; fi' EXIT

pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }

printf '\n=== Pi version alignment ===\n'

if "$CHECK" >/dev/null; then
	pass "exact repository candidate passes"
else
	fail "exact repository candidate passes"
fi

if sed -n '/uses: actions\/checkout@v4/,/uses: oven-sh\/setup-bun@v2/p' "$PROJECT_DIR/.github/workflows/ci.yml" \
	| grep -Eq '^[[:space:]]+submodules:[[:space:]]+(true|recursive)[[:space:]]*$'; then
	pass "CI initializes the pinned Pi source submodule"
else
	fail "CI initializes the pinned Pi source submodule"
fi

mkdir -p "$TMP_ROOT/bin"
printf '#!/bin/sh\nprintf "0.83.0\\n"\n' > "$TMP_ROOT/bin/pi"
chmod 700 "$TMP_ROOT/bin/pi"
if YPI_ALIGNMENT_PI_BIN="$TMP_ROOT/bin/pi" "$CHECK" >"$TMP_ROOT/wrong-binary.out" 2>&1; then
	fail "wrong binary fails closed"
elif grep -q 'repository Pi binary=0.83.0' "$TMP_ROOT/wrong-binary.out"; then
	pass "wrong binary fails closed"
else
	fail "wrong binary reports the identity mismatch"
fi

mkdir -p "$TMP_ROOT/stale-source/packages/coding-agent" "$TMP_ROOT/stale-source/packages/ai"
printf '{"version":"0.52.9"}\n' > "$TMP_ROOT/stale-source/packages/coding-agent/package.json"
printf '{"version":"0.52.9"}\n' > "$TMP_ROOT/stale-source/packages/ai/package.json"
if YPI_ALIGNMENT_SOURCE_ROOT="$TMP_ROOT/stale-source" "$CHECK" >"$TMP_ROOT/stale-source.out" 2>&1; then
	fail "stale source fails closed"
elif grep -q 'pi-mono coding-agent=0.52.9' "$TMP_ROOT/stale-source.out"; then
	pass "stale source fails closed"
else
	fail "stale source reports the source mismatch"
fi

if YPI_LATEST_PI_VERSION="$(tr -d '[:space:]' < "$PROJECT_DIR/.pi-version")" "$PROJECT_DIR/scripts/check-upstream" --dry-run >/dev/null; then
	pass "upstream dry-run verifies the coherent candidate without mutation"
else
	fail "upstream dry-run verifies the coherent candidate without mutation"
fi

if "$PROJECT_DIR/scripts/check-upstream" --install >"$TMP_ROOT/retired-install.out" 2>&1; then
	fail "retired global installer fails closed"
elif grep -q 'does not install the host Pi' "$TMP_ROOT/retired-install.out"; then
	pass "retired global installer explains the safe promotion boundary"
else
	fail "retired global installer provides remediation"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
