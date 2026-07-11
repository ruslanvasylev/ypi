#!/bin/bash
# ypi installer — one-line install:
#   curl -fsSL https://raw.githubusercontent.com/rawwerks/ypi/master/install.sh | bash
#
# Installs ypi + Pi coding agent. Requires: Node.js >= 22.19, bun (or npm), git, bash.
# Optional: jj (for workspace isolation), sops + age (for encrypted notes)

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${GREEN}▸${RESET} $1"; }
warn()  { echo -e "${RED}▸${RESET} $1"; }
dim()   { echo -e "${DIM}  $1${RESET}"; }

# ── Check prerequisites ──────────────────────────────────────────────────

MISSING=""
command -v git &>/dev/null || MISSING="$MISSING git"
command -v bash &>/dev/null || MISSING="$MISSING bash"
command -v node &>/dev/null || MISSING="$MISSING node"

if [ -n "$MISSING" ]; then
    warn "Missing required tools:$MISSING"
    exit 1
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    warn "Node.js >= 22.19 is required for the canonical recursion runtime (found $NODE_VERSION)"
    exit 1
fi

# Need npm or bun for Pi
HAS_NPM=false
HAS_BUN=false
command -v npm &>/dev/null && HAS_NPM=true
command -v bun &>/dev/null && HAS_BUN=true

if [ "$HAS_NPM" = false ] && [ "$HAS_BUN" = false ]; then
    warn "Need npm or bun to install Pi. Install Node.js: https://nodejs.org"
    exit 1
fi

# ── Clone ypi ────────────────────────────────────────────────────────────

INSTALL_DIR="${YPI_DIR:-$HOME/.ypi}"

if [ -d "$INSTALL_DIR" ]; then
    info "Updating ypi at $INSTALL_DIR..."
    cd "$INSTALL_DIR"
    git pull --quiet
    git submodule update --init --depth 1 --quiet
else
    info "Cloning ypi to $INSTALL_DIR..."
    git clone --quiet https://github.com/rawwerks/ypi.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    git submodule update --init --depth 1 --quiet
fi

# Install the exact Pi/runtime dependency versions declared by this checkout.
# A global PATH Pi may coexist, but ypi deliberately resolves this local copy first.
info "Installing pinned ypi runtime dependencies..."
if [ "$HAS_BUN" = true ]; then
    bun install --production --frozen-lockfile
else
    npm install --omit=dev --ignore-scripts
fi
if [ ! -x "$INSTALL_DIR/node_modules/.bin/pi" ]; then
    warn "Pinned Pi dependency was not installed at $INSTALL_DIR/node_modules/.bin/pi"
    exit 1
fi
dim "Pinned Pi dependency: $($INSTALL_DIR/node_modules/.bin/pi --version 2>/dev/null | head -1 || echo 'installed')"

# ── Add to PATH ──────────────────────────────────────────────────────────

SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
RC_FILE=""

case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish"
          EXPORT_LINE="set -gx PATH $INSTALL_DIR \$PATH" ;;
    *)    RC_FILE="$HOME/.profile" ;;
esac

if [ -n "$RC_FILE" ] && ! grep -qF "$INSTALL_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# ypi — recursive coding agent" >> "$RC_FILE"
    echo "$EXPORT_LINE" >> "$RC_FILE"
    info "Added to PATH in $RC_FILE"
    dim "Run: source $RC_FILE   (or open a new terminal)"
else
    dim "Already in PATH"
fi

# ── Set up git hooks ────────────────────────────────────────────────────

cd "$INSTALL_DIR"
git config core.hooksPath .githooks 2>/dev/null || true

# ── Report optional tools ───────────────────────────────────────────────

echo ""
info "ypi installed! ✓"
echo ""
dim "Required:"
command -v pi &>/dev/null && dim "  ✓ pi ($(which pi))" || dim "  ✗ pi"
echo ""
dim "Optional:"
command -v jj &>/dev/null && dim "  ✓ jj (workspace isolation)" || dim "  · jj — install for workspace isolation: https://martinvonz.github.io/jj/"
echo ""
echo -e "${BOLD}Get started:${RESET}"
echo "  ypi                    # interactive"
echo "  ypi \"What does this repo do?\"   # one-shot"
echo ""
