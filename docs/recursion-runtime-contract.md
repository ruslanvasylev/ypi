# Recursion Runtime Contract

This contract is the canonical behavior boundary for ypi recursion. The engine
owner is `extensions/ypi/runtime-core.ts`; it separates runtime policy from its
user-facing adapters so native Pi tool calls and CLI composition cannot silently
grow different guardrails, routes, or child lifecycles.

The executable contract is `tests/runtime_contract_harness.ts`. Prose changes do
not alter behavior unless the harness and the owning implementation change with
it.

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
- writable jj workspace or explicit no-jj read-only behavior
- child process cancellation, exit classification, output bounds, and cleanup

A runtime result must distinguish normal exit, timeout, cancellation, and child
failure. Output limits must be enforced while reading the child stream, not only
after the full stream is resident in memory.

## Adapter-owned responsibilities

### Native Pi adapter

`extensions/ypi/native-tool.ts` owns only Pi-facing concerns:

- TypeBox request schema and tool registration
- Pi context/model/session projection into a runtime request
- progress and cancellation bridging
- Pi tool-result presentation

### CLI adapter

`rlm_query` owns only command-line concerns:

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
- no-jj children exclude built-in mutators through both adapters without a
  global allowlist that could hide installed package tools
- native stdout and stderr are now bounded while the child stream is drained;
  the final result reports when raw capture was truncated
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
