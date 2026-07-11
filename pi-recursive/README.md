# pi-recursive

The pure [Pi](https://github.com/earendil-works/pi) extension that lets Pi recursively call
itself — a native `rlm_query` tool that delegates a bounded subtask to a child Pi agent with a
fresh context window, down to a configurable depth.

This is the canonical recursion machinery. The [`ypi`](https://www.npmjs.com/package/ypi) CLI
wrapper is a convenience layer around this same extension (launcher defaults, a shell-compatible
`rlm_query` with pipes/async, cost/session helpers). If you just want recursion inside plain Pi,
install this.

## Install

```bash
pi install npm:pi-recursive
# or try it for one session without installing:
pi -e npm:pi-recursive "Use rlm_query to ask a child what 2 + 2 is."
```

## What you get

- A native `rlm_query` Pi tool — no shell helper, no launcher, no `jj` required.
- Recursive children share the active provider/model, bounded by depth and total child-call admission. Cost is recorded as telemetry and never stops work.
- Review mode is read-only without any workspace. One explicit implementer may use an existing jj checkout or an exclusive lease in an existing clean Git checkout. The extension never installs or initializes VCS tooling.
- Native progress shows elapsed time, four recent sanitized tool activities, completed cost, and observe-only stale warnings.

The shell-compatible `rlm_query` command, async jobs, and CLI ergonomics live in the `ypi`
wrapper package and are opt-in via `YPI_SHELL_HELPER=1`.

## Configuration

Behavior is controlled through `RLM_*` environment variables. The pure extension honors:

| Variable | Example | What it does |
| --- | --- | --- |
| `RLM_MAX_DEPTH` | `RLM_MAX_DEPTH=3` | How deep recursion can go (default `3`; deeper runs require explicit bounds). |
| `RLM_CHILD_MODEL` | `RLM_CHILD_MODEL=haiku` | Use one model for all sub-calls at depth > 0. |
| `RLM_CHILD_PROVIDER` | `RLM_CHILD_PROVIDER=anthropic` | Provider used with `RLM_CHILD_MODEL`. |
| `RLM_CHILD_THINKING_LEVEL` | `RLM_CHILD_THINKING_LEVEL=high` | Thinking level for all sub-calls at depth > 0. |
| `RLM_CHILD_MODELS` | `RLM_CHILD_MODELS=big:high,small:medium` | Comma-separated model route for child depths 1, 2, ... |
| `RLM_CHILD_PROVIDERS` | `RLM_CHILD_PROVIDERS=openai,openai` | Comma-separated provider route for child depths 1, 2, ... |
| `RLM_CHILD_THINKING_LEVELS` | `RLM_CHILD_THINKING_LEVELS=high,medium` | Comma-separated thinking route for child depths 1, 2, ... |
| `RLM_COST_FILE` | automatic private path | Append-only cost/token telemetry; never an admission gate. |
| `PI_TRACE_FILE` | automatic private path | Lifecycle trace without prompt or tool arguments. |
| `RLM_TIMEOUT` | `RLM_TIMEOUT=60` | Optional explicitly requested wall-clock limit; unset by default. |
| `RLM_MAX_CALLS` | `RLM_MAX_CALLS=128` | Max child-call admissions (default `128`); the root continues directly at the cap. |
| native tool `mode` | `review` or `implement` | Read-only by default; at most one bounded clean-checkout implementer. |

The shell-helper guardrails and cost/session CLI commands (e.g. `rlm_cost`) documented in the
[ypi README](https://github.com/rawwerks/ypi#readme) apply only to the `ypi` wrapper package, not
to this pure extension.

## Compatibility

This extension is tested against the repository-pinned Pi version and the upstream compatibility
lane. Following Pi's package contract, host-provided core packages
`@earendil-works/pi-coding-agent` and `typebox` are declared as `"*"` peers rather than bundled or
artificially restricted to one Pi minor release. Compatibility is established by the package/load
and recursive smoke tests, not inferred from the peer range.

## Source

Developed in the [rawwerks/ypi](https://github.com/rawwerks/ypi) monorepo; `pi-recursive` is the
extension-only publish view of the same source.
