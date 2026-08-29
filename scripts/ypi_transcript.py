#!/usr/bin/env python3
"""Secure, append-safe readers for YPI/Pi JSONL transcript files.

The reader binds one exact pathname to one owned, singly-linked inode, captures
the byte length at open time, and parses only that immutable prefix. Appends
past the captured boundary are allowed. Truncation, pathname replacement, or
mutation inside the captured prefix fail closed.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024
READ_CHUNK_BYTES = 1024 * 1024


class TranscriptReadError(RuntimeError):
    """Raised when an exact-file transcript snapshot cannot be trusted."""


@dataclass(frozen=True)
class SnapshotMetrics:
    path: str
    bytes_scanned: int
    verification_bytes: int
    elapsed_ms: float
    peak_record_bytes: int
    complete_records: int
    trailing_record_incomplete: bool
    captured_size: int
    final_size: int
    device: int
    inode: int


@dataclass(frozen=True)
class DirectoryEntry:
    name: str
    size: int
    mtime_ns: int


SnapshotHook = Callable[[str, int, int], None]
RecordConsumer = Callable[[dict[str, Any], int], None]


def _uid() -> int | None:
    return os.getuid() if hasattr(os, "getuid") else None


def _same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _absolute_normalized_path(raw_path: str | os.PathLike[str]) -> Path:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise TranscriptReadError("Transcript path must be absolute")
    normalized = Path(os.path.normpath(os.fspath(candidate)))
    if normalized != candidate:
        raise TranscriptReadError("Transcript path must already be normalized")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise TranscriptReadError(f"Cannot resolve transcript path: {error}") from error
    if resolved != candidate:
        raise TranscriptReadError("Transcript path must not contain symlinks")
    return candidate


def _validate_owner(metadata: os.stat_result, label: str) -> None:
    current_uid = _uid()
    if current_uid is not None and metadata.st_uid != current_uid:
        raise TranscriptReadError(f"{label} must be owned by the current uid")


def _validate_file(
    metadata: os.stat_result,
    *,
    label: str,
    required_mode: int | None,
) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        raise TranscriptReadError(f"{label} must be a regular file")
    _validate_owner(metadata, label)
    if metadata.st_nlink != 1:
        raise TranscriptReadError(f"{label} must be singly linked")
    if os.name != "nt" and required_mode is not None:
        actual_mode = stat.S_IMODE(metadata.st_mode)
        if actual_mode != required_mode:
            raise TranscriptReadError(
                f"{label} must have mode {required_mode:04o}, found {actual_mode:04o}"
            )


def _pread_exact(descriptor: int, size: int, *, hash_only: bool = False) -> tuple[bytes, str]:
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    offset = 0
    while offset < size:
        requested = min(READ_CHUNK_BYTES, size - offset)
        chunk = os.pread(descriptor, requested, offset)
        if not chunk:
            raise TranscriptReadError("Transcript was truncated during snapshot read")
        digest.update(chunk)
        if not hash_only:
            chunks.append(chunk)
        offset += len(chunk)
    return (b"" if hash_only else b"".join(chunks), digest.hexdigest())


def scan_jsonl_snapshot(
    raw_path: str | os.PathLike[str],
    consumer: RecordConsumer,
    *,
    required_mode: int | None = 0o600,
    max_record_bytes: int = DEFAULT_MAX_RECORD_BYTES,
    expected_identity: dict[str, str] | None = None,
    test_hook: SnapshotHook | None = None,
) -> SnapshotMetrics:
    """Parse complete JSONL objects from one captured file prefix.

    The function does not retain parsed records. The consumer must retain only
    bounded derived state. A non-newline-terminated final record is ignored and
    reported through ``trailing_record_incomplete``.
    """

    if not isinstance(max_record_bytes, int) or max_record_bytes <= 0:
        raise TranscriptReadError("Maximum record size must be a positive integer")
    started = time.monotonic()
    candidate = _absolute_normalized_path(raw_path)
    parent = candidate.parent
    parent_before = os.lstat(parent)
    if not stat.S_ISDIR(parent_before.st_mode):
        raise TranscriptReadError("Transcript parent must be a directory")
    _validate_owner(parent_before, "Transcript parent")

    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_fd = os.open(parent, directory_flags)
    descriptor = -1
    try:
        parent_open = os.fstat(directory_fd)
        if not stat.S_ISDIR(parent_open.st_mode) or not _same_inode(parent_before, parent_open):
            raise TranscriptReadError("Transcript parent identity changed during validation")

        descriptor = os.open(
            candidate.name,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_fd,
        )
        opened = os.fstat(descriptor)
        named = os.stat(candidate.name, dir_fd=directory_fd, follow_symlinks=False)
        _validate_file(opened, label="Transcript", required_mode=required_mode)
        _validate_file(named, label="Transcript", required_mode=required_mode)
        if not _same_inode(opened, named):
            raise TranscriptReadError("Transcript identity changed during validation")
        if expected_identity is not None and (
            expected_identity.get("device") != str(opened.st_dev)
            or expected_identity.get("inode") != str(opened.st_ino)
            or expected_identity.get("kind") != "file"
            or expected_identity.get("links") != "1"
        ):
            raise TranscriptReadError(
                "Transcript does not match the projected active-file identity"
            )
        captured_size = opened.st_size
        if captured_size < 0:
            raise TranscriptReadError("Transcript size is invalid")
        if test_hook is not None:
            test_hook("after_open", descriptor, captured_size)

        digest = hashlib.sha256()
        buffer = b""
        offset = 0
        line_number = 0
        peak_record_bytes = 0
        complete_records = 0
        while offset < captured_size:
            requested = min(READ_CHUNK_BYTES, captured_size - offset)
            chunk = os.pread(descriptor, requested, offset)
            if not chunk:
                raise TranscriptReadError("Transcript was truncated during snapshot read")
            offset += len(chunk)
            digest.update(chunk)
            buffer += chunk
            while True:
                newline = buffer.find(b"\n")
                if newline < 0:
                    if len(buffer) > max_record_bytes:
                        raise TranscriptReadError(
                            f"Transcript record exceeds {max_record_bytes} bytes"
                        )
                    break
                raw_record = buffer[:newline]
                buffer = buffer[newline + 1 :]
                line_number += 1
                peak_record_bytes = max(peak_record_bytes, len(raw_record))
                if len(raw_record) > max_record_bytes:
                    raise TranscriptReadError(
                        f"Transcript record exceeds {max_record_bytes} bytes at line {line_number}"
                    )
                try:
                    decoded = raw_record.decode("utf-8", errors="strict")
                except UnicodeDecodeError as error:
                    raise TranscriptReadError(
                        f"Invalid transcript UTF-8 at line {line_number}: {error}"
                    ) from error
                try:
                    value = json.loads(decoded)
                except json.JSONDecodeError as error:
                    raise TranscriptReadError(
                        f"Invalid transcript JSONL at line {line_number}: {error}"
                    ) from error
                if not isinstance(value, dict):
                    raise TranscriptReadError(
                        f"Invalid non-object transcript event at line {line_number}"
                    )
                consumer(value, line_number)
                complete_records += 1

        trailing_incomplete = bool(buffer)
        peak_record_bytes = max(peak_record_bytes, len(buffer))
        if len(buffer) > max_record_bytes:
            raise TranscriptReadError(f"Transcript record exceeds {max_record_bytes} bytes")
        if test_hook is not None:
            test_hook("before_verify", descriptor, captured_size)

        after_read = os.fstat(descriptor)
        if after_read.st_size < captured_size:
            raise TranscriptReadError("Transcript was truncated below the captured boundary")
        _, verification_digest = _pread_exact(descriptor, captured_size, hash_only=True)
        if verification_digest != digest.hexdigest():
            raise TranscriptReadError("Transcript captured prefix changed during analysis")
        final_open = os.fstat(descriptor)
        if final_open.st_size < captured_size:
            raise TranscriptReadError("Transcript was truncated below the captured boundary")
        final_named = os.stat(candidate.name, dir_fd=directory_fd, follow_symlinks=False)
        parent_after = os.fstat(directory_fd)
        if not _same_inode(opened, final_open) or not _same_inode(opened, final_named):
            raise TranscriptReadError("Transcript pathname was replaced during analysis")
        if not _same_inode(parent_before, parent_after):
            raise TranscriptReadError("Transcript parent identity changed during analysis")
        _validate_file(final_open, label="Transcript", required_mode=required_mode)

        return SnapshotMetrics(
            path=os.fspath(candidate),
            bytes_scanned=captured_size,
            verification_bytes=captured_size,
            elapsed_ms=round((time.monotonic() - started) * 1000, 3),
            peak_record_bytes=peak_record_bytes,
            complete_records=complete_records,
            trailing_record_incomplete=trailing_incomplete,
            captured_size=captured_size,
            final_size=final_open.st_size,
            device=opened.st_dev,
            inode=opened.st_ino,
        )
    except OSError as error:
        raise TranscriptReadError(f"Cannot read exact transcript snapshot: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_fd)


def read_jsonl_snapshot(
    raw_path: str | os.PathLike[str],
    **kwargs: Any,
) -> tuple[list[dict[str, Any]], SnapshotMetrics]:
    """Convenience wrapper for presentation tools that need materialized events."""

    records: list[dict[str, Any]] = []
    metrics = scan_jsonl_snapshot(
        raw_path,
        lambda record, _line: records.append(record),
        **kwargs,
    )
    return records, metrics


def read_text_snapshot(
    raw_path: str | os.PathLike[str],
    *,
    required_mode: int | None = 0o600,
    maximum_bytes: int = 16 * 1024 * 1024,
) -> tuple[list[str], SnapshotMetrics]:
    """Read complete UTF-8 lines from an append-safe exact-file prefix."""

    started = time.monotonic()
    candidate = _absolute_normalized_path(raw_path)
    parent = candidate.parent
    parent_before = os.lstat(parent)
    if not stat.S_ISDIR(parent_before.st_mode):
        raise TranscriptReadError("Text snapshot parent must be a directory")
    _validate_owner(parent_before, "Text snapshot parent")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_fd = os.open(parent, directory_flags)
    descriptor = -1
    try:
        parent_open = os.fstat(directory_fd)
        if not _same_inode(parent_before, parent_open):
            raise TranscriptReadError("Text snapshot parent identity changed")
        descriptor = os.open(
            candidate.name,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_fd,
        )
        opened = os.fstat(descriptor)
        named = os.stat(candidate.name, dir_fd=directory_fd, follow_symlinks=False)
        _validate_file(opened, label="Text snapshot", required_mode=required_mode)
        if not _same_inode(opened, named):
            raise TranscriptReadError("Text snapshot identity changed during validation")
        boundary = opened.st_size
        if boundary > maximum_bytes:
            raise TranscriptReadError(f"Text snapshot exceeds {maximum_bytes} bytes")
        raw, first_digest = _pread_exact(descriptor, boundary)
        after_read = os.fstat(descriptor)
        if after_read.st_size < boundary:
            raise TranscriptReadError("Text snapshot was truncated below its captured boundary")
        _, verification_digest = _pread_exact(descriptor, boundary, hash_only=True)
        if verification_digest != first_digest:
            raise TranscriptReadError("Text snapshot captured prefix changed during analysis")
        final_named = os.stat(candidate.name, dir_fd=directory_fd, follow_symlinks=False)
        final_open = os.fstat(descriptor)
        if not _same_inode(opened, final_named) or final_open.st_size < boundary:
            raise TranscriptReadError("Text snapshot pathname changed during analysis")
        if raw.endswith(b"\n"):
            complete = raw
        else:
            final_newline = raw.rfind(b"\n")
            complete = raw[: final_newline + 1] if final_newline >= 0 else b""
        trailing = bool(raw and not raw.endswith(b"\n"))
        try:
            decoded = complete.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise TranscriptReadError(f"Invalid text snapshot UTF-8: {error}") from error
        lines = decoded.splitlines()
        peak = max((len(line.encode("utf-8")) for line in lines), default=0)
        return lines, SnapshotMetrics(
            path=os.fspath(candidate),
            bytes_scanned=boundary,
            verification_bytes=boundary,
            elapsed_ms=round((time.monotonic() - started) * 1000, 3),
            peak_record_bytes=peak,
            complete_records=len(lines),
            trailing_record_incomplete=trailing,
            captured_size=boundary,
            final_size=final_open.st_size,
            device=opened.st_dev,
            inode=opened.st_ino,
        )
    except OSError as error:
        raise TranscriptReadError(f"Cannot read exact text snapshot: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_fd)


class PrivateSessionDirectory:
    """Validated 0700 owner for direct-child ``rlm_sessions`` operations."""

    def __init__(self, raw_path: str | os.PathLike[str]):
        self.path = _absolute_normalized_path(raw_path)
        metadata = os.lstat(self.path)
        if not stat.S_ISDIR(metadata.st_mode):
            raise TranscriptReadError("Session directory must be a directory")
        _validate_owner(metadata, "Session directory")
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) != 0o700:
            raise TranscriptReadError("Session directory must have mode 0700")
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        self.descriptor = os.open(self.path, flags)
        opened = os.fstat(self.descriptor)
        if not _same_inode(metadata, opened):
            self.close()
            raise TranscriptReadError("Session directory identity changed during validation")

    def close(self) -> None:
        descriptor = getattr(self, "descriptor", -1)
        if descriptor >= 0:
            os.close(descriptor)
            self.descriptor = -1

    def __enter__(self) -> "PrivateSessionDirectory":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    @staticmethod
    def checked_name(value: str) -> str:
        if (
            not value
            or value != os.path.basename(value)
            or os.sep in value
            or (os.altsep is not None and os.altsep in value)
            or not value.endswith(".jsonl")
        ):
            raise TranscriptReadError(
                "Session reads accept only a direct-child .jsonl filename"
            )
        return value

    def entries(self, *, prefix: str = "") -> list[DirectoryEntry]:
        entries: list[DirectoryEntry] = []
        with os.scandir(self.descriptor) as iterator:
            for entry in iterator:
                if not entry.name.endswith(".jsonl") or (prefix and not entry.name.startswith(prefix)):
                    continue
                metadata = entry.stat(follow_symlinks=False)
                _validate_file(metadata, label="Session entry", required_mode=0o600)
                entries.append(
                    DirectoryEntry(entry.name, metadata.st_size, metadata.st_mtime_ns)
                )
        return sorted(entries, key=lambda item: item.name)

    def read(self, name: str) -> tuple[list[dict[str, Any]], SnapshotMetrics]:
        safe_name = self.checked_name(name)
        return read_jsonl_snapshot(self.path / safe_name, required_mode=0o600)
