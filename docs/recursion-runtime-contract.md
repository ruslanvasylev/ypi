# Recursion Runtime Contract

This contract is the canonical behavior boundary for ypi recursion. The engine
owner is `extensions/ypi/runtime-core.ts`; it separates runtime policy from its
user-facing adapters so native Pi tool calls and CLI composition cannot silently
grow different guardrails, routes, or child lifecycles.

The executable contract is `tests/runtime_contract_harness.ts`. Prose changes do
not alter behavior unless the harness and the owning implementation change with
it. `runtime-core.ts` is the only child-runtime entrypoint available to adapters;
configuration, resource, and process owners under `extensions/ypi/internal/`
remain private and are checked against adapter bypass.

## Shared engine responsibilities

Both adapters must resolve the same behavior for:

- recursion depth and terminal-depth admission
- atomic tree-wide call allocation and maximum-call admission
- optional user-requested timeout anchoring and remaining wall-clock allowance
- always-on cost-ledger telemetry with no dollar admission or stop policy
- provider, model, and thinking-level routing by child depth
- trace identity and path-safe session naming
- file-backed delegated prompt transport, root-human-request capture, and optional context artifacts, including exact child-visible paths and task-context precedence over unrelated retrieval
- child session and fork behavior, including immutable async root/context/session snapshots
- child environment allowlisting
- exact ypi extension ownership by default, explicit ambient-extension opt-in, and non-extension discovery policy, including a private offline Pi agent/config root when full resource isolation is requested without replacing Pi's shipped assets
- semantic child mode: read-only review by default; one root-only bounded implementer using a repository-wide lease plus an isolated workspace in existing jj, or an exclusive lease in an existing clean Git checkout; implementers retain edit/write but not process-spawning bash
- prohibition on installing or initializing VCS state; dirty, contended, nested, or non-VCS implement requests return implementation to the root
- child process cancellation, exit classification, output bounds, and cleanup

A runtime result must distinguish normal exit, timeout, cancellation, and child
failure. Output limits must be enforced while reading the child stream, not only
after the full stream is resident in memory. Incremental JSON parsing must retain
late answer and cost events even when an earlier diagnostic event exceeds its
capture bound. If the skipped oversized event itself could own cost—or a failed/cancelled JSON
child emits no `turn_end`—the shared ledger is marked incomplete. That marker
qualifies telemetry but never blocks later product work.

## Default guardrail posture

- `RLM_MAX_DEPTH=3` remains the default instead of being promoted to 4. In the
  bounded contract-audit ablation, depth 3 returned all 12 expected findings
  with no false positives; depth 4 then timed out without a final answer.
  Complete ledger events show lower-bound ratios of 1.818× tokens and 1.342×
  cost, while session-observed usage gives 1.914× tokens and 1.433× cost. Depth
  2 was not evaluated, so this is not a claim that 3 is globally optimal. The reproducible contract is under
  `tests/eval/depth-ablation/`.
- `RLM_MAX_CALLS=128` bounds total fan-out with headroom above the approximately
  52-call evaluation trace that motivated this change.
- ypi sets no default timeout. Explicit user-requested timeouts remain supported;
  normal interactive control is live progress plus manual cancellation.
- Dollar budgets are unsupported as a control. Cost and tokens remain visible telemetry.
- Deeper overrides require an explicit total-call limit and visible progress.
- `$RLM_ROOT_PROMPT_FILE` captures the active root human request before the root
  agent starts; standalone shell calls fall back to their first delegation.
  Child prompts use Pi's non-interactive stdin input while remaining file-backed
  for symbolic access. Pi normalizes outer stdin whitespace, so the prompt file
  is byte-authoritative. Child prompts must echo applicable goal/scope/acceptance;
  parents validate results before absorption.

## Adapter-owned responsibilities

### Native Pi adapter

`extensions/ypi/native-tool.ts` owns only Pi-facing concerns:

- TypeBox request schema and tool registration
- Pi context/model/session projection into a runtime request
- progress and cancellation bridging, including elapsed time, four sanitized recent tool activities, completed cost, and an observe-only stale warning
- Pi tool-result presentation

### CLI adapter

`extensions/ypi/cli.ts` owns command-line concerns; `rlm_query` only resolves the
package root, selects the explicit legacy fallback when requested, and launches
Node:

- CLI flags
- inherited or piped stdin under an active invocation deadline
- asynchronous job metadata, cancellation, immutable snapshots, sentinels, and exit-bearing peer notification
- backpressure/EPIPE-safe command-line presentation of runtime errors and output

Pipes and shell loops remain supported because programmatic composition is an
important RLM capability. They do not justify a second copy of runtime policy.

## Contract invariants

For equivalent requests, both adapters must agree on:

1. child depth, call number, provider, model, and thinking level
2. prompt and context contents visible to the child
3. session enabled/disabled state
4. extension/discovery settings
5. credential and recursive environment projection
6. optional timeout and maximum-call admission decisions plus non-blocking cost telemetry
7. cleanup and result classification

Adapter-specific argv syntax is allowed only where Pi requires a different
surface. Every intentional difference must be named by the executable contract.

## Incumbent divergences frozen before convergence

The initial contract harness recorded incumbent gaps rather than treating them
as desired behavior. All initially identified deterministic divergences were
resolved before shared ownership moved.

Resolved stabilization gaps remain part of the evidence history:

- native depth parsing now rejects integer prefixes and unsafe integers rather
  than accepting the `Number.parseInt` prefix
- extension-isolated children retain the standalone ypi system prompt through
  both adapters
- review children exclude built-in mutators through both adapters without a
  global allowlist that could hide installed package tools; missing jj is silent
  because reviews need no workspace, and no path recommends VCS initialization
- one root implementer may acquire a repository-wide existing-jj or clean-Git
  writer lease; child descendants cannot escalate writable authority, and the
  implementer cannot spawn shell process trees
- native answer/stderr retention is bounded while stdout is drained and parsed;
  raw stdout is counted rather than retained, and the result reports threshold crossings
- command substitution around CLI `--async` now returns job metadata without
  waiting for the child; the sentinel records the eventual child exit code and
  cleanup runs for success and failure

A convergence change must either resolve a gap or explicitly reclassify it with
contract evidence. It may not silently normalize the difference.

## Compatibility and deletion-candidate policy

No incumbent path is removed during convergence. A superseded path may be
**marked for deletion** only after:

- the shared contract passes through its replacement
- deterministic and real-model parity evidence is recorded
- packaging and installed-consumer checks pass
- a documented fallback remains available for at least one release window
- a maintainer explicitly approves later removal

The candidate, replacement, evidence, fallback, and owner decision are tracked
in `docs/deletion-candidates.md`.
