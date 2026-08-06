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
# pi-provider-kiro is required: without it no kiro/* model resolves.
#
# SWAPPED from `npm:pi-provider-kiro` to a git install of my fork, to fix omp
# effort selection. The npm release (0.9.3) registers kiro models through
# `pi.registerProvider(...)`, which omp's models.yml `modelOverrides` merge
# never revisits -- so no config can bolt a thinking ladder onto them, and
# Shift+Tab has nothing to cycle. The fork derives each model's effort levels
# from Kiro's authenticated catalog and emits omp's `thinking` config on the
# descriptors it registers. Upstream PR is open, not merged:
# https://github.com/mikeyobrien/pi-provider-kiro/pull/109
# Drop the fork for `npm:pi-provider-kiro` once that lands in a release.
#
# Pinned to the branch, not a SHA, so re-running picks up PR review fixes.
#
# Entries are `<marker>|<spec>`. The marker is matched against the dependency
# *source* in plugins/package.json, not `omp plugin list` -- list prints the
# resolved name (`pi-provider-kiro`) identically for the npm release and the
# fork, so it cannot tell them apart. Matching the source catches a machine
# still on npm and corrects it.
for entry in \
  'christian-auguste/pi-provider-kiro|github:christian-auguste/pi-provider-kiro#fix/omp-thinking-config' \
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

step "Manual steps left"
cat <<'EOF'
  1. Authenticate Kiro: a logged-in kiro-cli session is picked up
     automatically, otherwise run /login kiro inside omp.
  2. Decide tools.approvalMode. It ships as `yolo` (auto-approves everything);
     `write` prompts on shell commands.
  3. `cd ~/dotfiles && stow omp` -- carries AGENTS.md, which omp reads but never
     rewrites. config.yml is excluded on purpose: omp rewrites it atomically and
     a rename would replace the symlink with a real file.
  4. Pick a session model with Alt+P. Alt+M writes modelRoles into config.yml.
EOF

printf '\n%s✓ Done.%s Verify with: omp config list | head -40\n' "$G$B" "$X"
