# contrib/

Community and optional extensions. **Nothing here is required to use ypi.**

ypi is a recursive Pi launcher — it doesn't bundle or manage Pi extensions.
Pi's own auto-discovery (`~/.pi/agent/extensions/`) handles extension loading
for both interactive sessions and rlm_query children.

## Extensions

These are Pi extensions we find useful alongside ypi. Install single-file
extensions by symlinking, directory extensions by copying:
```bash
# Single-file extension (symlink)
ln -s "$(pwd)/contrib/extensions/hashline.ts" ~/.pi/agent/extensions/hashline.ts
# Directory extension with npm deps (copy + install)
cp -r contrib/extensions/lsp ~/.pi/agent/extensions/lsp
cd ~/.pi/agent/extensions/lsp && bun install
```

### dirpack.ts

Runs `dirpack pack` on session start and injects a compact repo index into
the system prompt. Gives the agent an instant map of the entire codebase —
file structure, function signatures, key types — without reading every file.

Requires [dirpack](https://github.com/rawwerks/dirpack) on PATH.

```bash
ln -s "$(pwd)/contrib/extensions/dirpack.ts" ~/.pi/agent/extensions/dirpack.ts
```

### auto-title.ts

Periodically summarizes the session into a short window title. After a
configurable number of turns or elapsed time, forks the conversation to
a cheap `pi -p` call and sets the result as the terminal title and tmux
window name. Stale sessions (no new turns) don't re-summarize.

```bash
ln -s "$(pwd)/contrib/extensions/auto-title.ts" ~/.pi/agent/extensions/auto-title.ts
```

Configuration:
| Env var | Default | Description |
|---|---|---|
| `AUTO_TITLE_DISABLE` | `0` | Set to `1` to disable |
| `AUTO_TITLE_TURNS` | `5` | Turns between re-summarizations |
| `AUTO_TITLE_INTERVAL` | `300` | Seconds between time-based re-summarizations |
| `AUTO_TITLE_INITIAL_TURNS` | `2` | Turns before first summarization |
| `AUTO_TITLE_MODEL` | `claude-sonnet-4-20250514` | Model for summary calls |
| `AUTO_TITLE_PREFIX` | `π` | Prefix for terminal title |

### colgrep.ts

Adds semantic code search via [colgrep](https://github.com/lightonai/next-plaid/tree/main/colgrep).
Pre-warms the ColBERT index on session start and injects usage instructions
into the system prompt so the agent uses `colgrep` as its primary search tool
instead of grep.

Requires `colgrep` on PATH.

```bash
ln -s "$(pwd)/contrib/extensions/colgrep.ts" ~/.pi/agent/extensions/colgrep.ts
```

### hashline.ts

Line-addressed editing with content hashes. Overrides Pi's `read` and `edit`
tools so every line is tagged `LINE:HASH|CONTENT`. Edits reference hashes
instead of requiring exact text match, catching stale-file errors before
they corrupt anything.

Ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) by can1357.

```bash
ln -s "$(pwd)/contrib/extensions/hashline.ts" ~/.pi/agent/extensions/hashline.ts
```

### lsp/

Compiler-grade code intelligence via Language Server Protocol. Registers an
`lsp` tool that the LLM can call for diagnostics, go-to-definition,
find-references, rename, hover, symbols, code actions, and more.
Auto-detects language servers (rust-analyzer, typescript-language-server,
gopls, pylsp, zls, clangd, lua-language-server) based on project markers.

Ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `@oh-my-pi/lsp` plugin by can1357.

This is a directory extension (has npm dependencies), so copy + install:

```bash
cp -r contrib/extensions/lsp ~/.pi/agent/extensions/lsp
cd ~/.pi/agent/extensions/lsp && bun install
```

Requires at least one language server on PATH. The extension is **depth-aware**:
it only registers at `RLM_DEPTH=0`, so recursive children skip it (no wasted
tokens, no server spawns).

### treemap.ts

Appends a repository tree overview to the system prompt so the agent always
has a map of the codebase. Uses `eza --tree` if available, falls back to `find`.

Some people "prime" their agents by pasting `eza --tree` output at the start
of a session. This extension automates that — the tree is generated once per
session and appended to every turn's system prompt.

```bash
ln -s "$(pwd)/contrib/extensions/treemap.ts" ~/.pi/agent/extensions/treemap.ts
```

Configuration:
| Env var | Default | Description |
|---|---|---|
| `TREEMAP_DEPTH` | `3` | Tree depth |
| `TREEMAP_CMD` | auto-detect | Custom command (overrides eza/find) |
| `TREEMAP_DISABLE` | `0` | Set to `1` to disable |

## Uninstalling

Remove the symlink or directory from `~/.pi/agent/extensions/`:
```bash
rm ~/.pi/agent/extensions/<extension>.ts
# or for directory extensions:
rm -r ~/.pi/agent/extensions/lsp/
```
