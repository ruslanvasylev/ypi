# Agent Instructions — ypi

## Hard Authority Boundaries

- Never install or initialize Git, jj, or another version-control system. Use only repository state that already exists.
- Resolve publication authority from the remote URL, never the remote name. Remotes outside exact owner namespace `ruslanvasylev` are read-only unless the user's current request explicitly authorizes that exact operation.
- Never infer or ask about a release. Package publication, release tags, and GitHub releases happen only when the user's current request explicitly initiates them.
- Never set or recommend a dollar budget for recursive work. Cost is telemetry; call admission, live progress, deduplication, and manual cancellation are the controls.

## Running Prose Programs & Background Tasks
Launch long-running tasks in tmux with a sentinel file. The `notify-done` extension
watches `/tmp/ypi-signal-*` and **injects a message into your conversation** when
the task finishes — no sleeping, no polling, no `tmux capture-pane` loops.
**How it works:**
- Idle → `triggerTurn` fires immediately, you get a new turn
- Busy (mid-tool-execution) → message is **steered** in, delivered after the current tool finishes
- Either way, the notification appears in your message history and you respond to it
```bash
# Launch with sentinel (you'll be woken up when it finishes)
tmux send-keys -t eval:land "cd ~/Documents/GitHub/ypi && rp ypi .prose/land.prose; echo done > /tmp/ypi-signal-${YPI_INSTANCE_ID}-land" Enter
# That's it. Keep working on other things. You'll get a message like:
#   ⚡ Background task "land" completed: done
# ...and a new turn is triggered so you can respond to it.
```
**IMPORTANT: Do NOT poll or sleep-loop waiting for background tasks.**
Do not `sleep && tmux capture-pane` in a loop. Do not check progress unless
asked. Just keep working — the extension will interrupt you when it's ready.

**Sentinel naming:** `/tmp/ypi-signal-${YPI_INSTANCE_ID}-{name}` — always include
`$YPI_INSTANCE_ID` so the signal reaches THIS instance, not a sibling. The `{name}`
part appears in the notification. File contents become the notification body.
The file is deleted after consumption.
**Key programs:**
- `rp ypi .prose/land.prose` — "land it" / "land the plane": tests, push, handoff
- `.prose/release.prose` exists only for an explicitly user-initiated release task; never invoke or suggest it otherwise
- `rp ypi .prose/check-upstream.prose` — verify Pi compatibility
- `rp ypi .prose/incorporate-insight.prose insight='...'` — propagate an insight across the repo
- `docs/bounded-recursive-development.md` — mandatory run contract for large, proof-bound, or self-hosting recursive work

## Version Control

Root delivery uses the repository's existing Git checkout and normal feature branches. Do not create `.jj` metadata or ask the user to choose a VCS mode.

```bash
git status --short --branch
git switch -c feat/description
git add <scoped-paths>
git commit -m "type: description"
git push -u origin HEAD       # only after scripts/validate-push-owner approves origin's URL
```

`rlm_query` review children are read-only. A single `mode=implement` child may
write only after ypi acquires its automatic clean-checkout lease; an already
existing jj repository may use its own isolated workspace. The root reviews the
changed-path report and final diff before acceptance. Never run parallel
implementers.

## You Are The Recursion

When you run under `ypi`, **you are a recursive LLM**. You have `rlm_query` on
your PATH. You can spawn sub-LLMs. Those sub-LLMs can spawn sub-sub-LLMs. This
is not a metaphor — it's your actual execution environment.

This repo builds the infrastructure that makes YOU work. When you modify
`rlm_query`, `SYSTEM_PROMPT.md`, or `ypi`, you are modifying yourself.
Tread carefully, test constantly.

## Meta-Awareness

**Check your depth:**
```bash
echo "I am at depth $RLM_DEPTH of $RLM_MAX_DEPTH"
```

**Know your constraints:**
- At deeper depths, prefer direct answers over spawning more sub-calls
- Your sub-LLMs share the same system prompt and tools you have
- At `RLM_MAX_DEPTH`, the leaf keeps its depth/isolation-appropriate Pi tools but cannot call `rlm_query` again
- Every `rlm_query` call costs time and tokens — be intentional

**Dogfooding rule:** When implementing changes to the recursive infrastructure,
use that same infrastructure to help. Delegate sub-tasks to `rlm_query`. If the
delegation fails, that's a bug you just found.

## Architectural Invariants

Four properties make ypi work. They are covered by focused unit/guardrail gates plus the live E7–E9 probes:

1. **Self-similar runtime, explicit capability modes** — Every depth uses the same canonical ypi prompt, native tool, and runtime. Review is read-only by default; only one root-chartered implementer may receive a writer lease, and descendants cannot escalate it. Ambient third-party extensions are auto-detected at the root: they stay available unless another recursion-extension copy is present (then the launcher isolates, fail closed). Children stay canonical-only unless `RLM_AMBIENT_EXTENSIONS=1` makes that trust boundary intentional. The intelligence remains in decomposition rather than hidden specialized prompts.
2. **Self-hosting** — When the shell helper is enabled (`YPI_SHELL_HELPER=1`, set by the `ypi` wrapper), SECTION 6 includes the thin launcher, canonical runtime core, and CLI adapter. The agent can inspect the machinery it is using without treating the retained legacy fallback as a second owner. A bare `pi -e` / native-tool install omits SECTION 6 and recurses through the native adapter.
3. **Bounded ancestry and observable tree guards** — depth and total child-call admission are bounded by default. Cost is always observational telemetry. An explicit user timeout remains possible, but ypi sets no default timeout and staleness warnings never terminate work. The system prompt adds cognitive pressure: deeper agents prefer direct action.
4. **Symbolic access** — `$CONTEXT` carries external data, delegated children receive their task in `$RLM_PROMPT_FILE`, and hashline provides line-addressed edits. The root wrapper prompt remains a normal Pi user message. Agents grep/sed/cat instead of copying bulk data through model memory. (T14d)

**Don't write static architecture docs.** Encode claims as tests. If a property matters, there should be an E2E test that breaks when it stops being true.

## Troubleshooting — run this first

If recursion misbehaves or `ypi` "seems broken," run `make doctor` before anything else. The #1 cause is a wrong/stale host `pi` — the old `@mariozechner/pi-coding-agent` shadowing `@earendil-works/pi-coding-agent`, or a version below `.pi-version` — which fails silently with no clear signal. `make doctor` names the exact problem and the fix. (This guard exists because that failure cost a full debugging session; it must never be silent again.)

## Project Layout
```
ypi/
├── ypi                    # Launcher: sets up env and starts Pi as RLM
├── rlm_query              # THE recursive bash helper — this is llm_query()
├── SYSTEM_PROMPT.md       # System prompt — teaches the LLM to be recursive
├── AGENTS.md              # This file — instructions for YOU, the agent
├── Makefile               # test-unit, test-guardrails, test-extensions, test-e2e
├── extensions/
│   └── ypi.ts             # Status bar extension — "ypi ∞ depth 0/3"
├── tests/
│   ├── test_unit.sh       # Fast: mock pi, test bash logic (no LLM calls)
│   ├── test_guardrails.sh # Fast: test new features (timeout, routing, etc.)
│   ├── test_extensions.sh # Fast: verify extensions load with installed pi
│   └── test_e2e.sh        # Slow: real LLM calls, costs money
├── scripts/
│   ├── check-upstream     # Test ypi against latest pi release
│   ├── pre-push-checks    # Shared local/CI test gate (fast + extensions)
│   ├── release-preflight  # One-command hooks + checks + upstream dry-run
│   ├── land               # Deterministic-ish landing helper
│   ├── ci-status          # Show recent GitHub Actions runs
│   ├── ci-last-failure    # Print latest failed run logs
│   ├── install-hooks      # Configure core.hooksPath and chmod hook scripts
│   ├── encrypt-prose      # Encrypt .prose/runs/ and .prose/agents/ before push
│   └── decrypt-prose      # Decrypt after clone/pull (symlink to encrypt-prose)
├── .prose/
│   ├── *.prose            # OpenProse programs (public, committed plaintext)
│   ├── runs/              # Execution state (private, encrypted before push)
│   └── agents/            # Persistent agent memory (private, encrypted before push)
├── .pi-version            # Last known-good pi version
├── .sops.yaml             # Age encryption rules
├── .githooks/             # pre-commit + pre-push safety nets for direct git usage
├── .github/workflows/     # CI + upstream compat checks
├── contrib/extensions/    # Extensions not loaded by default (hashline, etc.)
├── experiments/           # Self-experiments (private, encrypted before push)
├── private/               # Sops-encrypted notes (private, encrypted before push)
├── pi-mono/               # Git submodule: upstream Pi coding agent (reference)
└── README.md
```

## Sibling Repos (Reference Implementations)

These repos have features we've ported to bash. Read them for design patterns.

### rlm-cli (`/home/raw/Documents/GitHub/rlm-cli`)
Python CLI wrapping the RLM library. Has:
- **Cost accounting**: cumulative spend/token telemetry without using spend as an admission or stop condition
- **Timeout**: `max_timeout` with wall-clock tracking, propagates `remaining_timeout`
- **Max tokens**: `max_tokens` with aggregate tracking across iterations
- **Max errors**: `max_errors` — consecutive error threshold
- **Model routing**: `other_backends` — use a different (cheaper) model for sub-calls
- **Graceful exit**: SIGUSR1 handler, returns `_best_partial_answer`
- **Structured errors**: `CliError` hierarchy with `why`, `fix`, `try_steps`
- **Execution summary**: Per-depth stats (calls, cost, duration)

Key files: `rlm/rlm/core/rlm.py` (budget/timeout/subcall logic),
`src/rlm_cli/rlm_adapter.py` (error handling), `src/rlm_cli/live_tree.py`

## Development Workflow

### Before ANY change to rlm_query:
```bash
make test-unit          # Must pass — this is your safety net
```

### After each feature:
```bash
make test-fast          # unit + guardrails (seconds, free)
make test-e2e           # real LLM calls (minutes, costs money)
```

### Before pushing to GitHub:
```bash
make pre-push-checks       # same gate used by CI
```

`make land` validates and pushes the current feature branch only to an owned
`origin`; it never releases, tags, or mutates a non-owned remote. Release and
non-owned-remote work require separate explicit user requests and are not
suggested proactively.
Install local hooks once per clone:
```bash
make install-hooks
```
This sets `core.hooksPath=.githooks` so `pre-push` runs automatically.

CI helpers:
```bash
make ci-status N=15
make ci-last-failure
```

### The recursive test:
After modifying rlm_query, verify YOU still work:
```bash
echo "2+2=" | rlm_query "What is the answer? Just the number."
# Should return: 4
```

If that breaks, you broke yourself. Revert.

### Bounded recursive development

For large, proof-bound, or self-hosting changes, follow
`docs/bounded-recursive-development.md` before the first child call. Use its
single persisted trace/counter/cost envelope, three disjoint reviewers, one
implementation head, continuation-without-reset rule, and freeze-before-live-model
gate. Do not improvise extra review waves or hand-roll parity lane environments.
The existing `.prose/recursive-development.prose` workflow is lightweight and
does not own proof-bound recursion.

### Running experiments and evals
**NEVER block the main conversation waiting for a script to finish.**
- Launch in tmux with a sentinel: `tmux send-keys -t eval:name 'command; echo done > /tmp/ypi-signal-name' Enter`
- The `notify-done` extension wakes you automatically — do NOT `sleep`/poll/`capture-pane` in a loop
- Use `uv run` for Python scripts that need dependencies
- Run A/B conditions **concurrently** in separate tmux windows, not sequentially

### Self-experimentation
You are ypi. When you're unsure whether a feature helps or hurts, **test it on yourself.** Write a small A/B experiment in `experiments/`, run both conditions with `rlm_query`, and measure. Negative results are results — don't keep features out of sunk-cost loyalty. See `.prose/self-experiment.prose` for the workflow.

### Reading session history
Use `rlm_sessions` to inspect what you or other agents have done:
```bash
rlm_sessions                     # List all sessions for this project
rlm_sessions --trace             # List only sessions from current recursive tree
rlm_sessions read --last         # Read most recent session transcript
rlm_sessions read <filename>     # Read a specific session
rlm_sessions grep "pattern"      # Search across all sessions
rlm_sessions grep -t "pattern"   # Search only current trace
```

Common patterns:
```bash
# What is a background ypi doing right now?
rlm_sessions read --last | tail -20

# What did a sub-agent find?
rlm_sessions --trace
rlm_sessions read <trace-file> | tail -20

# Did any previous agent work on X?
rlm_sessions grep "feature-name"
```

Set `RLM_SHARED_SESSIONS=0` to disable session sharing (full isolation).

### Starting a feature branch:
```bash
git status --short --branch
git switch -c feat-description
# ... do work and validate ...
git add <scoped-paths>
git commit -m "feat: final description"
scripts/validate-push-owner "$(git remote get-url --push origin)"
git push -u origin HEAD
```

## Editing rlm_query Safely

`rlm_query` is a live dependency of your own execution. Modifying it mid-session
is like performing surgery on your own brain.

**Safe pattern:**
1. Copy: `cp rlm_query rlm_query.bak`
2. Edit: make changes to `rlm_query`
3. Test: `make test-unit` (uses mock pi, safe)
4. Smoke: `echo "test" | rlm_query "Echo this back"` (real call, verifies you still work)
5. If broken: `cp rlm_query.bak rlm_query`

**Never** modify `rlm_query` and `SYSTEM_PROMPT.md` in the same commit without
testing between changes. One variable at a time.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CONTEXT` | Path to context file on disk | (required for QA) |
| `RLM_DEPTH` | Current recursion depth | `0` |
| `RLM_MAX_DEPTH` | Maximum recursion depth | `3` |
| `RLM_PROVIDER` | LLM provider override for root + sub-calls; otherwise seeded from Pi's active/root provider | Pi settings/active model |
| `RLM_MODEL` | LLM model override for root + sub-calls; otherwise seeded from Pi's active/root model | Pi settings/active model |
| `RLM_THINKING_LEVEL` | Thinking level propagated to child calls; otherwise seeded from Pi's active/root thinking level | Pi settings/active thinking |
| `RLM_SYSTEM_PROMPT` | Path to system prompt file | package-owned default |
| `RLM_PROMPT_FILE` | Exact current child charter | auto-created |
| `RLM_ROOT_PROMPT_FILE` | Exact active root human request in extension sessions; standalone shell calls fall back to the first delegation charter | auto-created per tree |
| `PI_TRACE_FILE` | Private lifecycle trace path | automatic per tree |
| `RLM_TIMEOUT` | Max wall-clock seconds | (none = unlimited) |
| `RLM_START_TIME` | Epoch seconds when the current depth-0 tree began | (auto-set per top-level call) |
| `RLM_MAX_CALLS` | Max total rlm_query invocations (permits 1..N, rejects N+1) | `128` |
| `RLM_CALL_COUNT` | Running count of calls so far | `0` |
| `RLM_CHILD_MODEL` | Model override for all child depths | (none = same as parent/root route) |
| `RLM_CHILD_PROVIDER` | Provider override used with `RLM_CHILD_MODEL` | (none = same as parent/root route) |
| `RLM_CHILD_THINKING_LEVEL` | Thinking override for all child depths | (none = same as parent/root thinking) |
| `RLM_CHILD_MODELS` | Comma-separated per-child-depth model route, depth 1,2,... | (none) |
| `RLM_CHILD_PROVIDERS` | Comma-separated per-child-depth provider route, depth 1,2,... | (none) |
| `RLM_CHILD_THINKING_LEVELS` | Comma-separated per-child-depth thinking route, depth 1,2,... | (none) |
| native `rlm_query` `mode` | `review` is read-only; `implement` requests one automatic exclusive writer | `review` |
| `RLM_COST_FILE` | Private append-only cost/token telemetry ledger | automatic per tree |
| `RLM_SHARED_SESSIONS` | Allow child agents to write trace-named Pi sessions | `1` (set `0` for `--no-session`) |
| `RLM_CHILD_DISCOVERY` | Set to `0` to disable child Pi non-extension skill/template/theme/context/approval discovery; with `RLM_CHILD_EXTENSIONS=0`, use a private Pi agent/config root and offline resolution while preserving Pi's shipped package assets | enabled by default |
| `RLM_AMBIENT_EXTENSIONS` | Root ambient-extension policy: `auto` allows ambient extensions unless `scripts/detect-ambient-recursion-conflict` finds another recursion-extension copy; `1` always allows (accepts duplicate-copy risk); `0` always isolates. Children treat anything but `1` as canonical-only | `auto` |
| `YPI_SHELL_HELPER` | Expose the shell `rlm_query` helper (its dir on `PATH` + its source in the prompt); the `ypi` wrapper sets this | `0` (a bare `pi -e` / npm install uses the native tool only) |

## Bugs We've Found (and must not re-introduce)

### 1. False stdin detection in CI (`[ -p /dev/stdin ]` can be true with empty input)
**Symptom**: Context is empty in sub-calls (T2/T4 failures in GitHub Actions).
**Cause**: Some CI shells expose stdin as a pipe inside `$(...)` even when nothing is piped.
`cat > "$CHILD_CONTEXT"` reads empty stdin and overwrites inherited context.
**Fix**: Prefer explicit `RLM_STDIN`; when pipe-read is empty and `RLM_STDIN` is unset,
fall back to inherited `CONTEXT`.
**Test**: T2/T4 (inherit), T3 (real pipe), CI run parity via `scripts/pre-push-checks`.

### 2. System prompt as shell arg vs file path
**Symptom**: Shell escaping nightmares, ARG_MAX errors.
**Cause**: `cat`-ing the system prompt into a shell variable.
**Fix**: Pass the file path; Pi's `resolvePromptInput()` reads it.
**Test**: T8, T9 verify file path passing.

### 3. System prompt too aggressive about recursion
**Symptom**: Model calls rlm_query on 11-line contexts, creating infinite chains.
**Fix**: "Check context size first, read directly if small."
**Test**: E1 (small context, should answer directly without sub-calls).

### 4. `RLM_MAX_CALLS` off-by-one (the Nth call was blocked)
**Symptom**: `RLM_MAX_CALLS=1` allowed zero calls; the budget under-counted by one.
**Cause**: the call count is allocated 1-based, but the guard used `>=` / `-ge`, rejecting call N.
**Fix**: reject only when the count exceeds the limit (`>` native, `-gt` shell) in both `native-tool.ts` and `rlm_query`.
**Test**: N2 (native harness), G8/G8b (guardrails).

### 5. Unsanitized trace IDs in session/temp filenames
**Symptom**: a hostile `RLM_TRACE_ID` (e.g. `../../x`) could traverse out of the session directory.
**Cause**: the raw `RLM_TRACE_ID` was interpolated into the child session filename and async job ID.
**Fix**: normalize `RLM_TRACE_ID` in place (`safe_trace_id` / `safeTraceId`) before any path use; also sanitize at the native filename site.
**Test**: N13 (native harness), G52 (guardrails).

### 6. Stale `RLM_START_TIME` on a long-running root Pi
**Symptom**: after a root Pi session was open longer than `RLM_TIMEOUT`, every `rlm_query` immediately "timed out."
**Cause**: the extension froze `RLM_START_TIME` at session start instead of when a recursion tree begins.
**Fix**: anchor `RLM_START_TIME` at each depth-0 call (native tool + shell); the extension no longer seeds it at load.
**Test**: N3/N12 (native harness), G4/G16 (guardrails).

### 7. Async `--notify` wrote invalid JSON; async temp files ignored `TMPDIR`
**Symptom**: child output with quotes/newlines/backslashes produced malformed peer-inbox JSONL; async temp files were hardcoded to `/tmp`.
**Cause**: raw string interpolation into the JSON message; `ASYNC_OUTPUT`/`ASYNC_SENTINEL` ignored `${TMPDIR:-/tmp}`.
**Fix**: build the inbox line with `python3 json.dumps`; honor `${TMPDIR:-/tmp}`.
**Test**: G53 (guardrails).

### 8. Provider env allowlist drift from upstream Pi (incl. a blind completeness test)
**Symptom**: a recursive child could not authenticate where the parent could — for env-var-only
auth on github-copilot (`COPILOT_GITHUB_TOKEN`) and huggingface (`HF_TOKEN`). The native tool's
`buildChildEnvironment` forwards only an allowlist, and both names were missing. A regression
versus master, which used no allowlist and inherited the full ambient env.
**Cause (two layers)**: (1) the hand-maintained allowlist drifted from Pi's provider env vars;
(2) the first completeness test only matched names ending in `_API_KEY`/`_OAUTH_TOKEN`, so it was
structurally blind to `COPILOT_GITHUB_TOKEN` / `HF_TOKEN` and passed despite the real gap.
**Fix**: added both names to the native + shell allowlists, and rewrote the completeness check to
derive the credential set from pi-mono's `getApiKeyEnvVars()` (the source of truth) by extracting
the actual env var NAMES — suffix-agnostic, so it can never go blind to a new provider name.
**Lesson**: a self-validating test must derive from the source of truth, not a guessed pattern;
a pattern-based "completeness" check gives false confidence.
**Test**: `tests/test_provider_allowlist.sh` (P1/P2 parity, P3 populated, C1 completeness derived
from `getApiKeyEnvVars()` in pinned pi-mono).

### Secrets & Encryption
Files in `private/`, `experiments/`, `.prose/runs/`, and `.prose/agents/` are encrypted with
[sops](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age)
before push. They live **plaintext on disk** so agents and editors can read them.

```bash
# Before pushing (MANDATORY)
scripts/encrypt-prose
scripts/validate-push-owner "$(git remote get-url --push origin)"
git push origin HEAD

# After cloning or pulling
scripts/decrypt-prose

# Check if anything needs encrypting
scripts/encrypt-prose --check
```

**Never push without encrypting first.** The Git hooks enforce the local safety
checks; the pre-push hook also blocks non-owned remote URLs independently of the
quality-check skip flag.

### OpenProse Programs

`.prose/*.prose` files are public workflow programs committed in plaintext.
Execution state (`.prose/runs/`, `.prose/agents/`) is private — encrypt before push.

```bash
# Run a prose program
rp pi .prose/check-upstream.prose

# Or via the bash script directly
scripts/check-upstream
```
