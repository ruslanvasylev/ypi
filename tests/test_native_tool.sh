#!/usr/bin/env bash
# test_native_tool.sh - native extension rlm_query control-plane tests.

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
	echo "SKIP: bun not installed"
	exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

bun tests/native_tool_harness.ts
