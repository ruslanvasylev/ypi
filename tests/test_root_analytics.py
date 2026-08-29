#!/usr/bin/env python3
"""Deterministic root analytics, privacy, and append-race controls."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "root-analytics"
sys.path.insert(0, os.fspath(ROOT / "scripts"))

from ypi_transcript import (  # noqa: E402
    TranscriptReadError,
    scan_jsonl_snapshot,
    scan_text_lines_snapshot,
)


passed = 0
failed = 0


def check(condition: bool, label: str) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {label}")
    else:
        failed += 1
        print(f"  FAIL {label}", file=sys.stderr)


def private_copy(source: Path, destination: Path) -> Path:
    shutil.copyfile(source, destination)
    destination.chmod(0o600)
    return destination


def run_cost(environment: dict[str, str], *, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [os.fspath(ROOT / "rlm_cost"), "--json"],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    if expect_success and result.returncode != 0:
        raise AssertionError(result.stderr)
    return result


def expect_reader_error(path: Path, label: str, **kwargs: object) -> None:
    try:
        scan_jsonl_snapshot(path, lambda _record, _line: None, **kwargs)
    except TranscriptReadError:
        check(True, label)
    else:
        check(False, label)


def cost_identity(path: Path) -> str:
    metadata = path.stat()
    return json.dumps({
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
        "kind": "file",
        "mode": 0o600,
        "links": "1",
    })


def check_rejected_child_ledger(
    environment: dict[str, str],
    label: str,
    *,
    expected_reason: str | None = None,
) -> dict[str, object]:
    result = run_cost(environment)
    payload = json.loads(result.stdout)
    reason = payload["children"]["completeness"]["reason"]
    check(
        payload["tokens"] == 0
        and payload["children"]["tokens"] == 0
        and payload["children"]["incomplete"] is True
        and payload["children"]["incomplete_markers"] >= 1
        and payload["root"]["tokens"] == 584455
        and payload["combined"]["tokens"] == 584455
        and payload["children"]["completeness"]["trusted_snapshot"] is False
        and isinstance(reason, str)
        and (expected_reason is None or expected_reason in reason),
        label,
    )
    return payload


print("\n=== Root transcript analytics ===")
with tempfile.TemporaryDirectory(prefix="ypi-root-analytics-") as raw_scratch:
    scratch = Path(raw_scratch)
    scratch.chmod(0o700)
    root_file = private_copy(FIXTURES / "root.jsonl", scratch / "root.jsonl")
    ledger_file = private_copy(FIXTURES / "children.jsonl", scratch / "children.jsonl")
    trace_file = private_copy(FIXTURES / "trace.txt", scratch / "trace.log")
    environment = os.environ.copy()
    environment.update({
        "RLM_SESSION_FILE": os.fspath(root_file),
        "RLM_COST_FILE": os.fspath(ledger_file),
        "PI_TRACE_FILE": os.fspath(trace_file),
        "RLM_SESSION_DIR": os.fspath(scratch / "must-not-be-scanned"),
    })
    result = run_cost(environment)
    payload = json.loads(result.stdout)
    plain_result = subprocess.run(
        [os.fspath(ROOT / "rlm_cost")],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    check(plain_result.returncode == 0 and plain_result.stdout.strip() == "$4.610000", "plain output intentionally reports combined active-tree cost")

    root_stat = root_file.stat()
    bound_environment = dict(environment)
    bound_environment["YPI_ROOT_SESSION_FILE_IDENTITY"] = json.dumps({
        "device": str(root_stat.st_dev),
        "inode": str(root_stat.st_ino),
        "kind": "file",
        "mode": 0o600,
        "links": "1",
    })
    check(run_cost(bound_environment).returncode == 0, "projected active-file identity binds the analytics read")
    wrong_identity = dict(bound_environment)
    wrong_identity["YPI_ROOT_SESSION_FILE_IDENTITY"] = json.dumps({
        "device": str(root_stat.st_dev),
        "inode": str(root_stat.st_ino + 1),
        "kind": "file",
        "mode": 0o600,
        "links": "1",
    })
    check(run_cost(wrong_identity, expect_success=False).returncode != 0, "mismatched projected active-file identity fails closed")

    expected_children = {
        "cost": 1.0,
        "tokens": 1000,
        "input": 200,
        "output": 150,
        "cache_read": 650,
        "cache_write": 0,
        "reasoning": 70,
        "turns": 3,
        "over_272k_turns": 1,
        "peak_context_tokens": 280000,
        "calls": 2,
    }
    check(all(payload[key] == value for key, value in expected_children.items()), "legacy child fields remain exact")
    check(all(payload["children"][key] == value for key, value in expected_children.items()), "children object mirrors legacy totals")

    root = payload["root"]
    expected_root = {
        "cost": 3.61,
        "tokens": 584455,
        "input": 400170,
        "output": 3045,
        "cache_read": 180230,
        "cache_write": 1010,
        "reasoning": 609,
        "turns": 5,
        "over_272k_turns": 2,
        "peak_context_tokens": 300000,
    }
    check(all(root[key] == value for key, value in expected_root.items()), "root usage categories match hand-calculated fixture")
    check(root["session_id"] == "root-session-1" and root["identity"]["exact"], "session-header plus entry identity is exact")
    check(len(root["model_epochs"]) == 1 and len(root["thinking_epochs"]) == 1, "model and thinking epochs are reported without duplicate inference")
    check(root["model_epochs"][0]["usage"]["cost"] == 3.56 and root["thinking_epochs"][0]["usage"]["turns"] == 5, "model and thinking epochs carry attributed model usage")
    check(root["compaction_count"] == 1 and root["compactions"][0]["tokens_before"] == 500000, "compaction count and direct tokensBefore are reported")
    check(root["compactions"][0]["estimated_after_tokens"] == 50, "compaction estimated-after uses the next assistant context")
    check(root["compactions"][0]["trigger_reason"] is None, "offline compaction reason is not fabricated")
    check(root["billable_tool_result_count"] == 1, "only explicit ToolResultMessage usage is billable root usage")
    check("DO_NOT_EMIT_PRIVATE_PAYLOAD" not in result.stdout and "PRIVATE_SUMMARY" not in result.stdout, "prompt, tool, and summary content never enter output")
    check(payload["scope"]["historical_directory_scan"] is False, "default scope performs no directory scan")
    check(payload["scope"]["cross_file_atomic_snapshot"] is False, "cross-file snapshot non-atomicity is explicit")
    check(payload["scope"]["current_generation_correlation_exact"] is True, "latest trace generation is exact")
    check(root["current_generation"]["cost"] == 3.6 and payload["children"]["current_generation"]["cost"] == 0.6, "root and child current-generation totals are separated")
    check(payload["combined"]["cost"] == 4.61 and payload["combined"]["current_generation"]["cost"] == 4.2, "combined totals are non-double-counted")
    check(root["snapshot"]["bytes_scanned"] == root_file.stat().st_size and root["snapshot"]["peak_record_bytes"] > 0, "snapshot performance evidence is emitted")
    check(payload["children"]["snapshot"]["bytes_scanned"] == ledger_file.stat().st_size, "child ledger snapshot performance evidence is emitted")
    check(payload["children"]["completeness"]["trusted_snapshot"] is True and payload["children"]["completeness"]["identity_bound"] is False, "legacy child ledger remains readable without a projected identity")

    bound_ledger_environment = dict(environment)
    bound_ledger_environment["YPI_COST_FILE_IDENTITY"] = cost_identity(ledger_file)
    bound_ledger_payload = json.loads(run_cost(bound_ledger_environment).stdout)
    check(bound_ledger_payload["children"]["tokens"] == 1000 and bound_ledger_payload["children"]["completeness"]["identity_bound"] is True, "projected child-ledger identity binds the analytics read")

    wrong_ledger_identity = dict(bound_ledger_environment)
    wrong_identity_value = json.loads(wrong_ledger_identity["YPI_COST_FILE_IDENTITY"])
    wrong_identity_value["inode"] = str(int(wrong_identity_value["inode"]) + 1)
    wrong_ledger_identity["YPI_COST_FILE_IDENTITY"] = json.dumps(wrong_identity_value)
    check_rejected_child_ledger(wrong_ledger_identity, "mismatched child-ledger identity rejects fabricated totals", expected_reason="projected active-file identity")

    malformed_identity = dict(environment)
    malformed_identity["YPI_COST_FILE_IDENTITY"] = '{"device":"1"}'
    check_rejected_child_ledger(malformed_identity, "malformed child-ledger identity degrades telemetry instead of product work", expected_reason="Invalid projected child-ledger identity")

    ledger_outside = scratch / "ledger-outside.jsonl"
    ledger_outside.write_text(json.dumps({
        "type": "child_usage",
        "cost": 123.45,
        "tokens": 999999,
        "input": 999999,
    }) + "\n")
    ledger_outside.chmod(0o600)
    ledger_symlink = scratch / "ledger-symlink.jsonl"
    ledger_symlink.symlink_to(ledger_outside)
    symlink_ledger_environment = dict(environment)
    symlink_ledger_environment["RLM_COST_FILE"] = os.fspath(ledger_symlink)
    symlink_payload = check_rejected_child_ledger(symlink_ledger_environment, "symlinked child ledger cannot fabricate complete totals")
    check("999999" not in json.dumps(symlink_payload), "rejected child ledger never leaks fabricated sentinel totals")

    hardlink_source = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-hardlink-source.jsonl")
    ledger_hardlink = scratch / "ledger-hardlink.jsonl"
    os.link(hardlink_source, ledger_hardlink)
    hardlink_ledger_environment = dict(environment)
    hardlink_ledger_environment["RLM_COST_FILE"] = os.fspath(ledger_hardlink)
    check_rejected_child_ledger(hardlink_ledger_environment, "hardlinked child ledger cannot produce trusted totals", expected_reason="singly linked")

    permissive_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-mode.jsonl")
    permissive_ledger.chmod(0o664)
    permissive_ledger_environment = dict(environment)
    permissive_ledger_environment["RLM_COST_FILE"] = os.fspath(permissive_ledger)
    check_rejected_child_ledger(permissive_ledger_environment, "wrong-mode child ledger cannot produce trusted totals", expected_reason="mode 0600")

    malformed_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-malformed.jsonl")
    with malformed_ledger.open("a", encoding="utf-8") as stream:
        stream.write("{not-json}\n")
        stream.write(json.dumps({"type": "child_usage", "cost": 0.25, "tokens": 25}) + "\n")
    malformed_ledger_payload_environment = dict(environment)
    malformed_ledger_payload_environment["RLM_COST_FILE"] = os.fspath(malformed_ledger)
    malformed_ledger_payload = json.loads(run_cost(malformed_ledger_payload_environment).stdout)
    check(malformed_ledger_payload["children"]["tokens"] == 1025 and malformed_ledger_payload["children"]["calls"] == 3 and malformed_ledger_payload["children"]["incomplete_markers"] == 1, "malformed legacy ledger rows are skipped without hiding later valid rows")

    partial_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-partial.jsonl")
    with partial_ledger.open("ab") as stream:
        stream.write(b'{"type":"child_usage","cost":999999,"tokens":999999')
    partial_ledger_environment = dict(environment)
    partial_ledger_environment["RLM_COST_FILE"] = os.fspath(partial_ledger)
    partial_ledger_payload = json.loads(run_cost(partial_ledger_environment).stdout)
    check(partial_ledger_payload["children"]["tokens"] == 1000 and partial_ledger_payload["children"]["incomplete_markers"] == 1 and partial_ledger_payload["children"]["snapshot"]["trailing_record_incomplete"] is True, "partial child-ledger tail is excluded and marked incomplete")

    invalid_utf8_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-utf8.jsonl")
    with invalid_utf8_ledger.open("ab") as stream:
        stream.write(b'\xff\n')
    invalid_utf8_environment = dict(environment)
    invalid_utf8_environment["RLM_COST_FILE"] = os.fspath(invalid_utf8_ledger)
    check_rejected_child_ledger(invalid_utf8_environment, "invalid UTF-8 rejects the entire child-ledger snapshot", expected_reason="Invalid text snapshot UTF-8")

    append_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-append.jsonl")
    append_lines: list[str] = []
    def ledger_append_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "after_open":
            with append_ledger.open("ab") as stream:
                stream.write(b'{"type":"child_usage","tokens":999999}\n')
    append_ledger_metrics = scan_text_lines_snapshot(append_ledger, lambda line, _number: append_lines.append(line), test_hook=ledger_append_hook)
    check(len(append_lines) == 2 and append_ledger_metrics.final_size > append_ledger_metrics.captured_size, "child-ledger append growth stays outside the captured prefix")

    mutated_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-mutated.jsonl")
    def ledger_mutation_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "before_verify":
            with mutated_ledger.open("r+b") as stream:
                stream.seek(1)
                stream.write(b"X")
    try:
        scan_text_lines_snapshot(mutated_ledger, lambda _line, _number: None, test_hook=ledger_mutation_hook)
    except TranscriptReadError:
        check(True, "child-ledger captured-prefix mutation is rejected")
    else:
        check(False, "child-ledger captured-prefix mutation is rejected")

    truncated_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-truncated.jsonl")
    def ledger_truncate_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "after_open":
            os.truncate(truncated_ledger, 0)
    try:
        scan_text_lines_snapshot(truncated_ledger, lambda _line, _number: None, test_hook=ledger_truncate_hook)
    except TranscriptReadError:
        check(True, "child-ledger truncation below the boundary is rejected")
    else:
        check(False, "child-ledger truncation below the boundary is rejected")

    replaced_ledger = private_copy(FIXTURES / "children.jsonl", scratch / "ledger-replaced.jsonl")
    replaced_ledger_old = scratch / "ledger-replaced.old"
    def ledger_replace_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "before_verify":
            replaced_ledger.rename(replaced_ledger_old)
            replaced_ledger.write_text('{"type":"child_usage","tokens":999999}\n')
            replaced_ledger.chmod(0o600)
    try:
        scan_text_lines_snapshot(replaced_ledger, lambda _line, _number: None, test_hook=ledger_replace_hook)
    except TranscriptReadError:
        check(True, "child-ledger pathname replacement is rejected")
    else:
        check(False, "child-ledger pathname replacement is rejected")

    oversized_ledger = scratch / "ledger-oversized.jsonl"
    oversized_ledger.write_text("123456789\n")
    oversized_ledger.chmod(0o600)
    try:
        scan_text_lines_snapshot(oversized_ledger, lambda _line, _number: None, max_record_bytes=8)
    except TranscriptReadError:
        check(True, "oversized child-ledger rows are rejected")
    else:
        check(False, "oversized child-ledger rows are rejected")

    duplicate_file = scratch / "duplicate-entry.jsonl"
    fixture_lines = root_file.read_text().splitlines()
    duplicate_file.write_text(root_file.read_text() + fixture_lines[4] + "\n")
    duplicate_file.chmod(0o600)
    duplicate_env = dict(environment)
    duplicate_env["RLM_SESSION_FILE"] = os.fspath(duplicate_file)
    duplicate_payload = json.loads(run_cost(duplicate_env).stdout)
    check(duplicate_payload["root"]["tokens"] == expected_root["tokens"], "duplicate session-entry identity is not double-counted")
    check(duplicate_payload["root"]["identity"]["duplicate_entries_ignored"] == 1 and duplicate_payload["root"]["identity"]["exact"] is False, "duplicate identity degrades completeness explicitly")

    repeated_response = scratch / "repeated-response.jsonl"
    repeated_response.write_text("\n".join([
        json.dumps({"type": "session", "version": 3, "id": "response-session", "timestamp": "2026-08-28T00:00:00Z", "cwd": "/synthetic"}),
        json.dumps({"type": "message", "id": "entry-one", "parentId": None, "timestamp": "2026-08-28T00:00:01Z", "message": {"role": "assistant", "provider": "test", "model": "test", "responseId": "same-provider-id", "content": [], "usage": {"input": 1, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1, "cost": {"total": 0}}}}),
        json.dumps({"type": "message", "id": "entry-two", "parentId": "entry-one", "timestamp": "2026-08-28T00:00:02Z", "message": {"role": "assistant", "provider": "test", "model": "test", "responseId": "same-provider-id", "content": [], "usage": {"input": 1, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1, "cost": {"total": 0}}}}),
    ]) + "\n")
    repeated_response.chmod(0o600)
    repeated_env = dict(environment)
    repeated_env["RLM_SESSION_FILE"] = os.fspath(repeated_response)
    repeated_env.pop("PI_TRACE_FILE")
    repeated_payload = json.loads(run_cost(repeated_env).stdout)
    check(repeated_payload["root"]["tokens"] == 2 and repeated_payload["root"]["turns"] == 2, "provider responseId remains secondary and cannot collapse distinct session entries")

    no_trace = dict(environment)
    no_trace.pop("PI_TRACE_FILE")
    no_trace_payload = json.loads(run_cost(no_trace).stdout)
    check(no_trace_payload["scope"]["current_generation_correlation_exact"] is False, "missing trace is explicitly inexact")
    check(no_trace_payload["root"]["current_generation"] is None and no_trace_payload["combined"]["current_generation"] is None, "inexact generation is never fabricated")

    partial_trace = scratch / "partial-trace.log"
    partial_trace.write_bytes(trace_file.read_bytes() + b"[2026-08-28T11:00:00.000Z] TREE_GENERATION_START generation=")
    partial_trace.chmod(0o600)
    partial_trace_env = dict(environment)
    partial_trace_env["PI_TRACE_FILE"] = os.fspath(partial_trace)
    partial_trace_payload = json.loads(run_cost(partial_trace_env).stdout)
    check(partial_trace_payload["scope"]["current_generation_correlation_exact"] is False, "partial newest generation trace cannot make stale correlation exact")

    invalid_time_trace = scratch / "invalid-time-trace.log"
    invalid_time_trace.write_text("[not-a-time] TREE_GENERATION_START generation=22222222222222222222222222222222 root_pid=2\n")
    invalid_time_trace.chmod(0o600)
    invalid_time_env = dict(environment)
    invalid_time_env["PI_TRACE_FILE"] = os.fspath(invalid_time_trace)
    invalid_time_payload = json.loads(run_cost(invalid_time_env).stdout)
    check(invalid_time_payload["scope"]["current_generation_correlation_exact"] is False, "invalid generation timestamp cannot produce exact correlation")

    no_root = dict(environment)
    no_root.pop("RLM_SESSION_FILE")
    no_root_payload = json.loads(run_cost(no_root).stdout)
    check(no_root_payload["root"] is None and no_root_payload["combined"]["cost"] == 1.0, "unset root is explicit and does not trigger a directory scan")

    insecure = scratch / "insecure.jsonl"
    private_copy(FIXTURES / "root.jsonl", insecure)
    insecure.chmod(0o664)
    insecure_env = dict(environment)
    insecure_env["RLM_SESSION_FILE"] = os.fspath(insecure)
    insecure_result = run_cost(insecure_env, expect_success=False)
    check(insecure_result.returncode != 0 and "mode 0600" in insecure_result.stderr, "insecure active transcript fails closed")

    append_file = scratch / "append.jsonl"
    append_file.write_text('{"type":"session","id":"append","timestamp":"2026-01-01T00:00:00Z"}\n')
    append_file.chmod(0o600)
    observed: list[dict[str, object]] = []
    def append_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "after_open":
            with append_file.open("ab") as stream:
                stream.write(b'{"type":"message","id":"later"}\n')
    append_metrics = scan_jsonl_snapshot(append_file, lambda row, _line: observed.append(row), test_hook=append_hook)
    check(len(observed) == 1 and append_metrics.final_size > append_metrics.captured_size, "append growth is accepted outside the captured prefix")

    partial = scratch / "partial.jsonl"
    partial.write_bytes(b'{"type":"session","id":"partial"}\n{"type":"message"')
    partial.chmod(0o600)
    partial_rows: list[dict[str, object]] = []
    partial_metrics = scan_jsonl_snapshot(partial, lambda row, _line: partial_rows.append(row))
    check(len(partial_rows) == 1 and partial_metrics.trailing_record_incomplete, "incomplete trailing event is marked and excluded")

    mutated = scratch / "mutated.jsonl"
    mutated.write_bytes(b'{"type":"session","id":"mutable"}\n')
    mutated.chmod(0o600)
    def mutation_hook(stage: str, descriptor: int, _size: int) -> None:
        if stage == "before_verify":
            del descriptor
            with mutated.open("r+b") as stream:
                stream.seek(1)
                stream.write(b"X")
    expect_reader_error(mutated, "captured-prefix mutation is rejected", test_hook=mutation_hook)

    truncated = scratch / "truncated.jsonl"
    truncated.write_bytes(b'{"type":"session","id":"truncate"}\n')
    truncated.chmod(0o600)
    def truncate_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "after_open":
            os.truncate(truncated, 0)
    expect_reader_error(truncated, "truncation below the boundary is rejected", test_hook=truncate_hook)

    replaced = scratch / "replaced.jsonl"
    replaced.write_bytes(b'{"type":"session","id":"original"}\n')
    replaced.chmod(0o600)
    replacement_old = scratch / "replaced.old"
    def replace_hook(stage: str, _descriptor: int, _size: int) -> None:
        if stage == "before_verify":
            replaced.rename(replacement_old)
            replaced.write_bytes(b'{"type":"session","id":"replacement"}\n')
            replaced.chmod(0o600)
    expect_reader_error(replaced, "pathname replacement is rejected", test_hook=replace_hook)

    malformed = scratch / "malformed.jsonl"
    malformed.write_bytes(b'{not json}\n')
    malformed.chmod(0o600)
    expect_reader_error(malformed, "malformed complete JSONL is rejected")
    invalid_utf8 = scratch / "utf8.jsonl"
    invalid_utf8.write_bytes(b'{"type":"session"}\xff\n')
    invalid_utf8.chmod(0o600)
    expect_reader_error(invalid_utf8, "invalid complete UTF-8 is rejected")
    non_object = scratch / "array.jsonl"
    non_object.write_bytes(b'[]\n')
    non_object.chmod(0o600)
    expect_reader_error(non_object, "non-object events are rejected")
    oversized = scratch / "oversized.jsonl"
    oversized.write_bytes(b'{"x":"1234567890"}\n')
    oversized.chmod(0o600)
    expect_reader_error(oversized, "oversized events are rejected", max_record_bytes=8)

    outside = scratch / "outside.jsonl"
    outside.write_bytes(b'{"type":"session"}\n')
    outside.chmod(0o600)
    symlink = scratch / "symlink.jsonl"
    symlink.symlink_to(outside)
    expect_reader_error(symlink, "symlinked transcripts are rejected")
    hardlink = scratch / "hardlink.jsonl"
    os.link(outside, hardlink)
    expect_reader_error(outside, "hardlinked transcripts are rejected")

    scratch.chmod(0o775)
    permissive_parent = scratch / "parent-0775.jsonl"
    permissive_parent.write_bytes(b'{"type":"session","id":"permitted-parent"}\n')
    permissive_parent.chmod(0o600)
    parent_rows: list[dict[str, object]] = []
    scan_jsonl_snapshot(permissive_parent, lambda row, _line: parent_rows.append(row))
    check(len(parent_rows) == 1, "owner 0775 Pi session directory remains compatible")

print(f"\nResults: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
