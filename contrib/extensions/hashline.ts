/**
 * Hashline Edit Extension for Pi
 *
 * Adds line-addressed editing using content hashes for integrity.
 * When enabled, the read tool output includes `LINE:HASH|` prefixes,
 * and a custom `hashline_edit` tool accepts edits referencing those hashes.
 *
 * Ported from oh-my-pi (can1357) — https://github.com/can1357/oh-my-pi
 *
 * Usage:
 *   pi -e ./extensions/hashline.ts
 *   # or place in ~/.pi/agent/extensions/hashline.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { readFile, writeFile, access, mkdir } from "fs/promises";
import { constants } from "fs";
import { resolve, dirname } from "path";
import { createHash } from "crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Hash computation
// ═══════════════════════════════════════════════════════════════════════════

const HASH_LEN = 2;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN; // 256

// Pre-compute dictionary of all possible hash values
const DICT = Array.from({ length: HASH_MOD }, (_, i) =>
  i.toString(RADIX).padStart(HASH_LEN, "0")
);

/**
 * Compute a short hex hash of a single line's content.
 * Strips all whitespace before hashing — so indentation changes don't
 * invalidate the hash. Uses a fast non-crypto hash (FNV-1a 32-bit)
 * truncated to 2 hex chars.
 */
function computeLineHash(_idx: number, line: string): string {
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }
  // Normalize: strip all whitespace
  line = line.replace(/\s+/g, "");

  // FNV-1a 32-bit hash (fast, no native deps)
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return DICT[hash % HASH_MOD];
}

/**
 * Format file content with hashline prefixes.
 * Each line becomes `LINENUM:HASH|CONTENT` (1-indexed).
 */
function formatHashLines(content: string, startLine = 1): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = startLine + i;
      const hash = computeLineHash(num, line);
      return `${num}:${hash}|${line}`;
    })
    .join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Line reference parsing
// ═══════════════════════════════════════════════════════════════════════════

interface LineRef {
  line: number;
  hash: string;
}

/**
 * Parse a line reference string like "5:ab" or "5:ab|some content".
 * Models often copy the full display format from read output.
 */
function parseLineRef(ref: string): LineRef {
  // Strip display-format suffix: "5:ab|some content" → "5:ab"
  const cleaned = ref
    .replace(/\|.*$/, "")
    .replace(/ {2}.*$/, "")
    .trim();
  const normalized = cleaned.replace(/\s*:\s*/, ":");
  const match = normalized.match(/^(\d+):([0-9a-fA-F]{1,16})$/);
  if (!match) {
    throw new Error(
      `Invalid line reference "${ref}". Expected format "LINE:HASH" (e.g. "5:ab").`
    );
  }
  const line = parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }
  return { line, hash: match[2].toLowerCase() };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash mismatch error
// ═══════════════════════════════════════════════════════════════════════════

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

const MISMATCH_CONTEXT = 2;

function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: string[]
): string {
  const mismatchSet = new Map<number, HashMismatch>();
  for (const m of mismatches) {
    mismatchSet.set(m.line, m);
  }

  // Collect line ranges to display (mismatch lines + context)
  const displayLines = new Set<number>();
  for (const m of mismatches) {
    const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
    const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
    for (let i = lo; i <= hi; i++) {
      displayLines.add(i);
    }
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  const lines: string[] = [];

  lines.push(
    `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE:HASH references shown below (>>> marks changed lines).`
  );
  lines.push("");

  let prevLine = -1;
  for (const lineNum of sorted) {
    if (prevLine !== -1 && lineNum > prevLine + 1) {
      lines.push("    ...");
    }
    prevLine = lineNum;

    const content = fileLines[lineNum - 1];
    const hash = computeLineHash(lineNum, content);
    const prefix = `${lineNum}:${hash}`;

    if (mismatchSet.has(lineNum)) {
      lines.push(`>>> ${prefix}|${content}`);
    } else {
      lines.push(`    ${prefix}|${content}`);
    }
  }

  // Quick-fix remap section
  const remapEntries: string[] = [];
  for (const m of mismatches) {
    const actual = computeLineHash(m.line, fileLines[m.line - 1]);
    remapEntries.push(`\t${m.line}:${m.expected} → ${m.line}:${actual}`);
  }
  if (remapEntries.length > 0) {
    lines.push("");
    lines.push("Quick fix — replace stale refs:");
    lines.push(...remapEntries);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Edit types and parsing
// ═══════════════════════════════════════════════════════════════════════════

interface SetLineEdit {
  set_line: { anchor: string; new_text: string };
}

interface ReplaceLinesEdit {
  replace_lines: {
    start_anchor: string;
    end_anchor: string;
    new_text: string;
  };
}

interface InsertAfterEdit {
  insert_after: { anchor: string; text: string };
}

type HashlineEdit = SetLineEdit | ReplaceLinesEdit | InsertAfterEdit;

type ParsedSpec =
  | { kind: "single"; ref: LineRef }
  | { kind: "range"; start: LineRef; end: LineRef }
  | { kind: "insertAfter"; after: LineRef };

function parseHashlineEdit(edit: HashlineEdit): {
  spec: ParsedSpec;
  dst: string;
} {
  if ("set_line" in edit) {
    return {
      spec: { kind: "single", ref: parseLineRef(edit.set_line.anchor) },
      dst: edit.set_line.new_text,
    };
  }
  if ("replace_lines" in edit) {
    const start = parseLineRef(edit.replace_lines.start_anchor);
    const end = parseLineRef(edit.replace_lines.end_anchor);
    if (start.line === end.line) {
      return { spec: { kind: "single", ref: start }, dst: edit.replace_lines.new_text };
    }
    return {
      spec: { kind: "range", start, end },
      dst: edit.replace_lines.new_text,
    };
  }
  // insert_after
  return {
    spec: {
      kind: "insertAfter",
      after: parseLineRef(edit.insert_after.anchor),
    },
    dst: edit.insert_after.text ?? "",
  };
}

/** Split dst into lines; empty string means delete (no lines). */
function splitDstLines(dst: string): string[] {
  return dst === "" ? [] : dst.split("\n");
}

/** Pattern matching hashline display format: `LINE:HASH|CONTENT` */
const HASHLINE_PREFIX_RE = /^\d+:[0-9a-fA-F]{1,16}\|/;

/** Pattern matching a unified-diff `+` prefix (but not `++`) */
const DIFF_PLUS_RE = /^\+(?!\+)/;

/**
 * Strip hashline display prefixes and diff `+` markers from replacement lines.
 * Models frequently copy the `LINE:HASH|` prefix from read output.
 */
function stripNewLinePrefixes(lines: string[]): string[] {
  let hashPrefixCount = 0;
  let diffPlusCount = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
    if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
  }
  if (nonEmpty === 0) return lines;

  const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
  const stripPlus =
    !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;

  if (!stripHash && !stripPlus) return lines;

  return lines.map((l) => {
    if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
    if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
    return l;
  });
}

function equalsIgnoringWhitespace(a: string, b: string): boolean {
  if (a === b) return true;
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function stripAllWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

function stripTrailingContinuationTokens(s: string): string {
  // Heuristic: models often merge a continuation line into the prior line
  // while also changing the trailing operator (e.g. `&&` → `||`).
  // Strip common trailing continuation tokens so we can still detect merges.
  return s.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

function stripMergeOperatorChars(s: string): string {
  // Used for merge detection when the model changes a logical operator like
  // `||` → `??` while also merging adjacent lines.
  return s.replace(/[|&?]/g, "");
}

const CONFUSABLE_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;

function normalizeConfusableHyphens(s: string): string {
  return s.replace(CONFUSABLE_HYPHENS_RE, "-");
}

function normalizeConfusableHyphensInLines(lines: string[]): string[] {
  return lines.map((l) => normalizeConfusableHyphens(l));
}

/**
 * Undo pure formatting rewrites where the model reflows a single logical line
 * into multiple lines (or similar), but the token stream is identical.
 */
function restoreOldWrappedLines(
  oldLines: string[],
  newLines: string[]
): string[] {
  if (oldLines.length === 0 || newLines.length < 2) return newLines;

  const canonToOld = new Map<string, { line: string; count: number }>();
  for (const line of oldLines) {
    const canon = stripAllWhitespace(line);
    const bucket = canonToOld.get(canon);
    if (bucket) bucket.count++;
    else canonToOld.set(canon, { line, count: 1 });
  }

  const candidates: {
    start: number;
    len: number;
    replacement: string;
    canon: string;
  }[] = [];
  for (let start = 0; start < newLines.length; start++) {
    for (let len = 2; len <= 10 && start + len <= newLines.length; len++) {
      const canonSpan = stripAllWhitespace(
        newLines.slice(start, start + len).join("")
      );
      const old = canonToOld.get(canonSpan);
      if (old && old.count === 1 && canonSpan.length >= 6) {
        candidates.push({ start, len, replacement: old.line, canon: canonSpan });
      }
    }
  }
  if (candidates.length === 0) return newLines;

  // Keep only spans whose canonical match is unique in the new output.
  const canonCounts = new Map<string, number>();
  for (const c of candidates) {
    canonCounts.set(c.canon, (canonCounts.get(c.canon) ?? 0) + 1);
  }
  const uniqueCandidates = candidates.filter(
    (c) => (canonCounts.get(c.canon) ?? 0) === 1
  );
  if (uniqueCandidates.length === 0) return newLines;

  // Apply replacements back-to-front so indices remain stable.
  uniqueCandidates.sort((a, b) => b.start - a.start);
  const out = [...newLines];
  for (const c of uniqueCandidates) {
    out.splice(c.start, c.len, c.replacement);
  }
  return out;
}

function stripInsertAnchorEchoAfter(
  anchorLine: string,
  dstLines: string[]
): string[] {
  if (dstLines.length <= 1) return dstLines;
  if (equalsIgnoringWhitespace(dstLines[0], anchorLine)) {
    return dstLines.slice(1);
  }
  return dstLines;
}

function stripRangeBoundaryEcho(
  fileLines: string[],
  startLine: number,
  endLine: number,
  dstLines: string[]
): string[] {
  const count = endLine - startLine + 1;
  if (dstLines.length <= 1 || dstLines.length <= count) return dstLines;

  let out = dstLines;
  const beforeIdx = startLine - 2;
  if (
    beforeIdx >= 0 &&
    equalsIgnoringWhitespace(out[0], fileLines[beforeIdx])
  ) {
    out = out.slice(1);
  }

  const afterIdx = endLine;
  if (
    afterIdx < fileLines.length &&
    out.length > 0 &&
    equalsIgnoringWhitespace(out[out.length - 1], fileLines[afterIdx])
  ) {
    out = out.slice(0, -1);
  }

  return out;
}

function leadingWhitespace(s: string): string {
  const match = s.match(/^\s*/);
  return match ? match[0] : "";
}

function restoreLeadingIndent(templateLine: string, line: string): string {
  if (line.length === 0) return line;
  const templateIndent = leadingWhitespace(templateLine);
  if (templateIndent.length === 0) return line;
  const indent = leadingWhitespace(line);
  if (indent.length > 0) return line;
  return templateIndent + line;
}

function restoreIndentForPairedReplacement(
  oldLines: string[],
  newLines: string[]
): string[] {
  if (oldLines.length !== newLines.length) return newLines;
  let changed = false;
  const out = new Array<string>(newLines.length);
  for (let i = 0; i < newLines.length; i++) {
    const restored = restoreLeadingIndent(oldLines[i], newLines[i]);
    out[i] = restored;
    if (restored !== newLines[i]) changed = true;
  }
  return changed ? out : newLines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Apply hashline edits
// ═══════════════════════════════════════════════════════════════════════════

interface ApplyResult {
  content: string;
  firstChangedLine: number | undefined;
  warnings: string[];
  noopEdits: Array<{ editIndex: number; loc: string; currentContent: string }>;
}

function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[]
): ApplyResult {
  if (edits.length === 0) {
    return { content, firstChangedLine: undefined, warnings: [], noopEdits: [] };
  }

  const fileLines = content.split("\n");
  const originalFileLines = [...fileLines];
  let firstChangedLine: number | undefined;
  const noopEdits: Array<{
    editIndex: number;
    loc: string;
    currentContent: string;
  }> = [];

  // Parse all edits
  const parsed = edits.map((edit) => {
    const parsedEdit = parseHashlineEdit(edit);
    return {
      spec: parsedEdit.spec,
      dstLines: stripNewLinePrefixes(splitDstLines(parsedEdit.dst)),
    };
  });

  function collectExplicitlyTouchedLines(): Set<number> {
    const touched = new Set<number>();
    for (const { spec } of parsed) {
      switch (spec.kind) {
        case "single":
          touched.add(spec.ref.line);
          break;
        case "range":
          for (let ln = spec.start.line; ln <= spec.end.line; ln++)
            touched.add(ln);
          break;
        case "insertAfter":
          touched.add(spec.after.line);
          break;
      }
    }
    return touched;
  }

  let explicitlyTouchedLines = collectExplicitlyTouchedLines();

  // Build unique-hash lookup for relocation
  const uniqueLineByHash = new Map<string, number>();
  const seenDuplicateHashes = new Set<string>();
  for (let i = 0; i < fileLines.length; i++) {
    const lineNo = i + 1;
    const hash = computeLineHash(lineNo, fileLines[i]);
    if (seenDuplicateHashes.has(hash)) continue;
    if (uniqueLineByHash.has(hash)) {
      uniqueLineByHash.delete(hash);
      seenDuplicateHashes.add(hash);
      continue;
    }
    uniqueLineByHash.set(hash, lineNo);
  }

  // Pre-validate: collect all hash mismatches before mutating
  const mismatches: HashMismatch[] = [];

  function validateOrRelocateRef(ref: LineRef): { ok: true; relocated: boolean } | { ok: false } {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(
        `Line ${ref.line} does not exist (file has ${fileLines.length} lines)`
      );
    }
    const expected = ref.hash.toLowerCase();
    const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
    if (actualHash === expected) {
      return { ok: true, relocated: false };
    }

    // Try relocation: if this hash is unique in the file, relocate
    const relocated = uniqueLineByHash.get(expected);
    if (relocated !== undefined) {
      ref.line = relocated;
      return { ok: true, relocated: true };
    }

    mismatches.push({
      line: ref.line,
      expected: ref.hash,
      actual: actualHash,
    });
    return { ok: false };
  }

  function buildMismatch(ref: LineRef, line = ref.line): HashMismatch {
    return {
      line,
      expected: ref.hash,
      actual: computeLineHash(line, fileLines[line - 1]),
    };
  }

  for (const { spec, dstLines } of parsed) {
    switch (spec.kind) {
      case "single":
        validateOrRelocateRef(spec.ref);
        break;
      case "insertAfter":
        if (dstLines.length === 0) {
          throw new Error(
            'Insert-after edit requires non-empty text'
          );
        }
        validateOrRelocateRef(spec.after);
        break;
      case "range": {
        if (spec.start.line > spec.end.line) {
          throw new Error(
            `Range start line ${spec.start.line} must be <= end line ${spec.end.line}`
          );
        }
        const originalStart = spec.start.line;
        const originalEnd = spec.end.line;
        const originalCount = originalEnd - originalStart + 1;

        const startStatus = validateOrRelocateRef(spec.start);
        const endStatus = validateOrRelocateRef(spec.end);
        if (!startStatus.ok || !endStatus.ok) break;

        const relocatedCount = spec.end.line - spec.start.line + 1;
        const changedByRelocation = startStatus.relocated || endStatus.relocated;
        const invalidRange = spec.start.line > spec.end.line;
        const scopeChanged = relocatedCount !== originalCount;

        if (changedByRelocation && (invalidRange || scopeChanged)) {
          spec.start.line = originalStart;
          spec.end.line = originalEnd;
          mismatches.push(
            buildMismatch(spec.start, originalStart),
            buildMismatch(spec.end, originalEnd)
          );
        }
        break;
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(formatMismatchError(mismatches, fileLines));
  }

  // Hash relocation may have rewritten reference line numbers.
  // Recompute touched lines so merge heuristics don't treat now-targeted
  // adjacent lines as safe merge candidates.
  explicitlyTouchedLines = collectExplicitlyTouchedLines();

  // Deduplicate identical edits
  const seenEditKeys = new Set<string>();
  const dedupIndices = new Set<number>();
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    let lineKey: string;
    switch (p.spec.kind) {
      case "single":
        lineKey = `s:${p.spec.ref.line}`;
        break;
      case "range":
        lineKey = `r:${p.spec.start.line}:${p.spec.end.line}`;
        break;
      case "insertAfter":
        lineKey = `i:${p.spec.after.line}`;
        break;
    }
    const dstKey = `${lineKey}|${p.dstLines.join("\n")}`;
    if (seenEditKeys.has(dstKey)) {
      dedupIndices.add(i);
    } else {
      seenEditKeys.add(dstKey);
    }
  }
  if (dedupIndices.size > 0) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (dedupIndices.has(i)) parsed.splice(i, 1);
    }
  }

  // Sort edits bottom-up (highest line first)
  const annotated = parsed.map((p, idx) => {
    let sortLine: number;
    let precedence: number;
    switch (p.spec.kind) {
      case "single":
        sortLine = p.spec.ref.line;
        precedence = 0;
        break;
      case "range":
        sortLine = p.spec.end.line;
        precedence = 0;
        break;
      case "insertAfter":
        sortLine = p.spec.after.line;
        precedence = 1;
        break;
    }
    return { ...p, idx, sortLine, precedence };
  });

  annotated.sort(
    (a, b) =>
      b.sortLine - a.sortLine ||
      a.precedence - b.precedence ||
      a.idx - b.idx
  );

  function trackFirstChanged(line: number): void {
    if (firstChangedLine === undefined || line < firstChangedLine) {
      firstChangedLine = line;
    }
  }

  // ─── Merge heuristic (ported from oh-my-pi) ──────────────────────────
  // Detects when a model merges adjacent lines into a single-line edit.
  function maybeExpandSingleLineMerge(
    line: number,
    dst: string[]
  ): { startLine: number; deleteCount: number; newLines: string[] } | null {
    if (dst.length !== 1) return null;
    if (line < 1 || line > fileLines.length) return null;

    const newLine = dst[0];
    const newCanon = stripAllWhitespace(newLine);
    const newCanonForMergeOps = stripMergeOperatorChars(newCanon);
    if (newCanon.length === 0) return null;

    const orig = fileLines[line - 1];
    const origCanon = stripAllWhitespace(orig);
    const origCanonForMatch = stripTrailingContinuationTokens(origCanon);
    const origCanonForMergeOps = stripMergeOperatorChars(origCanon);
    const origLooksLikeContinuation =
      origCanonForMatch.length < origCanon.length;
    if (origCanon.length === 0) return null;
    const nextIdx = line;
    const prevIdx = line - 2;
    // Case A: dst absorbed the next continuation line.
    if (
      origLooksLikeContinuation &&
      nextIdx < fileLines.length &&
      !explicitlyTouchedLines.has(line + 1)
    ) {
      const next = fileLines[nextIdx];
      const nextCanon = stripAllWhitespace(next);
      const a = newCanon.indexOf(origCanonForMatch);
      const b = newCanon.indexOf(nextCanon);
      if (
        a !== -1 &&
        b !== -1 &&
        a < b &&
        newCanon.length <= origCanon.length + nextCanon.length + 32
      ) {
        return { startLine: line, deleteCount: 2, newLines: [newLine] };
      }
    }
    // Case B: dst absorbed the previous declaration/continuation line.
    if (prevIdx >= 0 && !explicitlyTouchedLines.has(line - 1)) {
      const prev = fileLines[prevIdx];
      const prevCanon = stripAllWhitespace(prev);
      const prevCanonForMatch = stripTrailingContinuationTokens(prevCanon);
      const prevLooksLikeContinuation =
        prevCanonForMatch.length < prevCanon.length;
      if (!prevLooksLikeContinuation) return null;
      const a = newCanonForMergeOps.indexOf(
        stripMergeOperatorChars(prevCanonForMatch)
      );
      const b = newCanonForMergeOps.indexOf(origCanonForMergeOps);
      if (
        a !== -1 &&
        b !== -1 &&
        a < b &&
        newCanon.length <= prevCanon.length + origCanon.length + 32
      ) {
        return { startLine: line - 1, deleteCount: 2, newLines: [newLine] };
      }
    }

    return null;
  }

  // Apply edits bottom-up
  for (const { spec, dstLines, idx } of annotated) {
    switch (spec.kind) {
      case "single": {
        // Try merge heuristic first
        const merged = maybeExpandSingleLineMerge(spec.ref.line, dstLines);
        if (merged) {
          const origLines = originalFileLines.slice(
            merged.startLine - 1,
            merged.startLine - 1 + merged.deleteCount
          );
          let nextLines = merged.newLines;
          nextLines = restoreIndentForPairedReplacement(
            [origLines[0] ?? ""],
            nextLines
          );
          if (
            origLines.join("\n") === nextLines.join("\n") &&
            origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))
          ) {
            nextLines = normalizeConfusableHyphensInLines(nextLines);
          }
          if (origLines.join("\n") === nextLines.join("\n")) {
            noopEdits.push({
              editIndex: idx,
              loc: `${spec.ref.line}:${spec.ref.hash}`,
              currentContent: origLines.join("\n"),
            });
            break;
          }
          fileLines.splice(
            merged.startLine - 1,
            merged.deleteCount,
            ...nextLines
          );
          trackFirstChanged(merged.startLine);
          break;
        }

        const origLines = originalFileLines.slice(
          spec.ref.line - 1,
          spec.ref.line
        );
        let stripped = stripRangeBoundaryEcho(
          originalFileLines,
          spec.ref.line,
          spec.ref.line,
          dstLines
        );
        stripped = restoreOldWrappedLines(origLines, stripped);
        let newLines = restoreIndentForPairedReplacement(origLines, stripped);
        if (
          origLines.join("\n") === newLines.join("\n") &&
          origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))
        ) {
          newLines = normalizeConfusableHyphensInLines(newLines);
        }
        if (origLines.join("\n") === newLines.join("\n")) {
          noopEdits.push({
            editIndex: idx,
            loc: `${spec.ref.line}:${spec.ref.hash}`,
            currentContent: origLines.join("\n"),
          });
          break;
        }
        fileLines.splice(spec.ref.line - 1, 1, ...newLines);
        trackFirstChanged(spec.ref.line);
        break;
      }
      case "range": {
        const count = spec.end.line - spec.start.line + 1;
        const origLines = originalFileLines.slice(
          spec.start.line - 1,
          spec.start.line - 1 + count
        );
        let stripped = stripRangeBoundaryEcho(
          originalFileLines,
          spec.start.line,
          spec.end.line,
          dstLines
        );
        stripped = restoreOldWrappedLines(origLines, stripped);
        let newLines = restoreIndentForPairedReplacement(origLines, stripped);
        if (
          origLines.join("\n") === newLines.join("\n") &&
          origLines.some((l) => CONFUSABLE_HYPHENS_RE.test(l))
        ) {
          newLines = normalizeConfusableHyphensInLines(newLines);
        }
        if (origLines.join("\n") === newLines.join("\n")) {
          noopEdits.push({
            editIndex: idx,
            loc: `${spec.start.line}:${spec.start.hash}`,
            currentContent: origLines.join("\n"),
          });
          break;
        }
        fileLines.splice(spec.start.line - 1, count, ...newLines);
        trackFirstChanged(spec.start.line);
        break;
      }
      case "insertAfter": {
        const anchorLine = originalFileLines[spec.after.line - 1];
        const inserted = stripInsertAnchorEchoAfter(anchorLine, dstLines);
        if (inserted.length === 0) {
          noopEdits.push({
            editIndex: idx,
            loc: `${spec.after.line}:${spec.after.hash}`,
            currentContent: originalFileLines[spec.after.line - 1],
          });
          break;
        }
        fileLines.splice(spec.after.line, 0, ...inserted);
        trackFirstChanged(spec.after.line + 1);
        break;
      }
    }
  }

  const warnings: string[] = [];
  let diffLineCount = Math.abs(fileLines.length - originalFileLines.length);
  for (
    let i = 0;
    i < Math.min(fileLines.length, originalFileLines.length);
    i++
  ) {
    if (fileLines[i] !== originalFileLines[i]) diffLineCount++;
  }
  if (diffLineCount > edits.length * 4) {
    warnings.push(
      `Edit changed ${diffLineCount} lines across ${edits.length} operations — verify no unintended reformatting.`
    );
  }

  return {
    content: fileLines.join("\n"),
    firstChangedLine,
    warnings,
    noopEdits,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

const hashlineSingleSchema = Type.Object({
  set_line: Type.Object({
    anchor: Type.String({ description: 'Line reference "LINE:HASH"' }),
    new_text: Type.String({
      description: 'Replacement content (\\n-separated) — "" for delete',
    }),
  }),
});

const hashlineRangeSchema = Type.Object({
  replace_lines: Type.Object({
    start_anchor: Type.String({ description: 'Start line ref "LINE:HASH"' }),
    end_anchor: Type.String({ description: 'End line ref "LINE:HASH"' }),
    new_text: Type.String({
      description: 'Replacement content (\\n-separated) — "" for delete',
    }),
  }),
});

const hashlineInsertAfterSchema = Type.Object({
  insert_after: Type.Object({
    anchor: Type.String({
      description: 'Insert after this line "LINE:HASH"',
    }),
    text: Type.String({
      description: "Content to insert (\\n-separated); must be non-empty",
    }),
  }),
});

const hashlineEditItemSchema = Type.Union([
  hashlineSingleSchema,
  hashlineRangeSchema,
  hashlineInsertAfterSchema,
]);

const editToolSchema = Type.Object({
  path: Type.String({ description: "File path (relative or absolute)" }),
  edits: Type.Array(hashlineEditItemSchema, {
    description: "Array of edit operations",
  }),
});

const TOOL_DESCRIPTION = `Line-addressed edits using hash-verified line references. Read a file first, then edit by referencing LINE:HASH pairs from the read output.

**Edit variants:**
- \`{ set_line: { anchor: "LINE:HASH", new_text: "..." } }\` — replace a single line
- \`{ replace_lines: { start_anchor: "LINE:HASH", end_anchor: "LINE:HASH", new_text: "..." } }\` — replace a range
- \`{ insert_after: { anchor: "LINE:HASH", text: "..." } }\` — insert after a line

**Rules:**
- Copy LINE:HASH refs verbatim from read output — never fabricate hashes
- new_text contains plain replacement lines only — no LINE:HASH prefix, no diff + markers
- new_text: "" means delete for set_line/replace_lines
- All edits in one call are validated against the file as last read — line numbers and hashes refer to the original state
- On hash mismatch: use the updated LINE:HASH refs shown by >>> in the error
- After a successful edit, re-read the file before making another edit (hashes have changed)
- Preserve exact formatting — change ONLY the targeted token/expression`;

export default function hashlineExtension(pi: ExtensionAPI) {
  // ─── Override read tool to add hashline prefixes ──────────────────────
  const readSchema = Type.Object({
    path: Type.String({
      description: "Path to the file to read (relative or absolute)",
    }),
    offset: Type.Optional(
      Type.Number({
        description: "Line number to start reading from (1-indexed)",
      })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Maximum number of lines to read" })
    ),
  });

  pi.registerTool({
    name: "read",
    label: "Read (hashline)",
    description:
      "Read file contents with LINE:HASH prefixes for use with hashline_edit. Each line is tagged with a content hash for precise editing.",
    parameters: readSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: filePath, offset, limit } = params;
      const absolutePath = resolve(ctx.cwd, filePath);

      try {
        await access(absolutePath, constants.R_OK);
        const content = await readFile(absolutePath, "utf-8");
        const allLines = content.split("\n");

        // Apply offset and limit
        const startLine = offset ? Math.max(1, offset) : 1;
        const startIdx = startLine - 1;
        const endIdx = limit ? Math.min(startIdx + limit, allLines.length) : allLines.length;
        const selectedLines = allLines.slice(startIdx, endIdx);

        // Format with hashline prefixes
        const formatted = selectedLines
          .map((line, i) => {
            const num = startLine + i;
            const hash = computeLineHash(num, line);
            return `${num}:${hash}|${line}`;
          })
          .join("\n");

        // Basic truncation (50KB limit)
        const maxBytes = 50 * 1024;
        let text = formatted;
        if (Buffer.byteLength(text, "utf-8") > maxBytes) {
          // Truncate to last complete line within limit
          const truncated = text.slice(0, maxBytes);
          const lastNewline = truncated.lastIndexOf("\n");
          text =
            (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
            "\n\n[Output truncated at 50KB]";
        }

        // Add file info header
        const totalLines = allLines.length;
        let header = "";
        if (startLine > 1 || endIdx < totalLines) {
          header = `[Showing lines ${startLine}-${startIdx + selectedLines.length} of ${totalLines}]\n`;
        } else {
          header = `[${totalLines} lines]\n`;
        }

        return {
          content: [{ type: "text", text: header + text }] as TextContent[],
          details: {
            lines: totalLines,
            startLine,
            endLine: startIdx + selectedLines.length,
            hashline: true,
          },
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${error.message}`,
            },
          ] as TextContent[],
          details: { error: true },
          isError: true,
        };
      }
    },
  });

  // ─── Register hashline_edit tool ──────────────────────────────────────
  pi.registerTool({
    name: "edit",
    label: "Edit (hashline)",
    description: TOOL_DESCRIPTION,
    parameters: editToolSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: filePath, edits } = params as {
        path: string;
        edits: HashlineEdit[];
      };
      const absolutePath = resolve(ctx.cwd, filePath);

      if (!edits || edits.length === 0) {
        return {
          content: [
            { type: "text", text: "Error: edits array is empty" },
          ] as TextContent[],
          details: {},
          isError: true,
        };
      }

      try {
        // Read current file content
        const content = await readFile(absolutePath, "utf-8");

        // Apply edits
        const result = applyHashlineEdits(content, edits);

        // Check for no-ops
        if (
          result.noopEdits.length > 0 &&
          result.noopEdits.length === edits.length
        ) {
          const noopDetails = result.noopEdits
            .map(
              (n) =>
                `  - ${n.loc}: content unchanged ("${n.currentContent.slice(0, 60)}${n.currentContent.length > 60 ? "..." : ""}")`
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `No changes made — all edits produce identical content:\n${noopDetails}\n\nRe-read the file to see current state before retrying.`,
              },
            ] as TextContent[],
            details: { noChange: true },
            isError: true,
          };
        }

        // Ensure parent directory exists
        const dir = dirname(absolutePath);
        await mkdir(dir, { recursive: true });

        // Write the result
        await writeFile(absolutePath, result.content, "utf-8");

        // Build success message
        const parts: string[] = [];
        parts.push(
          `Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${filePath}`
        );
        if (result.firstChangedLine !== undefined) {
          parts.push(`First change at line ${result.firstChangedLine}`);
        }
        if (result.noopEdits.length > 0) {
          parts.push(
            `${result.noopEdits.length} edit${result.noopEdits.length > 1 ? "s were" : " was"} no-op (identical content)`
          );
        }
        if (result.warnings.length > 0) {
          parts.push(`Warnings:\n${result.warnings.join("\n")}`);
        }

        // Show a snippet of the changed region
        const newLines = result.content.split("\n");
        if (result.firstChangedLine !== undefined) {
          const start = Math.max(0, result.firstChangedLine - 2);
          const end = Math.min(
            newLines.length,
            result.firstChangedLine + edits.length + 2
          );
          const snippet = newLines
            .slice(start, end)
            .map((line, i) => {
              const num = start + i + 1;
              const hash = computeLineHash(num, line);
              return `${num}:${hash}|${line}`;
            })
            .join("\n");
          parts.push(`\nResult:\n${snippet}`);
        }

        return {
          content: [
            { type: "text", text: parts.join("\n") },
          ] as TextContent[],
          details: {
            editsApplied: edits.length - result.noopEdits.length,
            noopEdits: result.noopEdits.length,
            firstChangedLine: result.firstChangedLine,
            warnings: result.warnings,
          },
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text", text: error.message },
          ] as TextContent[],
          details: {},
          isError: true,
        };
      }
    },
  });
}
