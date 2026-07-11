# Pure Extension Differences

This folder proves that the core ypi idea can run as a plain Pi extension:

```bash
pi -e ./extensions/recursive.ts
```

The `ypi` launcher is now a convenience wrapper around the same extension. The
shell-compatible `rlm_query` command is also optional: useful for pipes, async
jobs, and CLI ergonomics, but not required for minimal recursion.

## What Matches

- `rlm_query` is available to the root agent as a native Pi tool.
- Under the `ypi` wrapper (or any load with `YPI_SHELL_HELPER=1`), the shell `rlm_query`
  is also placed on `PATH` for the bash tool and its source is folded into the prompt.
  A bare `pi -e` / npm extension install leaves `YPI_SHELL_HELPER` unset and defaults to
  the native tool only — no shell helper on `PATH`, no shell source in the prompt.
- Root and child calls receive `RLM_DEPTH`, `RLM_MAX_DEPTH`, `RLM_SYSTEM_PROMPT`,
  `RLM_TRACE_ID`, `RLM_SESSION_DIR`, and the other RLM guardrail env vars.
- The active Pi model is copied into `RLM_PROVIDER` and `RLM_MODEL`, so recursive
  children use the same provider/model as the root unless the user overrides them.
- The ypi recursive prompt is injected before the first model call via Pi's
  `before_agent_start` extension hook. A minimal built-in prompt is used when
  `SYSTEM_PROMPT.md` is absent.
- A real `pi -e` run can call native `rlm_query` recursively from the root, let
  the child call native `rlm_query` again, and return the grandchild output.

## Differences From The Launcher

- **Prompt timing:** both paths now patch the prompt in `before_agent_start`,
  after Pi has assembled its base prompt.
- **Prompt composition:** the canonical extension defaults to
  `YPI_EXTENSION_PROMPT_MODE=append`, preserving Pi's normal prompt and appending
  ypi's recursive prompt. Set `YPI_EXTENSION_PROMPT_MODE=replace` to use only the
  ypi prompt.
- **Environment scope:** the launcher exports env vars before Pi starts. The
  extension mutates `process.env` inside the running Pi process. Pi's bash tool
  currently copies `process.env`, so this works, but it is process-global rather
  than scoped to one extension. To avoid stale state on a long-running root Pi,
  the extension no longer freezes `RLM_START_TIME` at load — the timeout budget is
  anchored when each top-level (`depth 0`) recursion tree begins — and it only puts
  the shell helper on `PATH` when `YPI_SHELL_HELPER=1`.
- **Load path:** the launcher always loads `extensions/recursive.ts` automatically. The
  pure extension is explicit: `pi -e ./extensions/recursive.ts`, or it must be
  installed into Pi's extension discovery path.
- **Argument rewriting:** the launcher still consumes ypi-only convenience flags
  such as `--quiet` and can route `RLM_PROVIDER`/`RLM_MODEL` into Pi args. The
  direct extension cannot rewrite the original CLI argv after parsing.
- **Failure timing:** the pure extension no longer fails when `SYSTEM_PROMPT.md`
  or the shell `rlm_query` helper is absent; it falls back to minimal native
  recursion. The launcher still validates its convenience files before `exec pi`.

## Observed Comparison

Run on 2026-06-15 with `openrouter/openai/gpt-5.5:xhigh`:

- Minimal pure extension command copied only `extensions/**` into a scratch root,
  then started `pi` directly with `-e`. The scratch root contained no `ypi`
  launcher, no shell `rlm_query`, and no `SYSTEM_PROMPT.md`. It returned
  `EXTENSION_RECURSION_OK`; current review mode obtains the same no-workspace
  behavior automatically. The trace showed
  `depth=0→1` and `depth=1→2` with `caller=tool jj=off`.
- Pure extension command started `pi` directly with `-e ./extensions/recursive.ts`.
  It returned `PURE_COMPARE_OK`, and its trace showed `depth=0→1` and
  `depth=1→2` calls that both completed with `exit=0`.
- Current wrapper command started `./ypi`. It returned `WRAPPER_COMPARE_OK`, and
  its trace also showed `depth=0→1` and `depth=1→2` calls that both completed
  with `exit=0`.
- In wrapper/direct-extension parity, the only observed output-level difference
  was that the pure extension emitted debug markers when
  `YPI_EXTENSION_DEBUG=1`; the wrapper did not.

## Remaining Parity Work

- Add CI/live tests for observational cost JSON telemetry, explicit-timeout
  compatibility, session logs, canonical child-extension loading, and `--fork`.
- Decide whether Pi needs a first-class extension API for scoped bash env vars;
  the current prototype relies on process-global env mutation.
