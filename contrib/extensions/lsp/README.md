# pi-lsp

LSP extension for [Pi](https://github.com/earendil-works/pi) — compiler-grade code intelligence via Language Server Protocol.

## Install

```bash
# Copy to Pi's extensions directory
git clone https://github.com/rawwerks/pi-lsp.git ~/.pi/agent/extensions/lsp
cd ~/.pi/agent/extensions/lsp && bun install
```

That's it. Pi auto-discovers extensions in `~/.pi/agent/extensions/`.

## What it does

Registers an `lsp` tool that the LLM can call for code intelligence:

| Action | Description |
|--------|-------------|
| `diagnostics` | Get errors/warnings for files |
| `references` | Find all references to a symbol |
| `definition` | Go to definition |
| `rename` | Smart rename across codebase |
| `actions` | List/apply code actions and refactorings |
| `hover` | Get type info and documentation |
| `symbols` | List symbols in a file |
| `workspace_symbols` | Search symbols across workspace |

### Rust-analyzer specific

| Action | Description |
|--------|-------------|
| `flycheck` | Run clippy/check |
| `expand_macro` | Expand macro at cursor |
| `ssr` | Structural search-replace |
| `runnables` | List tests/binaries |
| `related_tests` | Find tests for a function |
| `reload_workspace` | Reload Cargo.toml |

## Auto-detection

The extension auto-detects language servers based on project markers and installed binaries:

| Language | Server | Root markers | Install |
|----------|--------|-------------|---------|
| Rust | `rust-analyzer` | `Cargo.toml` | `rustup component add rust-analyzer` |
| TypeScript/JS | `typescript-language-server` | `package.json`, `tsconfig.json` | `npm i -g typescript-language-server typescript` |
| Go | `gopls` | `go.mod` | `go install golang.org/x/tools/gopls@latest` |
| Python | `pylsp` | `pyproject.toml`, `setup.py` | `pip install python-lsp-server` |
| Zig | `zls` | `build.zig` | [zigtools/zls](https://github.com/zigtools/zls) |
| C/C++ | `clangd` | `compile_commands.json` | Package manager |
| Lua | `lua-language-server` | `.luarc.json` | [LuaLS](https://github.com/LuaLS/lua-language-server) |

## Configuration

Override or add servers via `~/.pi/lsp.json` or `.pi/lsp.json`:

```json
{
  "rust": {
    "command": "rust-analyzer",
    "fileTypes": [".rs"],
    "rootMarkers": ["Cargo.toml"],
    "initOptions": {
      "checkOnSave": { "command": "clippy" }
    }
  },
  "ocaml": {
    "command": "ocamllsp",
    "fileTypes": [".ml", ".mli"],
    "rootMarkers": ["dune-project"]
  }
}
```

## ypi / recursive agents

When used with [ypi](https://github.com/rawwerks/ypi) (recursive Pi), the extension checks `RLM_DEPTH` and only registers at depth 0. Child agents skip it — no wasted tokens, no server spawns.

## Credits

Ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `@oh-my-pi/lsp` plugin (MIT, can1357) to Pi's native `registerTool()` extension API.
