#!/bin/sh
# Installs the brain CLI:  curl -fsSL https://brain.yashlunawat.com/cli/install.sh | sh
set -eu

BRAIN_URL="${BRAIN_URL:-https://brain.yashlunawat.com}"
BIN_DIR="${BRAIN_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${BRAIN_LIB_DIR:-$HOME/.local/share/brain}"

die() { echo "brain install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 20 or newer is required (https://nodejs.org)"
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$major" -ge 20 ] 2>/dev/null || die "Node.js 20 or newer is required; found $(node --version 2>/dev/null || echo none)"

mkdir -p "$BIN_DIR" "$LIB_DIR"
tmp="$LIB_DIR/.brain-download-$$.mjs"
trap 'rm -f "$tmp"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BRAIN_URL/cli/brain.mjs" -o "$tmp" || die "download failed from $BRAIN_URL/cli/brain.mjs"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$BRAIN_URL/cli/brain.mjs" || die "download failed from $BRAIN_URL/cli/brain.mjs"
else
  die "curl or wget is required"
fi

head -n 1 "$tmp" | grep -q '^#!/usr/bin/env node' || die "the download is not the brain CLI (check BRAIN_URL)"
node --check "$tmp" 2>/dev/null || die "the downloaded CLI does not parse on Node $(node --version)"

# The real file keeps its .mjs name so Node always loads it as an ES module; bin/brain is a symlink.
chmod 755 "$tmp"
mv "$tmp" "$LIB_DIR/brain.mjs"
ln -sf "$LIB_DIR/brain.mjs" "$BIN_DIR/brain"

echo "brain $("$BIN_DIR/brain" --version) installed at $BIN_DIR/brain"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add it to your PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   (or ~/.bashrc)" ;;
esac
echo "Next:  brain login && brain apply   (one approval in the console, one key per coding agent)"
