#!/bin/bash
# test_install_from_registry.sh — prove the REAL `pi install npm:pi-recursive`
# flow works end-to-end against the PUBLISHED registry package: install →
# settings wiring → native rlm_query tool registration. Isolated in a throwaway
# PI_CODING_AGENT_DIR so it never touches the user's ~/.pi.
#
# GATED: needs network + the package published, so it stays OUT of the hermetic
# fast suite / CI. Skips unless YPI_TEST_REGISTRY_INSTALL=1.
#
# Run:
#   YPI_TEST_REGISTRY_INSTALL=1 bash tests/test_install_from_registry.sh
# Env:
#   PI_PKG_SPEC=npm:pi-recursive   override the install spec
#   PKG_MIN_AGE_DAYS=0             bypass a local package-age cooldown for a
#                                  just-published version (this machine has one)

set -uo pipefail
exec </dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${YPI_TEST_REGISTRY_INSTALL:-0}" != "1" ]; then
    echo "SKIP: registry-install test (set YPI_TEST_REGISTRY_INSTALL=1; needs network + a published package)"
    exit 0
fi
if ! command -v pi >/dev/null 2>&1; then
    echo "SKIP: pi not installed"
    exit 0
fi

SPEC="${PI_PKG_SPEC:-npm:pi-recursive}"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

SB="$(mktemp -d "${TMPDIR:-/tmp}/ypi_reg_install.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/proj" "$SB/pihome"

echo ""
echo "=== Registry install proof: pi install -l $SPEC (isolated PI_CODING_AGENT_DIR) ==="

INSTALL_LOG="$SB/install.log"
( cd "$SB/proj" && PI_CODING_AGENT_DIR="$SB/pihome" \
    NPM_CONFIG_MIN_RELEASE_AGE="${NPM_CONFIG_MIN_RELEASE_AGE:-0}" \
    PKG_MIN_AGE_DAYS="${PKG_MIN_AGE_DAYS:-0}" \
    timeout 240 pi install -l "$SPEC" ) >"$INSTALL_LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
    pass "pi install -l $SPEC exits 0"
else
    fail "pi install -l $SPEC exits 0" "rc=$RC :: $(tail -3 "$INSTALL_LOG" | tr '\n' ' ')"
fi

SETTINGS="$(find "$SB/proj/.pi" -name settings.json 2>/dev/null | head -1)"
if [ -n "$SETTINGS" ] && grep -q "$SPEC" "$SETTINGS" 2>/dev/null; then
    pass "settings.json records $SPEC"
else
    fail "settings.json records $SPEC" "settings=$SETTINGS"
fi

# Assert pi loads the INSTALLED extension and registers the native recursion tool.
LOAD_LOG="$SB/load.log"
( cd "$SB/proj" && PI_CODING_AGENT_DIR="$SB/pihome" YPI_EXTENSION_DEBUG=1 \
    timeout 40 pi --list-models test ) >"$LOAD_LOG" 2>&1
if grep -q '__YPI_NATIVE_TOOL_REGISTERED__' "$LOAD_LOG" && grep -q '__YPI_EXTENSION_LOADED__' "$LOAD_LOG"; then
    pass "installed extension loads and registers the native rlm_query tool"
else
    fail "installed extension registers the native rlm_query tool" "$(tail -4 "$LOAD_LOG" | tr '\n' ' ')"
fi

echo ""
echo "  Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "test_install_from_registry: FAIL"; exit 1; }
echo "test_install_from_registry: OK"
