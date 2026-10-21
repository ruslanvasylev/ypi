#!/bin/bash
# test_doctor.sh — scripts/doctor catches a wrong/stale host pi. No LLM, no real pi.
#
# Fakes the pi binary via YPI_PI_BIN under controlled @earendil-works /
# @mariozechner paths so package-identity + version logic are exercised
# deterministically. Guards the exact failure this repo hit: pi was the old
# @mariozechner package at 0.73.1 instead of @earendil-works >= .pi-version.
#
# Run: bash tests/test_doctor.sh

set -uo pipefail
exec </dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCTOR="$PROJECT_DIR/scripts/doctor"
PINNED="$(tr -d '[:space:]' < "$PROJECT_DIR/.pi-version")"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ypi_doctor_test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Create a fake `pi` at a node_modules/<pkg>/dist/cli.js path reporting a version.
make_pi() {  # $1=package path segment, $2=version -> prints bin path
    local pkg="$1" ver="$2" dir
    dir="$TMP/$pkg/dist"
    mkdir -p "$dir"
    cat > "$dir/cli.js" <<EOF
#!/usr/bin/env bash
[ "\$1" = "--version" ] && { echo "$ver"; exit 0; }
exit 0
EOF
    chmod +x "$dir/cli.js"
    printf '%s\n' "$dir/cli.js"
}

run_doctor() {  # $1=pi bin -> sets RC, OUT
    set +e
    OUT="$(YPI_PI_BIN="$1" "$DOCTOR" 2>&1)"; RC=$?
    set -e
}

# 1. healthy: @earendil-works at exactly the pinned version
GOOD="$(make_pi "node_modules/@earendil-works/pi-coding-agent" "$PINNED")"
run_doctor "$GOOD"
[ "$RC" -eq 0 ] && pass "healthy pi passes (exit 0)" || fail "healthy pi passes" "rc=$RC out=$OUT"

# 2. newer patch satisfies — no false alarm as upstream advances
NEWER="$(make_pi "node_modules/@earendil-works/pi-coding-agent" "${PINNED%.*}.999")"
run_doctor "$NEWER"
[ "$RC" -eq 0 ] && pass "newer-patch pi passes (no false upstream-drift alarm)" || fail "newer-patch passes" "rc=$RC out=$OUT"

# 3. the exact failure we hit: OLD @mariozechner package -> fail WITH fix guidance
OLD="$(make_pi "node_modules/@mariozechner/pi-coding-agent" "0.73.1")"
run_doctor "$OLD"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "@earendil-works"; then
    pass "old @mariozechner pi fails with @earendil-works fix guidance"
else
    fail "old @mariozechner pi fails with guidance" "rc=$RC out=$OUT"
fi

# 4. right package but too-old version -> fail
TOOOLD="$(make_pi "node_modules/@earendil-works/pi-coding-agent" "0.1.0")"
run_doctor "$TOOOLD"
[ "$RC" -ne 0 ] && pass "too-old pi version fails" || fail "too-old pi version fails" "rc=$RC out=$OUT"

# 5. missing binary -> fail
run_doctor "$TMP/does-not-exist/pi"
[ "$RC" -ne 0 ] && pass "missing pi fails" || fail "missing pi fails" "rc=$RC out=$OUT"

# 6-7. host `pi` on PATH serves plain Pi sessions with the same extensions.
# Report drift from the pin without failing ypi, which runs its own binary.
host_pi_dir() {  # $1=name, $2=version -> prints a PATH directory holding `pi`
    local dir="$TMP/host-$1"
    mkdir -p "$dir"
    ln -sf "$(make_pi "host-$1/node_modules/@earendil-works/pi-coding-agent" "$2")" "$dir/pi"
    printf '%s\n' "$dir"
}
# make_pi reuses paths per package, so case 4 replaced $GOOD; use a fresh one.
YPI_GOOD="$(make_pi "ypi-good/node_modules/@earendil-works/pi-coding-agent" "$PINNED")"
MATCHING_HOST="$(host_pi_dir matching "$PINNED")"
set +e
OUT="$(PATH="$MATCHING_HOST:$PATH" YPI_PI_BIN="$YPI_GOOD" "$DOCTOR" 2>&1)"; RC=$?
set -e
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "host pi on PATH matches pinned $PINNED"; then
    pass "matching host pi is reported"
else
    fail "matching host pi is reported" "rc=$RC out=$OUT"
fi
DRIFTED_HOST="$(host_pi_dir drifted "0.0.1")"
set +e
OUT="$(PATH="$DRIFTED_HOST:$PATH" YPI_PI_BIN="$YPI_GOOD" "$DOCTOR" 2>&1)"; RC=$?
set -e
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "host pi on PATH is 0.0.1, pinned $PINNED"; then
    pass "drifted host pi is a non-fatal note"
else
    fail "drifted host pi is a non-fatal note" "rc=$RC out=$OUT"
fi

echo ""
echo "  Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "test_doctor: FAIL"; exit 1; }
echo "test_doctor: OK"
