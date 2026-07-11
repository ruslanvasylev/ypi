#!/usr/bin/env bash
# test_runtime_contract.sh - shared native/CLI recursion contract tests.

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not installed"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

bun tests/runtime_contract_harness.ts
