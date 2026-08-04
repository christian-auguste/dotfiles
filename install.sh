#!/usr/bin/env bash
# Idempotent setup for these dotfiles. Safe to re-run. macOS or Linux.
# No `set -e`: each step is handled individually so one failure degrades to a
# warning and the rest still runs. Set NO_COLOR=1 for plain output.
set -uo pipefail

# --- output helpers (auto-degrade to plain text when not a TTY) ---
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else
  B=; R=; G=; Y=; C=; X=
fi
WARN=0
step() { printf '\n%s==>%s %s\n' "$C$B" "$X" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*" >&2; WARN=$((WARN + 1)); }
die()  { printf '  %s✗%s %s\n' "$R" "$X" "$*" >&2; exit 1; }

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
step "Platform: $(uname -s) $(uname -m)  |  dotfiles: $DOTFILES"

# 1. Homebrew (hard requirement)
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew present ($(brew --version | head -1))"
else
  step "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew install failed — see output above"
fi
for p in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
  [ -x "$p" ] && eval "$("$p" shellenv)" && break
done
command -v brew >/dev/null 2>&1 || die "brew not on PATH after install"

# 2. Packages (casks/fonts auto-skip on Linux via the Brewfile's OS.mac? guard)
step "Installing packages from Brewfile"
if brew bundle --file="$DOTFILES/Brewfile"; then
  ok "Brewfile satisfied"
else
  warn "Some Brewfile entries failed (e.g. an internal-tap or unavailable formula). Continuing."
fi

# 3. Directories the zsh config expects
step "Creating XDG directories"
if mkdir -p ~/.local/state/zsh ~/.cache/zsh; then ok "state + cache dirs ready"; else warn "could not create XDG dirs"; fi

# 4. Stow — per package, conflicts warn instead of aborting
step "Stowing packages"
cd "$DOTFILES"
if command -v stow >/dev/null 2>&1; then
  for pkg in */; do
    pkg="${pkg%/}"
    err_file="$(mktemp)"
    if stow --restow "$pkg" 2>"$err_file"; then
      ok "stow $pkg"
    else
      warn "stow $pkg: $(tr '\n' ' ' <"$err_file" | sed 's/  */ /g')"
    fi
    rm -f "$err_file"
  done
else
  warn "stow not installed (Brewfile step failed?) — skipping symlinks"
fi

# 5. tmux plugin manager
step "tmux plugin manager (TPM)"
if [ -d ~/.tmux/plugins/tpm ]; then
  ok "TPM already present"
elif git clone -q https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm; then
  ok "TPM cloned"
else
  warn "TPM clone failed"
fi

# Summary
if [ "$WARN" -eq 0 ]; then
  printf '\n%s✓ Done — no warnings.%s Open tmux and press `\140` then %sI%s to install plugins.\n' "$G$B" "$X" "$B" "$X"
else
  printf '\n%s⚠ Done with %d warning(s).%s Review the lines above; the rest completed.\n' "$Y$B" "$WARN" "$X"
fi
