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
- timeout anchoring and remaining wall-clock budget
- budget preflight and cost-ledger updates
- provider, model, and thinking-level routing by child depth
- trace identity and path-safe session naming
- prompt and optional context artifacts
- child session and fork behavior
- child environment allowlisting
- extension and non-extension discovery policy
- writable jj workspace or explicit no-jj read-only/current-checkout behavior; automatic jj failure may not silently downgrade capability
- child process cancellation, exit classification, output bounds, and cleanup

A runtime result must distinguish normal exit, timeout, cancellation, and child
failure. Output limits must be enforced while reading the child stream, not only
after the full stream is resident in memory. Incremental JSON parsing must retain
late answer and cost events even when an earlier diagnostic event exceeds its
capture bound. If the skipped oversized event itself could own cost, configured
budget enforcement must fail closed rather than record a partial value.

## Default guardrail posture

- `RLM_MAX_DEPTH=4` supports an observed orchestrate → review → adjudicate →
  focused-probe chain without treating deeper recursion as a target.
- `RLM_MAX_CALLS=128` bounds total fan-out with headroom above the approximately
  52-call evaluation trace that motivated this change.
- Timeout and dollar budget remain explicit per-run choices because hosted and
  local models do not share a safe universal value.
- Deeper overrides require an explicit total-call limit and should use timeout or
  budget limits when those dimensions are measurable.
- `$RLM_ROOT_PROMPT_FILE` preserves the first delegation charter through the
  tree; child prompts must echo applicable goal/scope/acceptance, and parents
  must validate results before absorption.

## Adapter-owned responsibilities

### Native Pi adapter

`extensions/ypi/native-tool.ts` owns only Pi-facing concerns:

- TypeBox request schema and tool registration
- Pi context/model/session projection into a runtime request
- progress and cancellation bridging
- Pi tool-result presentation

### CLI adapter

`extensions/ypi/cli.ts` owns command-line concerns; `rlm_query` only resolves the
package root, selects the explicit legacy fallback when requested, and launches
Node:

- CLI flags
- inherited or piped stdin
- asynchronous job metadata, sentinels, and peer notification
- portable command-line presentation of runtime errors and output

Pipes and shell loops remain supported because programmatic composition is an
important RLM capability. They do not justify a second copy of runtime policy.

## Contract invariants

For equivalent requests, both adapters must agree on:

1. child depth, call number, provider, model, and thinking level
2. prompt and context contents visible to the child
3. session enabled/disabled state
4. extension/discovery settings
5. credential and recursive environment projection
6. timeout, maximum-call, and budget admission decisions
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
- explicit `RLM_JJ=0` children exclude built-in mutators through both adapters
  without a global allowlist that could hide installed package tools;
  requested-but-unavailable jj fails with explicit read-only/initialize/unsafe-write choices
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
