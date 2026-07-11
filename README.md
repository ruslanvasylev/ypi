# ypi

[![npm](https://img.shields.io/npm/v/ypi?style=flat-square)](https://www.npmjs.com/package/ypi)

**ypi** — a recursive coding agent built on [Pi](https://github.com/earendil-works/pi).

Named after the [Y combinator](https://en.wikipedia.org/wiki/Fixed-point_combinator#Y_combinator) from lambda calculus — the fixed-point combinator that enables recursion. `ypi` is Pi that can call itself. (`rpi` already has another connotation.)

Inspired by [Recursive Language Models](https://github.com/alexzhang13/rlm) (RLM), which showed that an LLM with a code REPL and a `llm_query()` function can recursively decompose problems, analyze massive contexts, and write code — all through self-delegation.

ypi is an RLM-inspired recursive coding-agent runtime, not a reproduction of the paper's Algorithm 1. A normal root prompt remains a Pi user message. Bulk data becomes external symbolic context when callers use repository files, `$CONTEXT`, or piped stdin. The native tool provides direct child-agent delegation; the CLI helper additionally supports programmatic shell loops and pipelines.

## The Idea

Pi already has an extension system and a bash REPL. ypi has one TypeScript recursion runtime used by two thin adapters: the Pi extension registers the native `rlm_query` tool, while the CLI adapter adds stdin, pipelines, async jobs, and notification. The `ypi` launcher configures those surfaces. [jj](https://martinvonz.github.io/jj/) workspace isolation is used when available, but it is not required for the minimal path.

```
┌──────────────────────────────────────────┐
│  ypi (depth 0)                           │
│  Tools: native rlm_query, bash           │
│  Workspace: default                      │
│                                          │
│  > grep -n "bug" src/*.py                │
│  > sed -n '50,80p' src/app.py \          │
│      | rlm_query "Fix this bug"          │
│            │                             │
│            ▼                             │
│    ┌────────────────────────────┐        │
│    │  ypi (depth 1)            │        │
│    │  Workspace: jj if present │        │
│    │  Edits files safely       │        │
│    │  Returns: patch on stdout │        │
│    └────────────────────────────┘        │
│                                          │
│  > jj squash --from <child-change>       │
│  # absorb the fix into our working copy  │
└──────────────────────────────────────────┘
```

---

## Using ypi

### Install

```bash
# bun (global)
bun install -g ypi

# or npm (global)
npm install -g ypi

# or run without installing
bunx ypi "What does this repo do?"

# or curl
curl -fsSL https://raw.githubusercontent.com/rawwerks/ypi/master/install.sh | bash

# or manual
git clone https://github.com/rawwerks/ypi.git && cd ypi
git submodule update --init --depth 1
export PATH="$PWD:$PATH"
```

### Run

```bash
# Interactive
ypi

# One-shot
ypi "Refactor the error handling in this repo"

# Different model
ypi --provider anthropic --model claude-sonnet-4-5-20250929 "What does this codebase do?"
```

### Use As A Pi Extension

The minimal path is the `pi-recursive` package — a pure Pi extension. It gives Pi
the native recursive `rlm_query` tool without the `ypi` launcher, shell helper, or
jj requirement:

```bash
# Try for one run
pi -e npm:pi-recursive "Use rlm_query to ask a child what 2 + 2 is."

# Install globally for normal pi sessions
pi install npm:pi-recursive
pi

# Install project-locally into .pi/settings.json
pi install -l npm:pi-recursive
```

The npm package has a Pi manifest that exposes only
`./extensions/recursive.ts`. The `ypi` binary remains available for users who
want the wrapper defaults and shell-compatible helper commands.

### How It Works
**Three adapted pieces** from the RLM pattern:
| Piece | Python RLM | ypi |
|---|---|---|
| System prompt | `RLM_SYSTEM_PROMPT` | `SYSTEM_PROMPT.md` |
| Context / REPL | Python `context` variable | `$CONTEXT` file + bash |
| Sub-call function | `llm_query("prompt")` | native Pi tool `rlm_query`; optional shell command `rlm_query "prompt"` |
**Recursion:** the `extensions/recursive.ts` extension registers a native `rlm_query` tool that spawns a child Pi process with the same extension and a depth/isolation-appropriate tool profile. A nonterminal child can call `rlm_query` too:

```
Depth 0 (root)        -> full Pi with native rlm_query + bash
  Depth 1 (child)     -> full Pi with native rlm_query + bash
    Depth 2 (child)   -> full Pi with native rlm_query + bash
      Depth 3 (leaf)  -> full Pi with bash, but no rlm_query (default max depth)
```

**File isolation with jj:** When jj is available and `RLM_JJ` is not `0`, recursive children use [jj workspaces](https://martinvonz.github.io/jj/latest/working-copy/) for isolation. If jj is missing, the checkout is not initialized, or workspace creation fails, recursion stops with an explicit choice instead of silently changing task capability: set `RLM_JJ=0` for read-only children, initialize colocated jj, or set `RLM_UNSAFE_NO_JJ_WRITE=1` to allow writes in the current checkout. Explicit read-only children exclude built-in mutators (`bash`, `edit`, `write`). Children load only the exact canonical ypi extension by default, so other ambient extension tools are intentionally unavailable; `RLM_AMBIENT_EXTENSIONS=1` restores trusted ambient tools but also accepts version-skew and duplicate-extension risk.

### Why It Works

The design has four properties that compound:

1. **Recursive similarity** — Nonterminal depths run the same agent and extension with the same decomposition guidance. Tool profiles can narrow for no-jj safety, recursion disappears at the configured leaf, and provider/model/thinking routes can vary by depth. The intelligence remains in *decomposition*, not specialized role prompts.

2. **Self-hosting** — The TypeScript runtime core is the canonical recursion machinery. When the CLI helper is enabled (the `ypi` wrapper, or any load with `YPI_SHELL_HELPER=1`), the prompt includes the thin launcher, runtime core, and CLI adapter for inspection. A bare `pi -e` / npm extension install uses the thin native adapter over the same core.

3. **Bounded ancestry with tree guards** — `RLM_MAX_DEPTH` remains `3`; a controlled depth-3/depth-4 audit found all 12 planted defects at depth 3, while depth 4 timed out without an answer after 1.818× the depth-3 tokens in complete ledger events (a lower bound) and 1.914× in session-observed usage. This rejects promoting depth 4 on the tested task; depth 2 was not evaluated, so it does not establish a globally optimal depth. Deeper per-run overrides remain available for tasks that justify them. `RLM_MAX_CALLS` defaults to `128` to bound total fan-out; timeout and budget remain explicit because safe universal wall-time and dollar limits do not exist across local and hosted models. The tracked fixture, scorer, runner, and result boundary live under `tests/eval/depth-ablation/`.

4. **Symbolic access** — `$CONTEXT` holds external data, the active human root request is captured in `$RLM_ROOT_PROMPT_FILE`, and each delegated charter lives in `$RLM_PROMPT_FILE`. Pi receives delegated text through non-interactive stdin instead of a syntax-sensitive or `ARG_MAX`-bounded argv token. Pi normalizes outer stdin whitespace, so `$RLM_PROMPT_FILE` is the byte-exact authoritative charter for whitespace-sensitive work. Async jobs snapshot all three task/session inputs before acknowledgement. Agents can use exact files and line-addressed edits instead of copying bulk data through model memory.

### Model Configuration

Root model selection is owned by Pi, not ypi. Configure the default root model in Pi's native settings (`~/.pi/agent/settings.json` globally, or project `.pi/settings.json`):

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "xhigh"
}
```

Bare `ypi` passes no provider/model by default, so Pi applies those settings (or `/model`, `--provider`, `--model`, and `--thinking`). ypi then captures the active root provider/model/thinking and forwards that route to recursive children unless child routing variables override it.

For depth-based cost control, use child routing:

```bash
RLM_CHILD_MODELS='gpt-5.5,gpt-5.5' \
RLM_CHILD_THINKING_LEVELS='high,medium' \
ypi
```

This means root uses Pi's configured default, depth-1 children use high thinking, and depth-2 children use medium thinking.

### Guardrails

| Feature | Env var | What it does |
|---------|---------|-------------|
| Budget | `RLM_BUDGET=0.50` | Max dollar spend for entire recursive tree; native extension mode requires JSON output so child cost can be measured |
| Timeout | `RLM_TIMEOUT=60` | Wall-clock limit for entire recursive tree |
| Call limit | `RLM_MAX_CALLS=128` | Max total `rlm_query` invocations (default 128; lower it for bounded evaluations) |
| Model routing | `RLM_CHILD_MODEL=haiku` or `RLM_CHILD_MODELS=big:high,small:medium` | Use one child model for every sub-call, or a comma-separated depth route for depth 1, 2, ... |
| Depth limit | `RLM_MAX_DEPTH=3` | How deep recursion can go (default 3; increase only for a measured task with explicit call/time/budget controls) |
| jj disable | `RLM_JJ=0` | Skip workspace isolation; child agents exclude built-in mutators unless `RLM_UNSAFE_NO_JJ_WRITE=1` |
| Plain text | `RLM_JSON=0` | Disable JSON mode (no cost tracking) |
| Child non-extension discovery isolation | `RLM_CHILD_DISCOVERY=0` | Pass Pi's `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and `--no-approve`; with child extensions disabled, use a private Pi agent/config root and `PI_OFFLINE=1` while preserving Pi's own package assets |
| Ambient extension compatibility | `RLM_AMBIENT_EXTENSIONS=1` | Opt into Pi's ambient extension discovery in addition to the exact ypi copy; disabled by default because old ypi copies cannot unregister their handlers |
| Tracing | `PI_TRACE_FILE=$HOME/scratch/trace.log` | Log all calls with timing + cost |

The agent can check spend at any time:

```bash
rlm_cost          # "$0.042381"
rlm_cost --json   # {"cost": 0.042381, "tokens": 12450, "calls": 3}
```

### Pi Compatibility

ypi is a thin layer on top of Pi. We strive not to break or duplicate what Pi already does:

| Pi feature | ypi behavior | Tests |
|---|---|---|
| **Session history** | Uses Pi's native session manager when a parent session exists. Child sessions go in the same dir with trace-encoded filenames. `RLM_SHARED_SESSIONS=0` uses `--no-session` and clears child session env. No separate session store. | G24–G30 |
| **Extensions** | The wrapper and recursive children load exactly their canonical ypi extension by default (`--no-extensions -e ...`) so an older ambient copy cannot register conflicting handlers. `RLM_AMBIENT_EXTENSIONS=1` is the explicit compatibility opt-in. `RLM_EXTENSIONS=0`/`RLM_CHILD_EXTENSIONS=0` disable ypi; combining child extension and discovery opt-outs adds a private Pi agent/config root and offline mode without replacing Pi's own package assets. | G34–G38, N8, runtime contract |
| **Native recursion** | `extensions/recursive.ts` registers a thin native Pi `rlm_query` adapter over `extensions/ypi/runtime-core.ts`. Minimal mode works with only Pi plus extension files: no `ypi` launcher, CLI helper, or jj. | extension smoke, pure-extension E2E |
| **System prompt** | The extension injects `SYSTEM_PROMPT.md` when present and falls back to a minimal built-in prompt when it is not. Every child receives exact task-context and charter paths plus task-context-over-unrelated-retrieval guidance; extension-isolated children receive the same map through a private generated `--system-prompt`. Wrapper mode appends the thin launcher, canonical runtime core, and CLI adapter as self-hosting context. | T8–T9, runtime contract, live E1/E2/E4 |
| **Non-interactive mode** | Child Pi calls use `--mode json` for measurable structured output or `-p` for plain mode. ypi never fakes a terminal. | T3–T4, N10 |
| **`--session` flag** | Used when session sharing is enabled and Pi has a session dir; `--no-session` otherwise. Never both. | G24, G28 |
| **Provider/model** | Bare `ypi` defers root provider/model/thinking to Pi (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `/model`, or CLI flags). The extension captures Pi's active root route into `RLM_PROVIDER`/`RLM_MODEL`/`RLM_THINKING_LEVEL` so children inherit it unless `RLM_CHILD_*` or depth lists override child routing. | T14, T14c–T14g, G6b, N7b |

If Pi changes how sessions or extensions work, our guardrail tests should catch it.

### Troubleshooting

If `ypi` or recursion **seems broken**, run `ypi-doctor` for an npm install or
`make doctor` from a source checkout. The most common cause is the wrong host
`pi`: either the old `@mariozechner/pi-coding-agent` shadowing the current
`@earendil-works/pi-coding-agent`, or a version older than `.pi-version`. The
doctor prefers ypi's package-local exact dependency over PATH, reports the
mismatch, and honors an explicit `YPI_PI_BIN`, so it checks the same binary
recursion actually spawns.

### Package Boundary

There are two published packages, built from one canonical source:

| Package | Audience | Entry point | Includes |
|---|---|---|---|
| **`pi-recursive`** | Pi users who want recursion inside plain `pi` | `pi install npm:pi-recursive` or `pi -e npm:pi-recursive` | The native `rlm_query` tool, prompt injection, depth/status/env handling. No `bin`; host `pi` is a peer dependency. |
| **`ypi`** | Users who want a preconfigured recursive CLI | `npm install -g ypi` / `bun install -g ypi` | The same core and extension plus launcher defaults, the Node-backed `rlm_query` CLI (pipes/async), cost/session helpers, and retained one-release fallbacks. Bundles `pi` so the CLI runs without a separate global install. |

During the convergence window, `YPI_LEGACY_IMPL=1 ypi ...` or
`YPI_LEGACY_IMPL=1 rlm_query ...` selects the shipped incumbent native/CLI
engine for rollback and comparison. These paths remain packaged and tested;
`docs/deletion-candidates.md` is a mark-for-deletion evidence ledger, not
permission to remove them.

Both ship the same `extensions/` source. `pi-recursive` is the extension-only
publish view, staged from the repo root by `scripts/build-pi-recursive`; `ypi`
ships the extension plus its launcher and shell helpers. The shell helper is
opt-in (`YPI_SHELL_HELPER=1`, set by the `ypi` wrapper), so installing
`pi-recursive` gives you the native tool only.

---

## Contributing

### Project Structure

```
ypi/
├── ypi                    # Thin launcher: sets env, loads extensions/recursive.ts
├── rlm_query              # Thin shell launcher for the canonical CLI adapter
├── rlm_query.legacy       # Retained fallback; candidate, not removed
├── extensions/
│   ├── recursive.ts       # Canonical ypi Pi extension
│   ├── ypi/               # Runtime core plus native/CLI adapters and support
│   └── ypi.ts             # Compatibility alias for recursive.ts
├── SYSTEM_PROMPT.md       # Teaches the LLM to be recursive + edit code
├── AGENTS.md              # Meta-instructions for the agent (read by ypi itself)
├── Makefile               # test targets
├── tests/
│   ├── test_unit.sh       # Mock pi, test bash logic (no LLM, fast)
│   ├── test_guardrails.sh # Test guardrails (no LLM, fast)
│   └── test_e2e.sh        # Real LLM calls (slow, costs ~$0.05)
├── pi-mono/               # Git submodule: upstream Pi coding agent
└── README.md
```

### Version Control

This repo strongly prefers **[jj](https://martinvonz.github.io/jj/)** for version control. Git remains the remote-facing substrate.

```bash
jj status                    # What's changed
jj describe -m "message"     # Describe current change
jj new                       # Start a new change
jj bookmark set master       # Point master at current change
jj git push                  # Push to GitHub
```

Prefer jj for local changes, especially recursive agent work. Use the repo's safe push/land helpers for remote-facing operations.

### Testing

```bash
make test-fast         # unit + guardrails
make test-extensions   # latest Pi + extension compatibility, including minimal mode
make pre-push-checks   # shared local/CI gate (recommended before push)
make test-e2e          # real LLM calls, costs money
make test-recursion-e2e # focused live proof that ypi invokes rlm_query
make test-extension-recursion-e2e # direct pi -e native tool recursion proof
make test-parity-e2e   # wrapper vs direct-extension parity proof
make test              # all of the above
```

For a large, proof-bound, or self-hosting change, follow
[`docs/bounded-recursive-development.md`](docs/bounded-recursive-development.md).
It defines the single persisted run envelope, three-review topology,
continuation semantics, and freeze-before-paid gate. The lightweight
`.prose/recursive-development.prose` workflow is not a substitute for that
contract.

Install hooks once per clone to run checks automatically on git push:
```bash
make install-hooks
```

Release/update helper:
```bash
make release-preflight   # same checks + upstream dry-run in one command
make land                # deterministic-ish landing helper
```

**Before any change to `rlm_query`:** run `make test-fast`. After: run it again. `rlm_query` is a live dependency of the agent's own execution — breaking it breaks the agent.

CI helper commands:
```bash
make ci-status N=15      # recent workflow runs
make ci-last-failure     # dump latest failing workflow log
```


### History

ypi went through five approaches before landing on the current design:

1. **Tool-use REPL** (exp 010/012) — Pi's `completeWithTools()`, ReAct loop. 77.6% on LongMemEval.
2. **Python bridge** — HTTP server between Pi and Python RLM. Too complex.
3. **Pi extension** — Custom provider with search tools. Not true recursion.
4. **Bash RLM** (`rlm_query` + `SYSTEM_PROMPT.md`) — True recursion via bash.
5. **Pi-native recursive-agent extension** — `extensions/recursive.ts` registers native recursion; `ypi` and shell `rlm_query` provide wrapper and programmatic composition surfaces. This is the current RLM-inspired approach, not an Algorithm 1 reproduction.

The key insight: Pi's extension API can expose recursion as a first-class tool, while Pi's bash tool remains the REPL for command-line composition. No bridge needed.

---

## See Also

- [Pi coding agent](https://github.com/earendil-works/pi) — the underlying agent
- [Recursive Language Models](https://github.com/alexzhang13/rlm) — the library that inspired this
- [rlm-cli](https://github.com/rawwerks/rlm-cli) — Python RLM CLI (budget, timeout, model routing)
