#!/usr/bin/env bash
# test_consumer_pack.sh - packed npm consumer smoke tests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
	echo "SKIP: bun not installed"
	exit 0
fi

SCRATCH_ROOT="${HOME}/scratch/ypi-consumer-pack"
mkdir -p "$SCRATCH_ROOT"
TEST_TMP="$(mktemp -d "$SCRATCH_ROOT/run.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }
assert_contains() {
	local label="$1" needle="$2" haystack="$3"
	if echo "$haystack" | grep -qF -- "$needle"; then pass "$label"; else fail "$label" "expected '$needle' in '$haystack'"; fi
}
assert_not_contains() {
	local label="$1" needle="$2" haystack="$3"
	if echo "$haystack" | grep -qF -- "$needle"; then fail "$label" "unexpected '$needle' in '$haystack'"; else pass "$label"; fi
}

echo ""
echo "=== Packed Consumer Smoke ==="
echo "artifacts=$TEST_TMP"

PACK_OUTPUT="$(cd "$PROJECT_DIR" && bun pm pack --destination "$TEST_TMP" --ignore-scripts --quiet)"
PACK_OUTPUT="$(printf '%s\n' "$PACK_OUTPUT" | awk 'NF { last=$0 } END { print last }')"
if [[ "$PACK_OUTPUT" = /* ]]; then
	TGZ="$PACK_OUTPUT"
else
	TGZ="$TEST_TMP/$PACK_OUTPUT"
fi
if [ -f "$TGZ" ]; then
	pass "npm tarball created"
else
	fail "npm tarball created" "missing $TGZ"
fi

TARBALL_LIST="$(tar -tzf "$TGZ")"
assert_contains "tarball contains package manifest" "package/package.json" "$TARBALL_LIST"
assert_contains "tarball contains canonical extension" "package/extensions/recursive.ts" "$TARBALL_LIST"
assert_contains "tarball contains native modules" "package/extensions/ypi/native-tool.ts" "$TARBALL_LIST"
assert_contains "tarball contains cleanup helper" "package/rlm_cleanup" "$TARBALL_LIST"
assert_not_contains "tarball excludes private files" "package/private/" "$TARBALL_LIST"

mkdir -p "$TEST_TMP/install" "$TEST_TMP/home" "$TEST_TMP/cache"
INSTALL_LOG="$TEST_TMP/install.log"
if env \
	HOME="$TEST_TMP/home" \
	BUN_INSTALL="$TEST_TMP/install" \
	XDG_CACHE_HOME="$TEST_TMP/cache" \
	PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
	bun install -g "$TGZ" --ignore-scripts >"$INSTALL_LOG" 2>&1; then
	pass "isolated global install succeeds"
else
	fail "isolated global install succeeds" "$(tail -20 "$INSTALL_LOG")"
fi

YPI_BIN="$TEST_TMP/install/bin/ypi"
if [ -x "$YPI_BIN" ]; then
	pass "isolated global install exposes ypi"
else
	fail "isolated global install exposes ypi" "missing executable $YPI_BIN"
fi

if [ -x "$TEST_TMP/install/bin/rlm_cleanup" ]; then
	pass "isolated global install exposes rlm_cleanup"
else
	fail "isolated global install exposes rlm_cleanup" "missing executable $TEST_TMP/install/bin/rlm_cleanup"
fi

RUN_LOG="$TEST_TMP/ypi-version.log"
NODE_BIN="$(dirname "$(command -v node)")"
if env \
	HOME="$TEST_TMP/home" \
	BUN_INSTALL="$TEST_TMP/install" \
	XDG_CACHE_HOME="$TEST_TMP/cache" \
	PATH="$TEST_TMP/install/bin:$NODE_BIN:/usr/bin:/bin" \
	"$YPI_BIN" --version >"$RUN_LOG" 2>&1; then
	pass "global ypi resolves package-local pi without system pi on PATH"
else
	fail "global ypi resolves package-local pi without system pi on PATH" "$(cat "$RUN_LOG")"
fi

tar -xzf "$TGZ" -C "$TEST_TMP"
UNPACKED="$TEST_TMP/package"
if [ -f "$UNPACKED/extensions/recursive.ts" ] && [ -f "$UNPACKED/package.json" ]; then
	pass "tarball unpacks as Pi package root"
else
	fail "tarball unpacks as Pi package root" "missing package files"
fi

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
	echo -e "\nFailures:$ERRORS"
	exit 1
fi
