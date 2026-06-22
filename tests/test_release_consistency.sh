#!/bin/bash
# test_release_consistency.sh — scripts/check-release-consistency enforces the
# two-package lockstep + changelog invariants. No LLM. Uses YPI_CHECK_ROOT fixtures.
#
# Run: bash tests/test_release_consistency.sh

set -uo pipefail
exec </dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK="$PROJECT_DIR/scripts/check-release-consistency"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ypi_relcheck_test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Build a fixture repo root. Args: ypi_ver pir_ver dep peer piversion changelog_heading
mkfix() {
    local root="$TMP/$1"; shift
    local ypiv="$1" pirv="$2" dep="$3" peer="$4" piver="$5" clhead="$6"
    mkdir -p "$root/pi-recursive"
    printf '{"name":"ypi","version":"%s","dependencies":{"@earendil-works/pi-coding-agent":"%s"}}\n' "$ypiv" "$dep" > "$root/package.json"
    printf '{"name":"pi-recursive","version":"%s","peerDependencies":{"@earendil-works/pi-coding-agent":"%s"}}\n' "$pirv" "$peer" > "$root/pi-recursive/package.json"
    printf '%s\n' "$piver" > "$root/.pi-version"
    printf '# Changelog\n\n%s\n\n- stuff\n' "$clhead" > "$root/CHANGELOG.md"
    printf '%s\n' "$root"
}

run() {  # $1=root, $2=optional flag -> sets RC, OUT
    set +e
    OUT="$(YPI_CHECK_ROOT="$1" "$CHECK" ${2:-} 2>&1)"; RC=$?
    set -e
}

# 1. fully consistent (caret peerDep, undated changelog) -> PASS in default mode
R="$(mkfix good 0.6.0 0.6.0 0.79.4 ^0.79.4 0.79.4 '## [0.6.0] - Unreleased')"
run "$R"
[ "$RC" -eq 0 ] && pass "consistent repo passes (default mode)" || fail "consistent passes" "rc=$RC out=$OUT"

# 2. same fixture but --require-dated -> FAIL (heading is Unreleased)
run "$R" --require-dated
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'dated'; then pass "--require-dated fails on Unreleased heading"; else fail "--require-dated fails undated" "rc=$RC out=$OUT"; fi

# 3. dated changelog -> PASS even with --require-dated
R2="$(mkfix dated 0.6.0 0.6.0 0.79.4 ^0.79.4 0.79.4 '## [0.6.0] - 2026-06-22')"
run "$R2" --require-dated
[ "$RC" -eq 0 ] && pass "dated changelog passes --require-dated" || fail "dated passes" "rc=$RC out=$OUT"

# 4. version skew between ypi and pi-recursive -> FAIL
R="$(mkfix skew 0.6.0 0.6.1 0.79.4 ^0.79.4 0.79.4 '## [0.6.0] - 2026-06-22')"
run "$R"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'lockstep'; then pass "ypi/pi-recursive version skew fails"; else fail "version skew fails" "rc=$RC out=$OUT"; fi

# 5. pinned-pi skew (.pi-version diverges from deps) -> FAIL
R="$(mkfix piskew 0.6.0 0.6.0 0.79.4 ^0.79.4 0.79.10 '## [0.6.0] - 2026-06-22')"
run "$R"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'pinned pi'; then pass "pinned-pi skew fails"; else fail "pinned-pi skew fails" "rc=$RC out=$OUT"; fi

# 6. missing CHANGELOG entry for the version -> FAIL
R="$(mkfix nocl 0.6.0 0.6.0 0.79.4 ^0.79.4 0.79.4 '## [0.5.0] - 2026-01-01')"
run "$R"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'CHANGELOG'; then pass "missing changelog entry fails"; else fail "missing changelog entry fails" "rc=$RC out=$OUT"; fi

echo ""
echo "  Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "test_release_consistency: FAIL"; exit 1; }
echo "test_release_consistency: OK"
