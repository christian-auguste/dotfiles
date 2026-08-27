#!/usr/bin/env bash
# Apply my omp settings on a new machine. Idempotent, safe to re-run.
#
# Run AFTER launching `omp` once: the setup wizard writes config.yml, which
# this script edits in place (overwriting it drops wizard bookkeeping and can
# re-trigger onboarding). Sets only values that differ from schema defaults;
# never deletes keys. Arrays/records must be passed as one JSON argument.

set -uo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; B=$'\033[1m'; X=$'\033[0m'
else G=; Y=; C=; B=; X=; fi
step() { printf '\n%s==>%s %s\n' "$C$B" "$X" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*" >&2; }

command -v omp >/dev/null 2>&1 || { warn "omp not on PATH — install it first (brew install can1357/tap/omp)"; exit 1; }
command -v bun >/dev/null 2>&1 || warn "bun not on PATH — 'omp install' will fail without it"

# Pin config to where a login shell reads it.
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

step "Safety"
# pi-os-sandbox replaces the destructive-guard extension; bash children route
# through its env-scrubbing wrapper via shellPath.
sandbox_src="$HOME/dotfiles/omp/pi-os-sandbox"
sandbox_ext="$HOME/.omp/agent/extensions/pi-os-sandbox.ts"
sandbox_wrapper="$sandbox_src/bin/sandbox-bash"
if [ ! -f "$sandbox_src/package.json" ]; then
  warn "pi-os-sandbox missing at $sandbox_src — safety swap skipped"
else
  # Swap the legacy guard for the new adapter, then route bash through the seam.
  if [ -e "$HOME/.omp/agent/extensions/destructive-guard.ts" ]; then
    rm -f "$HOME/.omp/agent/extensions/destructive-guard.ts"
    ok "removed legacy destructive-guard extension"
  else
    ok "legacy destructive-guard already removed"
  fi
  if [ ! -L "$sandbox_ext" ] || [ "$(readlink "$sandbox_ext")" != "$sandbox_src/extensions/omp.ts" ]; then
    ln -sfn "$sandbox_src/extensions/omp.ts" "$sandbox_ext"
    ok "linked pi-os-sandbox extension"
  else
    ok "pi-os-sandbox extension already linked"
  fi
  set_cfg shellPath "$sandbox_wrapper"
  cat <<'EOF'
  pi-os-sandbox is active: command policy + host path protection + env
  scrubbing at the child boundary. To add OMP's second eval defense without
  replacing other per-tool policies, run once:
    omp config set tools.approval '{"eval":"prompt"}'
EOF
fi

step "Models"
# No numbered roles or Ctrl+P cycling; Shift+Tab cycles thinking level instead.
set_cfg cycleOrder '[]'

step "Appearance"
# theme.dark is not set here: titanium is already omp's default.
set_cfg theme.light light-gruvbox
set_cfg symbolPreset nerd     # needs a nerd font in the terminal

step "Plugins"
# Entries are `<marker>|<spec>`; the marker matches the dependency *source* in
# plugins/package.json, not the resolved name `omp plugin list` prints.
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
# OMP discovers installed language servers from its built-in defaults.

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
