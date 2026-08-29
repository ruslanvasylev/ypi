#!/usr/bin/env python3
"""Root Pi transcript analytics for the observational ``rlm_cost`` tool."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from ypi_transcript import (
    SnapshotMetrics,
    TranscriptReadError,
    read_text_snapshot,
    scan_jsonl_snapshot,
)


LONG_CONTEXT_THRESHOLD = 272_000
GENERATION_PATTERN = re.compile(
    r"^\[([^\]]+)\] TREE_GENERATION_START generation=([0-9a-f]{32})(?:\s|$)"
)


def empty_totals() -> dict[str, Any]:
    return {
        "cost": 0.0,
        "tokens": 0,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "reasoning": 0,
        "turns": 0,
        "over_272k_turns": 0,
        "peak_context_tokens": 0,
    }


def _number(value: Any, *, integer: bool) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if integer:
        return int(value) if value >= 0 else 0
    return float(value) if value >= 0 else 0.0


def usage_totals(
    usage: Any,
    *,
    count_turn: bool = True,
    count_context: bool = True,
) -> dict[str, Any]:
    if not isinstance(usage, dict):
        return empty_totals()
    input_tokens = int(_number(usage.get("input"), integer=True))
    output_tokens = int(_number(usage.get("output"), integer=True))
    cache_read = int(_number(usage.get("cacheRead"), integer=True))
    cache_write = int(_number(usage.get("cacheWrite"), integer=True))
    reasoning = int(_number(usage.get("reasoning"), integer=True))
    total_value = usage.get("totalTokens")
    if isinstance(total_value, bool) or not isinstance(total_value, (int, float)) or total_value < 0:
        total_tokens = input_tokens + output_tokens + cache_read + cache_write
    else:
        total_tokens = int(total_value)
    cost = usage.get("cost")
    total_cost = float(_number(cost.get("total") if isinstance(cost, dict) else 0, integer=False))
    context = input_tokens + cache_read + cache_write if count_context else 0
    return {
        "cost": total_cost,
        "tokens": total_tokens,
        "input": input_tokens,
        "output": output_tokens,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "reasoning": reasoning,
        "turns": int(count_turn),
        "over_272k_turns": int(count_context and context > LONG_CONTEXT_THRESHOLD),
        "peak_context_tokens": context,
    }


def add_totals(target: dict[str, Any], delta: dict[str, Any]) -> None:
    target["cost"] = float(target["cost"]) + float(delta["cost"])
    for key in (
        "tokens",
        "input",
        "output",
        "cache_read",
        "cache_write",
        "reasoning",
        "turns",
        "over_272k_turns",
    ):
        target[key] = int(target[key]) + int(delta[key])
    target["peak_context_tokens"] = max(
        int(target["peak_context_tokens"]), int(delta["peak_context_tokens"])
    )


def rounded_totals(value: dict[str, Any]) -> dict[str, Any]:
    result = dict(value)
    result["cost"] = round(float(result["cost"]), 6)
    return result


def combine_totals(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    combined = empty_totals()
    add_totals(combined, left)
    add_totals(combined, right)
    return rounded_totals(combined)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class RootAccumulator:
    def __init__(self, generation_started_at: str | None):
        self.session_id: str | None = None
        self.session_header_count = 0
        self.seen_entries: set[tuple[str, str]] = set()
        self.missing_entry_ids = 0
        self.duplicate_entries = 0
        self.invalid_usage_records = 0
        self.totals = empty_totals()
        self.current_totals = empty_totals()
        self.generation_started_at = generation_started_at
        self.generation_start = _timestamp(generation_started_at)
        self.generation_timestamp_valid = generation_started_at is None or self.generation_start is not None
        self.model_epochs: list[dict[str, Any]] = []
        self.thinking_epochs: list[dict[str, Any]] = []
        self.compactions: list[dict[str, Any]] = []
        self.branch_summary_count = 0
        self.billable_tool_results = 0
        self.pending_compactions: list[int] = []
        self.current_model: tuple[str | None, str | None] | None = None
        self.current_thinking: str | None = None

    def _is_current(self, record: dict[str, Any]) -> bool:
        if self.generation_start is None:
            return False
        observed = _timestamp(record.get("timestamp"))
        return observed is not None and observed >= self.generation_start

    def _entry_is_new(self, record: dict[str, Any]) -> bool:
        if record.get("type") == "session":
            self.session_header_count += 1
            header_id = record.get("id")
            if isinstance(header_id, str) and header_id:
                if self.session_id is None:
                    self.session_id = header_id
                elif self.session_id != header_id:
                    raise TranscriptReadError("Transcript contains multiple session header identities")
            return True
        entry_id = record.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            self.missing_entry_ids += 1
            return True
        if not self.session_id:
            raise TranscriptReadError("Transcript entry appeared before a session header identity")
        identity = (self.session_id, entry_id)
        if identity in self.seen_entries:
            self.duplicate_entries += 1
            return False
        self.seen_entries.add(identity)
        return True

    def _record_usage(
        self,
        record: dict[str, Any],
        usage: Any,
        *,
        count_turn: bool = True,
        count_context: bool = True,
        optional: bool = False,
        attribute_model_epoch: bool = True,
    ) -> dict[str, Any]:
        if not isinstance(usage, dict):
            if not optional:
                self.invalid_usage_records += 1
            return empty_totals()
        delta = usage_totals(
            usage,
            count_turn=count_turn,
            count_context=count_context,
        )
        add_totals(self.totals, delta)
        if self._is_current(record):
            add_totals(self.current_totals, delta)
        if attribute_model_epoch:
            if self.model_epochs:
                add_totals(self.model_epochs[-1]["usage"], delta)
            if self.thinking_epochs:
                add_totals(self.thinking_epochs[-1]["usage"], delta)
        return delta

    def _model_epoch(self, record: dict[str, Any], provider: Any, model: Any, source: str) -> None:
        provider_value = provider if isinstance(provider, str) and provider else None
        model_value = model if isinstance(model, str) and model else None
        current = (provider_value, model_value)
        if self.current_model == current and self.model_epochs:
            return
        self.current_model = current
        self.model_epochs.append({
            "entry_id": record.get("id"),
            "timestamp": record.get("timestamp"),
            "provider": provider_value,
            "model": model_value,
            "source": source,
            "usage": empty_totals(),
        })

    def consume(self, record: dict[str, Any], _line_number: int) -> None:
        if not self._entry_is_new(record):
            return
        record_type = record.get("type")
        if record_type == "model_change":
            self._model_epoch(record, record.get("provider"), record.get("modelId"), "model_change")
            return
        if record_type == "thinking_level_change":
            thinking = record.get("thinkingLevel")
            if not isinstance(thinking, str):
                thinking = None
            if thinking != self.current_thinking or not self.thinking_epochs:
                self.current_thinking = thinking
                self.thinking_epochs.append({
                    "entry_id": record.get("id"),
                    "timestamp": record.get("timestamp"),
                    "thinking_level": thinking,
                    "source": "thinking_level_change",
                    "usage": empty_totals(),
                })
            return
        if record_type == "compaction":
            delta = self._record_usage(record, record.get("usage"), optional=True)
            tokens_before = record.get("tokensBefore")
            self.compactions.append({
                "entry_id": record.get("id"),
                "timestamp": record.get("timestamp"),
                "tokens_before": int(tokens_before) if isinstance(tokens_before, (int, float)) and not isinstance(tokens_before, bool) and tokens_before >= 0 else None,
                "estimated_after_tokens": None,
                "estimated_after_method": "next_assistant_context",
                "trigger_reason": None,
                "trigger_reason_source": "unavailable_in_pi_transcript",
                "from_hook": bool(record.get("fromHook")),
                "usage": rounded_totals(delta),
            })
            self.pending_compactions.append(len(self.compactions) - 1)
            return
        if record_type == "branch_summary":
            self.branch_summary_count += 1
            self._record_usage(record, record.get("usage"), optional=True)
            return
        if record_type != "message":
            return
        message = record.get("message")
        if not isinstance(message, dict):
            return
        role = message.get("role")
        if role == "assistant":
            self._model_epoch(
                record,
                message.get("provider"),
                message.get("responseModel") or message.get("model"),
                "assistant_message",
            )
            delta = self._record_usage(record, message.get("usage"))
            context = int(delta["input"]) + int(delta["cache_read"]) + int(delta["cache_write"])
            for index in self.pending_compactions:
                self.compactions[index]["estimated_after_tokens"] = context
            self.pending_compactions.clear()
            return
        if role == "toolResult" and isinstance(message.get("usage"), dict):
            # Only the explicit top-level Pi ToolResultMessage.usage is billable
            # root usage. Never inspect content/details for nested child totals.
            self.billable_tool_results += 1
            self._record_usage(
                record,
                message.get("usage"),
                count_turn=False,
                count_context=False,
                attribute_model_epoch=False,
            )

    def result(self, session_path: str, metrics: SnapshotMetrics) -> dict[str, Any]:
        identity_exact = (
            self.session_header_count == 1
            and bool(self.session_id)
            and self.missing_entry_ids == 0
            and self.duplicate_entries == 0
        )
        model_epochs = [
            {**epoch, "usage": rounded_totals(epoch["usage"])}
            for epoch in self.model_epochs
        ]
        thinking_epochs = [
            {**epoch, "usage": rounded_totals(epoch["usage"])}
            for epoch in self.thinking_epochs
        ]
        return {
            **rounded_totals(self.totals),
            "session_id": self.session_id,
            "session_file": Path(session_path).name,
            "identity": {
                "key": "session_header_id+entry_id",
                "exact": identity_exact,
                "missing_entry_ids": self.missing_entry_ids,
                "duplicate_entries_ignored": self.duplicate_entries,
                "response_id_role": "secondary_only",
            },
            "model_epochs": model_epochs,
            "thinking_epochs": thinking_epochs,
            "compaction_count": len(self.compactions),
            "compactions": self.compactions,
            "branch_summary_count": self.branch_summary_count,
            "billable_tool_result_count": self.billable_tool_results,
            "current_generation": rounded_totals(self.current_totals) if self.generation_start else None,
            "snapshot": {
                "bytes_scanned": metrics.bytes_scanned,
                "verification_bytes": metrics.verification_bytes,
                "elapsed_ms": metrics.elapsed_ms,
                "peak_record_bytes": metrics.peak_record_bytes,
                "complete_records": metrics.complete_records,
                "trailing_record_incomplete": metrics.trailing_record_incomplete,
                "captured_size": metrics.captured_size,
                "final_size": metrics.final_size,
                "append_growth_bytes": metrics.final_size - metrics.captured_size,
            },
            "completeness": {
                "exact_entry_identity": identity_exact,
                "generation_timestamp_valid": self.generation_timestamp_valid,
                "trailing_record_incomplete": metrics.trailing_record_incomplete,
                "invalid_usage_records": self.invalid_usage_records,
            },
        }


def analyze_root(
    session_path: str,
    generation_started_at: str | None,
    expected_identity_raw: str | None = None,
) -> dict[str, Any]:
    expected_identity: dict[str, str] | None = None
    if expected_identity_raw:
        try:
            parsed = json.loads(expected_identity_raw)
        except json.JSONDecodeError as error:
            raise TranscriptReadError("Projected root session identity is invalid JSON") from error
        if not isinstance(parsed, dict):
            raise TranscriptReadError("Projected root session identity must be an object")
        expected_identity = {
            key: value
            for key, value in parsed.items()
            if isinstance(key, str) and isinstance(value, str)
        }
    accumulator = RootAccumulator(generation_started_at)
    metrics = scan_jsonl_snapshot(
        session_path,
        accumulator.consume,
        required_mode=0o600,
        expected_identity=expected_identity,
    )
    return accumulator.result(session_path, metrics)


def latest_generation(trace_path: str | None) -> dict[str, Any]:
    if not trace_path:
        return {
            "generation": None,
            "started_at": None,
            "exact": False,
            "reason": "PI_TRACE_FILE is not set",
        }
    latest: tuple[str, str] | None = None

    try:
        lines, metrics = read_text_snapshot(trace_path, required_mode=0o600)
        if metrics.trailing_record_incomplete:
            return {
                "generation": None,
                "started_at": None,
                "exact": False,
                "reason": "generation trace has an incomplete trailing record",
            }
        for line in lines:
            match = GENERATION_PATTERN.match(line)
            if match:
                latest = (match.group(2), match.group(1))
    except TranscriptReadError as error:
        return {
            "generation": None,
            "started_at": None,
            "exact": False,
            "reason": f"generation trace unavailable: {error}",
        }
    if latest is None:
        return {
            "generation": None,
            "started_at": None,
            "exact": False,
            "reason": "TREE_GENERATION_START was not found",
        }
    if _timestamp(latest[1]) is None:
        return {
            "generation": None,
            "started_at": None,
            "exact": False,
            "reason": "TREE_GENERATION_START timestamp is invalid",
        }
    return {
        "generation": latest[0],
        "started_at": latest[1],
        "exact": True,
        "reason": None,
    }
