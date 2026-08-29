#!/usr/bin/env python3
"""Opt-in local-only aggregate cross-check for a private incident transcript."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, os.fspath(ROOT / "scripts"))
from ypi_root_analytics import analyze_root  # noqa: E402

source = os.environ.get("YPI_INCIDENT_SESSION_FILE")
if not source:
    print("root incident cross-check: SKIP (set YPI_INCIDENT_SESSION_FILE explicitly)")
    raise SystemExit(0)

expected_raw = os.environ.get("YPI_INCIDENT_EXPECTED_JSON")
if not expected_raw:
    print("root incident cross-check: YPI_INCIDENT_EXPECTED_JSON is required", file=sys.stderr)
    raise SystemExit(2)
expected = json.loads(expected_raw)
if not isinstance(expected, dict):
    raise SystemExit("root incident cross-check: expected JSON must be an object")

with tempfile.TemporaryDirectory(prefix="ypi-private-incident-") as raw_scratch:
    scratch = Path(raw_scratch)
    scratch.chmod(0o700)
    local_copy = scratch / "incident.jsonl"
    shutil.copyfile(source, local_copy)
    local_copy.chmod(0o600)
    actual = analyze_root(os.fspath(local_copy), None)
    mismatches = {
        key: {"expected": value, "actual": actual.get(key)}
        for key, value in expected.items()
        if actual.get(key) != value
    }
    if mismatches:
        print(json.dumps({"verdict": "FAIL", "mismatches": mismatches}), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps({
        "verdict": "PASS",
        "checked_fields": sorted(expected),
        "bytes_scanned": actual["snapshot"]["bytes_scanned"],
        "session_file": actual["session_file"],
    }))
