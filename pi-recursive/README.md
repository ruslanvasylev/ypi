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
- Recursive children share the active provider/model, bounded by depth, call count, timeout,
  and budget guardrails.
- `jj` workspace isolation is used automatically when available; recursion still works without it.

The shell-compatible `rlm_query` command, async jobs, and CLI ergonomics live in the `ypi`
wrapper package and are opt-in via `YPI_SHELL_HELPER=1`.

## Configuration

Behavior is controlled through `RLM_*` environment variables (depth, model routing, budget,
timeout, sessions). See the [ypi documentation](https://github.com/rawwerks/ypi#readme).

## Source

Developed in the [rawwerks/ypi](https://github.com/rawwerks/ypi) monorepo; `pi-recursive` is the
extension-only publish view of the same source.
