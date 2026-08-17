#!/usr/bin/env bash
# Apply my omp settings on a new machine. Idempotent, safe to re-run.
#
# Run AFTER launching `omp` once: the setup wizard writes config.yml (including
# setupVersion and dev.autoqaConsent), and this script edits that file in place
# rather than replacing it. Overwriting config.yml wholesale drops the wizard's
# bookkeeping and can re-trigger onboarding.
#
# Sets only what differs from omp's schema defaults; everything else is left
# unset on purpose so it resolves from the schema at read time. Never deletes:
# `omp config set` cannot express absence and `reset` writes the default in, so
# keys omp or the TUI add on their own come out by hand from config.yml.
# Arrays and records must be passed as one JSON argument.
# disabledProviders is deliberately not set -- that call is per-machine.

set -uo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; B=$'\033[1m'; X=$'\033[0m'
else G=; Y=; C=; B=; X=; fi
step() { printf '\n%s==>%s %s\n' "$C$B" "$X" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*" >&2; }

command -v omp >/dev/null 2>&1 || { warn "omp not on PATH — install it first (brew install can1357/tap/omp)"; exit 1; }
command -v bun >/dev/null 2>&1 || warn "bun not on PATH — 'omp install' will fail without it"

# omp keeps tap trust and config under XDG_CONFIG_HOME; pin it so this script
# writes where an interactive login shell will read.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

set_cfg() {  # set_cfg <key> <value>
  local key="$1" val="$2"
  if [ "$(omp config get "$key" 2>/dev/null)" = "$val" ]; then
    ok "$key already set"
  elif omp config set "$key" "$val" >/dev/null 2>&1; then
    ok "$key -> $val"
  else
    warn "failed to set $key"
  fi
}

step "Models"
# Empty: no numbered role badges and no Ctrl+P cycling, which suits modelRoles
# staying unset. Shift+Tab cycles thinking level, a separate axis.
set_cfg cycleOrder '[]'

step "Appearance"
# theme.dark is not set here: titanium is already omp's default.
set_cfg theme.light light-gruvbox
set_cfg symbolPreset nerd     # needs a nerd font in the terminal

step "Plugins"
# pi-provider-kiro was removed: the reasoning-effort fix has merged upstream
# (mikeyobrien/pi-provider-kiro#109) and kiro is no longer used, so neither
# the fork nor the npm release is installed.
#
# Entries are `<marker>|<spec>`. The marker is matched against the dependency
# *source* in plugins/package.json, not `omp plugin list`, which prints the
# resolved name identically regardless of how the plugin was installed.
for entry in \
  'DietrichGebert/ponytail|git:github.com/DietrichGebert/ponytail'
do
  marker="${entry%%|*}"; spec="${entry#*|}"; name="${marker##*/}"
  if grep -qF "$marker" "$HOME/.omp/plugins/package.json" 2>/dev/null; then
    ok "$name already installed from ${marker%%/*}"
  elif omp install "$spec" >/dev/null 2>&1; then
    ok "installed $spec"
  else
    warn "failed to install $spec"
  fi
done

step "LSP"
# Register the language servers the Brewfile installs. omp auto-detects these
# built-ins by root marker and PATH, but the explicit user-level config keeps
# the mapping deterministic. Commands are bare binary names, so resolution
# follows PATH and survives brew version bumps (no cellar paths).
lsp_json="$HOME/.omp/agent/lsp.json"
lsp_tmp="$(mktemp)"
cat >"$lsp_tmp" <<'JSON'
{
  "servers": {
    "typescript-language-server": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      "rootMarkers": ["tsconfig.json", "package.json"]
    },
    "basedpyright": {
      "command": "basedpyright-langserver",
      "args": ["--stdio"],
      "fileTypes": [".py"],
      "rootMarkers": ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "requirements.txt"]
    },
    "rust-analyzer": {
      "command": "rust-analyzer",
      "fileTypes": [".rs"],
      "rootMarkers": ["Cargo.toml", ".git"]
    },
    "vscode-html-language-server": {
      "command": "vscode-html-language-server",
      "args": ["--stdio"],
      "fileTypes": [".html", ".htm", ".svg"],
      "rootMarkers": ["package.json", ".git"]
    },
    "vscode-css-language-server": {
      "command": "vscode-css-language-server",
      "args": ["--stdio"],
      "fileTypes": [".css", ".scss", ".less"],
      "rootMarkers": ["package.json", ".git"]
    },
    "vscode-json-language-server": {
      "command": "vscode-json-language-server",
      "args": ["--stdio"],
      "fileTypes": [".json"],
      "rootMarkers": ["package.json", ".git"]
    },
    "eslint": {
      "command": "vscode-eslint-language-server",
      "args": ["--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"],
      "rootMarkers": [".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "package.json"]
    }
  }
}
JSON
if [ -f "$lsp_json" ] && cmp -s "$lsp_json" "$lsp_tmp"; then
  ok "lsp.json already up to date"
  rm -f "$lsp_tmp"
else
  mkdir -p "$(dirname "$lsp_json")"
  mv "$lsp_tmp" "$lsp_json"
  ok "wrote $lsp_json"
fi

step "Manual steps left"
cat <<'EOF'
  1. Decide tools.approvalMode. It ships as `yolo` (auto-approves everything);
     `write` prompts on shell commands.
  2. `cd ~/dotfiles && stow omp` -- carries AGENTS.md, which omp reads but never
     rewrites. config.yml is excluded on purpose: omp rewrites it atomically and
     a rename would replace the symlink with a real file.
  3. Pick a session model with Alt+P. Alt+M writes modelRoles into config.yml.
EOF

printf '\n%s✓ Done.%s Verify with: omp config list | head -40\n' "$G$B" "$X"
