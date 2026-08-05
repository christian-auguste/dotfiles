#!/usr/bin/env bash
# Idempotent setup for these dotfiles. Safe to re-run. macOS or Linux.
# No `set -e`: each step warns on failure so one problem doesn't abort the rest.
# Set NO_COLOR=1 for plain output.
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

# Homebrew keeps its tap-trust store at $XDG_CONFIG_HOME/homebrew/trust.json,
# falling back to ~/.homebrew/trust.json when the var is unset. The zsh block in
# step 7 exports XDG_CONFIG_HOME as ~/.config, so pin the same value here —
# otherwise `brew trust` below writes to ~/.homebrew and the login shell, which
# looks in ~/.config, never sees it.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# --- coexist helpers ---------------------------------------------------------
# Shared shell files (~/.zshenv, ~/.zshrc) are also written to by tools like
# rustup, Homebrew, and nvm. We never replace them; we append one fenced block
# and only ever manage the text between our markers.
BEGIN="# >>> christian dotfiles >>>"
END="# <<< christian dotfiles <<<"

# Portable mtime string (BSD stat on macOS, GNU stat on Linux).
_mtime() { stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" 2>/dev/null || stat -c '%y' "$1" 2>/dev/null | cut -d. -f1; }

# One backup per file at <file>.dotfiles-bak. Made only when the file is about
# to change. If a backup already exists, ask before overwriting (keep = safest,
# it is the pristine original); offer to print it first (bat if present).
# Non-interactive (no TTY): never prompt, keep the existing backup.
backup_file() {
  local file="$1" bak="$1.dotfiles-bak" a
  [ -e "$file" ] || return 0
  if [ -e "$bak" ]; then
    warn "$(basename "$file"): backup already exists ($(_mtime "$bak"))"
    if [ ! -t 0 ]; then ok "kept existing backup (non-interactive)"; return; fi
    read -r -p "    [p]rint it, [o]verwrite, or [k]eep existing (default)? " a
    if [ "$a" = p ] || [ "$a" = P ]; then
      printf '%s----- %s -----%s\n' "$C$B" "$bak" "$X"
      if command -v bat >/dev/null 2>&1; then bat --style=plain --paging=never "$bak"; else cat "$bak"; fi
      read -r -p "    now [o]verwrite or [k]eep (default)? " a
    fi
    if [ "$a" = o ] || [ "$a" = O ]; then cp -p "$file" "$bak"; ok "backup overwritten"; else ok "kept existing backup"; fi
  else
    cp -p "$file" "$bak" && ok "backed up -> $(basename "$bak")"
  fi
}

# Append a fenced block to a shared file. Idempotent: if our marker is already
# present, do nothing (no backup, no change). Otherwise back up, then append.
append_block() {
  local file="$1" body="$2"
  if grep -qF "$BEGIN" "$file" 2>/dev/null; then
    ok "$(basename "$file"): dotfiles block already present"
    return
  fi
  backup_file "$file"
  printf '\n%s\n%s\n%s\n' "$BEGIN" "$body" "$END" >> "$file"
  ok "appended dotfiles block to $(basename "$file")"
}
# ----------------------------------------------------------------------------

step "Platform: $(uname -s) $(uname -m)  |  dotfiles: $DOTFILES"

# --- Linux only: detect distro, ensure zsh installed, make it the login shell ---
# (macOS ships zsh by default, so this whole block is skipped there.)
if [ "$(uname -s)" = "Linux" ]; then
  if [ -r /etc/os-release ]; then . /etc/os-release; ok "Distro: ${PRETTY_NAME:-${ID:-unknown}}"
  else warn "/etc/os-release missing — cannot identify distro"; fi

  if   command -v apt-get >/dev/null 2>&1; then PKG="sudo apt-get install -y"
  elif command -v dnf     >/dev/null 2>&1; then PKG="sudo dnf install -y"
  elif command -v pacman  >/dev/null 2>&1; then PKG="sudo pacman -S --needed --noconfirm"
  elif command -v zypper  >/dev/null 2>&1; then PKG="sudo zypper install -y"
  else PKG=""; fi

  step "Ensuring zsh is installed"
  if command -v zsh >/dev/null 2>&1; then ok "zsh present ($(zsh --version | cut -d' ' -f1-2))"
  elif [ -n "$PKG" ]; then $PKG zsh && ok "zsh installed" || warn "zsh install failed"
  else warn "no known package manager — install zsh manually"; fi

  zsh_bin="$(command -v zsh || true)"
  if [ -n "$zsh_bin" ]; then
    case "${SHELL:-}" in
      *zsh) ok "login shell already zsh" ;;
      *) step "Setting zsh as login shell"
         chsh -s "$zsh_bin" && ok "login shell -> $zsh_bin (effective next login)" \
           || warn "chsh failed (managed/LDAP shell?) — change it manually" ;;
    esac
  fi
fi

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

# 2. Persist brew for future shells in ~/.zshenv.local (sourced by the block in step 7)
step "Persisting Homebrew in ~/.zshenv.local"
brew_line="eval \"\$($(command -v brew) shellenv)\""
if grep -qsF "$brew_line" ~/.zshenv.local 2>/dev/null; then
  ok "brew already in ~/.zshenv.local"
else
  printf '\n%s\n' "$brew_line" >> ~/.zshenv.local && ok "added brew shellenv to ~/.zshenv.local"
fi

# 3. Preflight: the one decision Homebrew needs a human for.
#    `brew bundle` SKIPS formulae from untrusted third-party taps rather than
#    failing, so a missing tool otherwise shows up as a silent no-op minutes
#    later. Ask brew which taps it is refusing and resolve it up front.
step "Preflight: third-party tap trust"
trust_cmds="$(brew bundle check --verbose --file="$DOTFILES/Brewfile" 2>&1 |
  grep -o 'brew trust [^`]*' | sort -u)"
if [ -z "$trust_cmds" ]; then
  ok "all third-party taps trusted"
else
  warn "Homebrew is ignoring third-party taps in the Brewfile until they are trusted."
  printf '    Trusting a tap lets its Ruby formula code run during brew operations,\n'
  printf '    so it is a per-machine security decision and cannot live in the Brewfile.\n'
  printf '    Leave them untrusted and their tools are skipped, not installed.\n'
  printf '    Suggested by brew:\n'
  while IFS= read -r c; do printf '      %s\n' "$c"; done <<<"$trust_cmds"
  if [ ! -t 0 ]; then
    warn "non-interactive — run the command(s) above, then re-run this script"
  else
    read -r -p "    Run them now? [y/N] " a
    if [ "$a" = y ] || [ "$a" = Y ]; then
      while IFS= read -r c; do
        # Only ever run the narrow shape we asked grep for; brew's stdout is the
        # source, but this stays a guard rather than trusting parsed text.
        if [[ ! $c =~ ^brew\ trust\ (--formula\ |--cask\ |--tap\ )?[A-Za-z0-9/@._-]+$ ]]; then
          warn "skipped unexpected command: $c"; continue
        fi
        if $c >/dev/null 2>&1; then ok "trusted ${c#brew trust }"; else warn "failed: $c"; fi
      done <<<"$trust_cmds"
    else
      ok "skipped — tools from those taps will not be installed"
    fi
  fi
fi

# 4. Packages (casks/fonts auto-skip on Linux via the Brewfile's OS.mac? guard)
step "Installing packages from Brewfile"
if brew bundle --file="$DOTFILES/Brewfile"; then ok "Brewfile satisfied"
else warn "Some Brewfile entries failed (internal-tap or unavailable formula). Continuing."; fi

# 5. Directories the zsh config expects
step "Creating XDG directories"
mkdir -p ~/.local/state/zsh ~/.cache/zsh && ok "state + cache dirs ready" || warn "could not create XDG dirs"

# 6. Stow the packages the dotfiles fully own (pure symlinks, no shared files).
#    zsh ships only ~/.config/zsh/* (no top-level ~/.zshenv), so it is safe here.
step "Stowing owned packages"
cd "$DOTFILES"
if command -v stow >/dev/null 2>&1; then
  for pkg in */; do
    pkg="${pkg%/}"
    err="$(mktemp)"
    if stow --restow "$pkg" 2>"$err"; then ok "stow $pkg"
    else warn "stow $pkg: $(tr '\n' ' ' <"$err" | sed 's/  */ /g')"; fi
    rm -f "$err"
  done
else
  warn "stow not installed (Brewfile step failed?) — skipping symlinks"
fi

# 7. Coexist: layer our config onto the SHARED shell files without clobbering.
#    ~/.zshenv gets env + the source hooks; ~/.zshrc gets the interactive load.
step "Wiring shell config (coexist)"
append_block "$HOME/.zshenv" \
'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
[ -f "$XDG_CONFIG_HOME/zsh/.zshenv" ] && source "$XDG_CONFIG_HOME/zsh/.zshenv"
[ -f "$HOME/.zshenv.local" ] && source "$HOME/.zshenv.local"'
append_block "$HOME/.zshrc" \
'[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc" ] && source "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc"'

# 8. tmux plugin manager
step "tmux plugin manager (TPM)"
if [ -d ~/.tmux/plugins/tpm ]; then ok "TPM already present"
elif git clone -q https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm; then ok "TPM cloned"
else warn "TPM clone failed"; fi

# 9. Next steps this script deliberately does not run.
#    setup-omp.sh needs omp installed AND launched once (the wizard writes
#    config.yml first), so it cannot be chained safely from here.
step "Next steps"
printf '  %s-%s tmux: open it and press ` then I to install plugins\n' "$C" "$X"
if command -v omp >/dev/null 2>&1; then
  printf '  %s-%s omp: launch it once, then run ./setup-omp.sh\n' "$C" "$X"
else
  printf '  %s-%s omp: not installed — skip setup-omp.sh until it is\n' "$C" "$X"
fi

# Summary
if [ "$WARN" -eq 0 ]; then
  printf '\n%s✓ Done — no warnings.%s Restart your shell (or run `exec zsh -l`).\n' "$G$B" "$X"
else
  printf '\n%s⚠ Done with %d warning(s).%s Review the lines above; the rest completed.\n' "$Y$B" "$WARN" "$X"
fi
