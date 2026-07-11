# Bounded Recursive Development

Use this runbook for large, proof-bound, or self-hosting ypi changes. It keeps
recursive review useful without turning the root session into an unbounded
orchestration tree.

This is an operating contract over existing ypi, jj, test, telemetry, and eval
surfaces. It does not introduce another orchestrator.

## Scope and non-goals

The root agent owns implementation and parent-side adjudication. Recursive
children are advisory reviewers and focused probes. Do not distribute edits to
overlapping runtime files, add a new result validator, or make OpenProse the
proof owner. `.prose/recursive-development.prose` remains a lightweight feature
workflow and is not the proof-bound path described here.

## Create the envelope once

The operator must approve the dollar cap and overall deadline before the first
child. Initialize the run exactly once. The persisted envelope contains only
non-secret control values; never write the full process environment to disk.

```bash
set -euo pipefail
umask 077

: "${YPI_RUN_BUDGET:?set the operator-approved dollar cap}"
: "${YPI_RUN_DEADLINE_EPOCH:?set the approved overall deadline as epoch seconds}"
python3 - "$YPI_RUN_BUDGET" "$YPI_RUN_DEADLINE_EPOCH" <<'PY'
import math, sys, time
budget = float(sys.argv[1])
deadline = int(sys.argv[2])
assert math.isfinite(budget) and budget > 0
assert deadline > int(time.time())
PY

BRANCH="$(git branch --show-current)"
test -n "$BRANCH"
case "$BRANCH" in main|master) echo "refusing shared trunk" >&2; exit 1;; esac
BRANCH_SLUG="$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_PARENT="$PWD/tmp/$BRANCH_SLUG/recursive"
RUN_DIR="$RUN_PARENT/$RUN_ID"
mkdir -p "$RUN_PARENT"
mkdir -m 700 "$RUN_DIR"

export YPI_RECURSIVE_RUN_DIR="$RUN_DIR"
export RLM_TRACE_ID="$RUN_ID"
export PI_TRACE_FILE="$RUN_DIR/tree.trace"
export RLM_CALL_COUNTER_FILE="$RUN_DIR/calls"
export RLM_COST_FILE="$RUN_DIR/cost.jsonl"
export RLM_CALL_COUNT=0
export RLM_JSON=1
export RLM_MAX_DEPTH=2
export RLM_MAX_CALLS=18
export RLM_TIMEOUT=3600
export RLM_BUDGET="$YPI_RUN_BUDGET"

printf '0\n' > "$RLM_CALL_COUNTER_FILE"
: > "$RLM_COST_FILE"
: > "$PI_TRACE_FILE"

{
  printf 'export YPI_RECURSIVE_RUN_DIR=%q\n' "$YPI_RECURSIVE_RUN_DIR"
  printf 'export YPI_RUN_DEADLINE_EPOCH=%q\n' "$YPI_RUN_DEADLINE_EPOCH"
  printf 'export RLM_TRACE_ID=%q\n' "$RLM_TRACE_ID"
  printf 'export PI_TRACE_FILE=%q\n' "$PI_TRACE_FILE"
  printf 'export RLM_CALL_COUNTER_FILE=%q\n' "$RLM_CALL_COUNTER_FILE"
  printf 'export RLM_COST_FILE=%q\n' "$RLM_COST_FILE"
  printf 'export RLM_JSON=1\n'
  printf 'export RLM_MAX_DEPTH=2\n'
  printf 'export RLM_MAX_CALLS=18\n'
  printf 'export RLM_TIMEOUT=3600\n'
  printf 'export RLM_BUDGET=%q\n' "$RLM_BUDGET"
} > "$RUN_DIR/envelope.sh"
chmod 600 "$RUN_DIR/envelope.sh"
```

`RLM_TIMEOUT` bounds one depth-0 recursive tree, not the entire interactive
root session. The parent checks `YPI_RUN_DEADLINE_EPOCH` at natural checkpoints.
A cap hit stops the run; never raise a cap in place.

## Resume without resetting

A continuation brief must carry the exact `RUN_DIR`, HEAD, deadline, open
blockers, and next action. It must not carry credentials. A continuation sources
the existing envelope and requires all ledgers to exist; it never regenerates a
run ID or truncates a file.

```bash
set -euo pipefail
umask 077

RUN_DIR="<exact run directory from the continuation brief>"
test -f "$RUN_DIR/envelope.sh"
# shellcheck disable=SC1090
. "$RUN_DIR/envelope.sh"

test "$YPI_RECURSIVE_RUN_DIR" = "$RUN_DIR"
test -f "$RLM_CALL_COUNTER_FILE"
test -f "$RLM_COST_FILE"
test -f "$PI_TRACE_FILE"
test "$(date +%s)" -lt "$YPI_RUN_DEADLINE_EPOCH"

export RLM_CALL_COUNT="$(tr -d '[:space:]' < "$RLM_CALL_COUNTER_FILE")"
```

The counter file is authoritative. Explicitly restoring `RLM_CALL_COUNT`
prevents a missing or contaminated ambient value from becoming the fallback.
The cost ledger preserves spent budget across sessions.

## Structural budget

The 18-call ceiling is allocated as follows:

- three independent reviewers with at most two sequential probes each: 9;
- one focused re-review with at most one probe: 2;
- one independent closeout with at most one probe: 2;
- disagreement, failed-admission, or countercheck reserve: 5.

At most three top-level reviewers run concurrently. A reviewer may have only one
probe in flight. This bounds concurrent budget overshoot while retaining the
three distinct risk viewpoints. Parent adjudication is direct root work and
never consumes a child-call slot.

## Execution order

1. **Discover deterministically.** Use `rg`, Python, source inspection, and
   existing validators before asking a model.
2. **Implement serially in the root.** Keep self-hosting runtime and shared test
   edits on one critical path. Run focused tests after each coherent mechanism.
3. **Run three independent reviews in one turn.** Do not expose sibling reports:
   - runtime/lifecycle: deadlines, cancellation, process groups, output,
     async, and jj cleanup;
   - packaging/evidence: routing, prompt authority, installed resolution,
     fallbacks, eval honesty, and release gates;
   - security/cleanup: path containment, permissions, temp ownership,
     symlinks, deletion scope, and hostile metadata.
4. **Absorb skeptically.** The parent deduplicates by mechanism, reproduces each
   accepted finding, and records it in the existing blocker/telemetry ledger.
5. **Fix serially.** Re-evaluate only invalidated owners.
6. **Run one focused re-review.** Give it open blockers and changed paths; ask
   only for resolution failures and regressions. Add another reviewer only for
   a named disagreement the parent cannot resolve.
7. **Run one independent closeout.** Stop the review loop after PASS unless a
   direct counterexample invalidates it.

If a second broad `REOPEN` occurs or root context degrades, write a continuation
brief and resume with the same envelope before making more edits.

## Child result boundary

Each reviewer returns at most 12 KiB and up to eight highest-severity findings
inline. Every inline finding includes `path:line`, mechanism, user impact, and
one reproduction command or artifact reference. If more findings exist, the
child writes the complete report beneath the run directory and returns its path
plus `additional_finding_count`; findings are never silently discarded.

Long reproduction scripts belong in run artifacts, not the parent response. No
new schema validator is required; this is a charter and parent-absorption rule.

## Model and async policy

Reviewers, focused re-review, and closeout use the strong configured model.
Mechanical discovery stays in deterministic tools. A cheaper model is allowed
only for a bounded synthesis call launched in its own shell process with an
explicit provider/model route; do not set global depth routing.

Use native parallel calls by default. Async is optional and may be used only
after a notification smoke proves that this Pi instance receives its sentinel
and useful root work is queued. If the smoke fails or `YPI_INSTANCE_ID` is
absent, do not debug a replacement during the run.

## Freeze before paid evaluation

Before the first paid lane:

1. close all source-review blockers;
2. run focused tests, package/install checks, and release consistency;
3. run `scripts/encrypt-prose --check`;
4. run `make test-eval-contracts` with mock Pi;
5. commit every tracked change;
6. require a clean worktree and record exact HEAD.

Paid runtime parity runs only through the existing facade:

```bash
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=canonical-cli
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=legacy-cli
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=canonical-native
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=legacy-native
```

`tests/eval/runtime-parity/run-lane.sh` owns recursion-environment sanitization,
private counters/ledgers, exact transition and call-count proof, and semantic
scoring. Do not construct an ad-hoc `env -i` lane. Do not edit tracked files
while lanes run. A tracked edit invalidates final paid evidence. Permit one
rerun only for a documented provider/transient failure.

## Closeout and delivery

Completion requires resolved telemetry, deterministic and installed-package
checks, exact-final-commit paid contracts, parent verification, truth-seeking
review, telemetry validation, encryption validation, and honest branch state.
Import a recursive trace into Agent Protocol only when child execution itself is
being promoted as proof.

Feature branches push to `origin`; never direct-push `upstream`. Upstream PR
creation or mutation requires a separate explicit instruction. For the current
plan implementation, push only the feature branch to `origin`.

## Metrics

Record allocations, spawned sessions, overlapping child-minutes, root wall
time, transcript bytes, cost/tokens from the run ledger, duplicate mechanisms,
timeouts, and rejected paid lanes. The historical non-dollar baseline is 131
allocations, 42 sessions, 842.6 overlapping child-minutes, 31.4 MB transcripts,
and about 9h20m root wall time. The historical orchestration had no comparable
`RLM_COST_FILE`; do not invent a dollar baseline or savings percentage.
