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

# A cask install that needs sudo (quitting/relaunching the app, privileged
# files) or a mistyped sudo password can leave the tty with ONLCR cleared, so
# every following \n moves the cursor down without returning it to column 0 —
# each line then starts wherever the previous one ended, producing the
# staircase effect. Reset on exit so a broken run doesn't leak into the shell
# the script was launched from.
trap 'stty sane 2>/dev/null || true' EXIT

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Homebrew keeps its tap-trust store at $XDG_CONFIG_HOME/homebrew/trust.json,
# falling back to ~/.homebrew/trust.json when the var is unset. The zsh block in
# step 7 exports XDG_CONFIG_HOME as ~/.config, so pin the same value here —
# otherwise `brew trust` below writes to ~/.homebrew and the login shell, which
# looks in ~/.config, never sees it.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# --- trust helpers -----------------------------------------------------------
# Resolve the trust store exactly the way brew does. bin/brew picks
# HOMEBREW_USER_CONFIG_HOME as $XDG_CONFIG_HOME/homebrew, else
# $HOMEBREW_XDG_CONFIG_HOME/homebrew, else ~/.homebrew; Library/Homebrew/trust.rb
# then reads and writes <that dir>/trust.json. Nothing is cached between runs and
# `brew update` is irrelevant — a "correct-looking" trust.json that brew ignores
# is always a trust.json in the *other* directory. This is the footgun above,
# observed from the other side: the file exists, just not where brew is looking.
_brew_user_config_home() {
  if   [ -n "${XDG_CONFIG_HOME:-}" ];          then printf '%s\n' "$XDG_CONFIG_HOME/homebrew"
  elif [ -n "${HOMEBREW_XDG_CONFIG_HOME:-}" ]; then printf '%s\n' "$HOMEBREW_XDG_CONFIG_HOME/homebrew"
  else                                              printf '%s\n' "$HOME/.homebrew"; fi
}
TRUST_FILE="$(_brew_user_config_home)/trust.json"
TRUST_FILE_STRAY="$HOME/.homebrew/trust.json"   # where a bare `brew trust` lands

# Ask brew itself what it trusts. `brew trust --json=v1 --tap|--formula|--cask`
# prints a flat JSON array of names, so a quoted-string scrape is enough and we
# do not need jq this early in the bootstrap. Names are stored downcased already,
# but lowercase here too so both sides of every _in_list comparison match on
# the same normalization rather than relying on brew's storage convention.
_trusted_entries() { brew trust --json=v1 "$1" 2>/dev/null | grep -o '"[^"]*"' | tr -d '"' | tr '[:upper:]' '[:lower:]'; }
_in_list() { [ -n "$1" ] && printf '%s\n' "$2" | grep -qxF "$1"; }
_lower() { printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]'; }

# Fully-qualified Brewfile entries, as "<type> <user/repo/name>" records. Only
# these need trust: brew loads Ruby for them, and a bare `tap` line does not.
# Two sed calls because BSD sed has no \| alternation.
_brewfile_items() {
  sed -n 's|^[[:space:]]*brew[[:space:]]*"\([^"]*/[^"]*/[^"]*\)".*|formula \1|p' "$1"
  sed -n 's|^[[:space:]]*cask[[:space:]]*"\([^"]*/[^"]*/[^"]*\)".*|cask \1|p' "$1"
}

# One "<kind>|<original line>" record per installable entry. The whole source
# line is kept so per-entry retries preserve options (args:, link:, ...).
_brewfile_entries() {
  sed -n -e 's|^[[:space:]]*\(tap[[:space:]].*\)$|tap\|\1|p' \
         -e 's|^[[:space:]]*\(brew[[:space:]].*\)$|brew\|\1|p' \
         -e 's|^[[:space:]]*\(cask[[:space:]].*\)$|cask\|\1|p' "$1"
}

# Untrusted fully-qualified entries, as "<type> <name>". An entry is fine if its
# whole tap is trusted or the item itself is; that mirrors Trust.trusted?.
untrusted_items() {
  local ttaps tformulae tcasks type name tap
  ttaps="$(_trusted_entries --tap)"
  tformulae="$(_trusted_entries --formula)"
  tcasks="$(_trusted_entries --cask)"
  while IFS=' ' read -r type name; do
    [ -n "$name" ] || continue
    name="$(_lower "$name")"
    tap="${name%/*}"
    case "$tap" in homebrew/*) continue ;; esac       # official taps are implicit
    _in_list "$tap" "$ttaps" && continue
    case "$type" in
      formula) _in_list "$name" "$tformulae" && continue ;;
      cask)    _in_list "$name" "$tcasks"    && continue ;;
    esac
    printf '%s %s\n' "$type" "$name"
  done <<EOF
$(_brewfile_items "$1")
EOF
}

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

# --- Linux: identify Ubuntu, ensure zsh, and inspect the configured account shell ---
IS_UBUNTU=0
if [ "$(uname -s)" = "Linux" ]; then
  if [ -r /etc/os-release ]; then . /etc/os-release; ok "Distro: ${PRETTY_NAME:-${ID:-unknown}}"
  else warn "/etc/os-release missing — cannot identify distro"; fi

  if [ "${ID:-}" = ubuntu ]; then
    IS_UBUNTU=1
  else
    if   command -v apt-get >/dev/null 2>&1; then PKG="sudo apt-get install -y"
    elif command -v dnf     >/dev/null 2>&1; then PKG="sudo dnf install -y"
    elif command -v pacman  >/dev/null 2>&1; then PKG="sudo pacman -S --needed --noconfirm"
    elif command -v zypper  >/dev/null 2>&1; then PKG="sudo zypper install -y"
    else PKG=""; fi
  fi

  step "Ensuring zsh is installed"
  if command -v zsh >/dev/null 2>&1; then ok "zsh present ($(zsh --version | cut -d' ' -f1-2))"
  elif [ "$IS_UBUNTU" -eq 1 ]; then sudo apt-get update && sudo apt-get install -y zsh && ok "zsh installed" || warn "zsh install failed"
  elif [ -n "${PKG:-}" ]; then $PKG zsh && ok "zsh installed" || warn "zsh install failed"
  else warn "no known package manager — install zsh manually"; fi

  zsh_bin="$(command -v zsh || true)"
  if [ -n "$zsh_bin" ]; then
    account_shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
    if [ -z "$account_shell" ] && [ -r /etc/passwd ]; then
      account_shell="$(awk -F: -v user="$(id -un)" '$1 == user { print $7; exit }' /etc/passwd)"
    fi
    case "$account_shell" in
      */zsh) ok "configured account shell already zsh ($account_shell)" ;;
      *) step "Setting zsh as login shell"
         chsh -s "$zsh_bin" "$(id -un)" && ok "login shell -> $zsh_bin (effective after logging out and back in)" \
           || warn "chsh failed (managed/LDAP shell?) — change it manually" ;;
    esac
  fi
fi

if [ "$IS_UBUNTU" -eq 1 ]; then
  # Keep this explicit: every Brewfile formula is installed here or named as a deliberate skip.
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

  step "Ubuntu package mapping (apt/upstream)"
  printf '  Brewfile -> apt: stow zoxide fzf fd-find eza bat ripgrep tmux cloc nodejs npm git-lfs pipx ruby graphviz unison unzip\n'
  printf '  Brewfile -> upstream: starship mise bun omp herdr; mise Node 22 + npm: typescript-language-server vscode-langservers-extracted; apt-best-effort (failures are skipped): ruff rust-analyzer; pipx: basedpyright\n'
  printf '  Brewfile -> opt-in: ollama (Pi local search); skipped: tlrc (no configured Ubuntu route)\n'
  sudo apt-get update && ok "apt package indexes updated" || warn "apt update failed"
  for package in git curl ca-certificates gpg tar xz-utils unzip fontconfig stow zoxide fzf fd-find eza bat ripgrep tmux cloc nodejs npm git-lfs pipx ruby graphviz unison; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      ok "$package already installed"
    elif sudo apt-get install -y "$package"; then ok "$package installed"
    else warn "apt install failed: $package"; fi
  done
  for package in ruff rust-analyzer; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      ok "$package already installed"
    elif sudo apt-get install -y "$package"; then ok "$package installed"
    else warn "$package skipped: Ubuntu apt install failed; no upstream route configured"; fi
  done
  sudo apt-get install -y xclip wl-clipboard || warn "clipboard helpers (xclip/wl-clipboard) install failed"
  # Ubuntu's fd-find and bat use different executable names than the Brewfile.
  mkdir -p "$HOME/.local/bin"
  for pair in "fd:/usr/bin/fdfind" "bat:/usr/bin/batcat"; do
    name="${pair%%:*}"; binary="${pair#*:}"; link="$HOME/.local/bin/$name"
    [ -x "$binary" ] || continue
    if [ -L "$link" ] && [ "$(readlink -f "$link" 2>/dev/null)" = "$binary" ]; then
      ok "$name compatibility link already correct"
    elif [ ! -e "$link" ] && [ ! -L "$link" ]; then
      ln -s "$binary" "$link" && ok "$name compatibility link created" || warn "could not create $name compatibility link"
    else
      warn "$link already exists and is not the expected package link; preserving it"
    fi
  done
  # Upstream-supported installers for tools not consistently available in Ubuntu apt.
  if ! command -v starship >/dev/null 2>&1; then
    curl -fsSL https://starship.rs/install.sh | sh -s -- -y || warn "Starship official installer failed"
  fi
  if ! command -v mise >/dev/null 2>&1; then curl -fsSL https://mise.run | sh || warn "mise upstream installer failed"; fi
  if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash || warn "Bun upstream installer failed"; fi
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
  if ! command -v omp >/dev/null 2>&1; then curl -fsSL https://omp.sh/install | bash || warn "OMP official installer failed"; fi
  if ! command -v herdr >/dev/null 2>&1; then curl -fsSL https://herdr.dev/install.sh | sh || warn "Herdr official installer failed"; fi
  if command -v mise >/dev/null 2>&1 && mise use --global node@22; then
    mise exec -- npm install --global typescript-language-server vscode-langservers-extracted \
      || warn "language-server npm installs failed"
  else warn "language servers skipped: mise Node 22 unavailable"; fi
  warn "tlrc has no configured Ubuntu install route; Brewfile tool intentionally skipped"

  ask_yes_no() {
    local prompt="$1" default="$2" answer
    if [ ! -t 0 ]; then [ "$default" = yes ]; return; fi
    if [ "$default" = yes ]; then read -r -p "    $prompt [Y/n] " answer; answer="${answer:-y}"
    else read -r -p "    $prompt [y/N] " answer; answer="${answer:-n}"; fi
    [[ "$answer" = y || "$answer" = Y || "$answer" = yes || "$answer" = YES ]]
  }
  WANT_VSCODE=0; WANT_GHOSTTY=0; WANT_FONT=0; WANT_PI_OLLAMA=0
  ask_yes_no "Install Visual Studio Code?" yes && WANT_VSCODE=1
  ask_yes_no "Install Ghostty?" yes && WANT_GHOSTTY=1
  ask_yes_no "Install FiraMono Nerd Font?" yes && WANT_FONT=1
  if [ "${INSTALL_PI_OLLAMA:-}" = 1 ]; then
    WANT_PI_OLLAMA=1
  else
    ask_yes_no "Enable Pi local search (Ollama + nomic-embed-text)?" no && WANT_PI_OLLAMA=1
  fi

  if [ "$WANT_VSCODE" -eq 1 ]; then
    if ! command -v code >/dev/null 2>&1; then
      curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /usr/share/keyrings/microsoft.gpg >/dev/null &&
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" | sudo tee /etc/apt/sources.list.d/vscode.list >/dev/null &&
      sudo apt-get update && sudo apt-get install -y code || warn "VS Code install failed; see https://code.visualstudio.com/docs/setup/linux"
    else ok "VS Code already installed"; fi
  else ok "VS Code intentionally skipped"; fi

  if [ "$WANT_GHOSTTY" -eq 1 ]; then
    if command -v ghostty >/dev/null 2>&1; then ok "Ghostty already installed"
    elif [ "${VERSION_ID:-}" = "26.04" ]; then
      sudo apt-get install -y ghostty || warn "Ghostty apt install failed"
    elif [ "${VERSION_ID:-}" = "24.04" ]; then
      if ask_yes_no "Install the community-built Ghostty .deb (not an official Ubuntu package)?" no; then
        curl -fsSL https://raw.githubusercontent.com/mkasberg/ghostty-ubuntu/HEAD/install.sh | bash \
          || warn "Ghostty community .deb install failed"
      else warn "Ghostty skipped: community .deb install declined"; fi
    else warn "Ghostty package route unknown for Ubuntu ${VERSION_ID:-unknown}; install manually"; fi
  else ok "Ghostty intentionally skipped"; fi

  if [ "$WANT_FONT" -eq 1 ]; then
    font_dir="$HOME/.local/share/fonts"
    mkdir -p "$font_dir" &&
      curl -fL https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FiraMono.tar.xz -o "$font_dir/FiraMono.tar.xz" &&
      tar -xJf "$font_dir/FiraMono.tar.xz" -C "$font_dir" &&
      rm -f "$font_dir/FiraMono.tar.xz" && fc-cache -f "$font_dir" && ok "FiraMono Nerd Font v3.5.1 installed user-locally" ||
      warn "FiraMono Nerd Font download/install failed"
  else ok "FiraMono Nerd Font intentionally skipped"; fi

  if [ "$WANT_PI_OLLAMA" -eq 1 ]; then
    curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama upstream installer failed"
    if command -v ollama >/dev/null 2>&1; then
      ollama pull nomic-embed-text || warn "nomic-embed-text pull failed"
    fi
  else ok "Pi local search intentionally skipped"; fi

  if ! command -v pi >/dev/null 2>&1; then
    if command -v bun >/dev/null 2>&1; then
      bun install -g @earendil-works/pi-coding-agent || warn "Pi CLI install failed (bun install -g @earendil-works/pi-coding-agent)"
    else warn "Pi CLI skipped: Bun unavailable; install Bun and retry"; fi
  fi
else
  if [ "$(uname -s)" = "Darwin" ]; then

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
#    An untrusted third-party formula does NOT get skipped — brew raises
#    UntrustedTapError while it builds the dependency map, before it installs
#    anything, so the whole Brewfile aborts with zero packages installed.
#    Resolve it up front, asking brew for its trust state directly rather than
#    scraping suggestions out of `brew bundle check` (which never prints them).
step "Preflight: third-party tap trust"
untrusted="$(untrusted_items "$DOTFILES/Brewfile")"
if [ -z "$untrusted" ]; then
  ok "all third-party Brewfile entries trusted"
else
  warn "Homebrew will refuse to load these Brewfile entries until they are trusted:"
  while IFS=' ' read -r type name; do
    [ -n "$name" ] && printf '      %s %s\n' "$type" "$name"
  done <<<"$untrusted"
  printf '    Trusting an entry lets that tap'\''s Ruby code run during brew operations,\n'
  printf '    so it is a per-machine security decision. Trust store: %s\n' "$TRUST_FILE"
  if [ ! -t 0 ]; then
    warn "non-interactive — trust them, then re-run; untrusted entries are skipped below"
  else
    read -r -p "    Trust them now? [y/N] " a
    if [ "$a" = y ] || [ "$a" = Y ]; then
      while IFS=' ' read -r type name; do
        [ -n "$name" ] || continue
        # Names come from the Brewfile, but keep the shape check: this string
        # becomes a brew argument.
        if [[ ! $name =~ ^[a-z0-9][a-z0-9/@._-]*$ ]]; then
          warn "skipped unexpected name: $name"; continue
        fi
        # Trust the single item, not the whole tap — narrowest grant that works.
        if brew trust "--$type" "$name" >/dev/null 2>&1; then ok "trusted $type $name"
        else warn "brew trust --$type $name failed"; fi
      done <<<"$untrusted"
      untrusted="$(untrusted_items "$DOTFILES/Brewfile")"
      [ -z "$untrusted" ] && ok "trust store now covers every third-party entry" \
                          || warn "still untrusted after brew trust — see the diagnostic below"
    else
      ok "skipped — those entries will be left out of the install below"
    fi
  fi
fi

# 3b. Diagnostic: the effective trust state, printed right before the bundle so a
#     future failure explains itself instead of needing this investigation again.
step "Trust state for this brew run"
printf '  %s-%s XDG_CONFIG_HOME: %s\n' "$C" "$X" "${XDG_CONFIG_HOME:-<unset>}"
if [ -f "$TRUST_FILE" ]; then
  printf '  %s-%s trust store:     %s (present)\n' "$C" "$X" "$TRUST_FILE"
else
  printf '  %s-%s trust store:     %s (%smissing%s — nothing is trusted)\n' "$C" "$X" "$TRUST_FILE" "$Y" "$X"
fi
brew trust 2>&1 | sed 's/^/    /'
# The footgun in the header, caught from the other side: a `brew trust` run in a
# shell without XDG_CONFIG_HOME writes ~/.homebrew/trust.json, which brew then
# ignores here. Same JSON, wrong directory, and the error message never says so.
if [ "$TRUST_FILE" != "$TRUST_FILE_STRAY" ] && [ -f "$TRUST_FILE_STRAY" ]; then
  warn "a second trust store exists at $TRUST_FILE_STRAY — brew is NOT reading it"
  printf '    It was written by a `brew trust` run in a shell without XDG_CONFIG_HOME set.\n'
  printf '    Re-trust from this script, or from a shell where XDG_CONFIG_HOME=%s.\n' "$XDG_CONFIG_HOME"
fi

# 4. Packages (casks/fonts auto-skip on Linux via the Brewfile's OS.mac? guard)
step "Installing packages from Brewfile"
bundle_file="$DOTFILES/Brewfile"
bundle_err="$(mktemp)"
if brew bundle --file="$bundle_file" 2>"$bundle_err"; then
  ok "Brewfile satisfied"
  rm -f "$bundle_err"
else
  # brew bundle is all-or-nothing at the batch level: with the default
  # --jobs=auto it loads every formula to build a dependency map before the
  # first install, so one unloadable entry takes the whole run down and NOTHING
  # gets installed. Surface brew's own words, then retry entry by entry — each
  # in its own one-line Brewfile — so a single bad tap cannot cascade.
  warn "brew bundle failed as a batch. brew reported:"
  sed 's/^/      /' "$bundle_err" >&2
  rm -f "$bundle_err"
  warn "retrying entry-by-entry so one bad entry cannot block the rest"
  bundle_tmp="$(mktemp -d)"
  bundle_taps="$(sed -n 's/^[[:space:]]*\(tap[[:space:]].*\)$/\1/p' "$bundle_file")"
  bundle_fail=0
  while IFS='|' read -r kind line; do
    [ -n "$line" ] || continue
    case "$kind" in tap) continue ;; esac        # taps ride along in every file
    one="$bundle_tmp/Brewfile"
    {
      printf '%s\n' "$bundle_taps"
      # Keep the Brewfile's OS.mac? guard so cask entries still no-op on Linux.
      if [ "$kind" = cask ]; then printf 'if OS.mac?\n%s\nend\n' "$line"
      else printf '%s\n' "$line"; fi
    } >"$one"
    # Merge both streams: trust errors land on stderr, build logs on stdout.
    if ! brew bundle --file="$one" --quiet >"$bundle_tmp/log" 2>&1; then
      bundle_fail=$((bundle_fail + 1))
      warn "failed: $line"
      tail -n 15 "$bundle_tmp/log" | sed 's/^/        /' >&2
    fi
  done < <(_brewfile_entries "$bundle_file")
  rm -rf "$bundle_tmp"
  if [ "$bundle_fail" -eq 0 ]; then
    ok "all entries installed individually"
  else
    [ "$bundle_fail" -eq 1 ] && n="entry" || n="entries"
    warn "$bundle_fail Brewfile $n failed — see the errors above. Continuing."
  fi
fi
# A sudo-gated cask (e.g. an app that needs quitting/relaunching, like obs) can
# leave the tty with ONLCR cleared even on success. Reset now instead of
# waiting for the EXIT trap, so the remaining steps render correctly too.
stty sane 2>/dev/null || true
# Pi is published to npm; Node is installed by the Brewfile.
step "Installing Pi CLI"
if command -v pi >/dev/null 2>&1; then
  ok "pi already installed"
elif command -v npm >/dev/null 2>&1 && npm install --global --ignore-scripts @earendil-works/pi-coding-agent; then
  ok "Pi CLI installed"
else
  warn "could not install Pi CLI — run: npm install --global --ignore-scripts @earendil-works/pi-coding-agent"
  fi
fi
fi

# Pi local-search config remains enabled on macOS to preserve existing behavior.
[ "$IS_UBUNTU" -eq 1 ] || WANT_PI_OLLAMA=1

# 5. Directories the zsh config expects
step "Creating XDG directories"
mkdir -p ~/.local/state/zsh ~/.cache/zsh && ok "state + cache dirs ready" || warn "could not create XDG dirs"

# 6. Stow the packages the dotfiles fully own (pure symlinks, no shared files).
#    zsh ships only ~/.config/zsh/* (no top-level ~/.zshenv), so it is safe here.
step "Stowing owned packages"
cd "$DOTFILES"

if command -v stow >/dev/null 2>&1; then
  if [ "$IS_UBUNTU" -eq 1 ] && [ "$WANT_PI_OLLAMA" -eq 0 ] && [ -d pi-ollama ]; then
    if stow -D pi-ollama; then ok "removed previously stowed pi-ollama"
    else warn "could not remove previously stowed pi-ollama"; fi
  fi

  for pkg in agents ghostty herdr omp pi pi-ollama starship tmux zsh; do
    [ -d "$pkg" ] || continue
    if [ "$pkg" = pi-ollama ] && [ "$WANT_PI_OLLAMA" -eq 0 ]; then continue; fi


    # A real file or directory already sitting at a target path makes stow
    # abort the WHOLE package, not just that one path (this bit starship on a
    # fresh machine before ~/dotfiles existed, and had to be fixed by hand).
    # Simulate first and back conflicts out of the way so the real run has
    # nothing left to trip over. --adopt would do this too, but it pulls
    # whatever is on the machine INTO the repo — exactly backwards from what
    # we want, which is the repo's tracked content winning.
    dry_err="$(mktemp)"
    if ! stow -n --restow "$pkg" 2>"$dry_err"; then
      while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        target="$HOME/$rel"
        bak="$target.dotfiles-bak"
        if [ -L "$target" ] || [ ! -e "$target" ]; then
          continue      # already a symlink (or gone) — not the conflict this loop backs up
        elif [ -e "$bak" ]; then
          warn "$pkg: $rel conflicts and $(basename "$bak") already exists — leaving in place, resolve by hand"
        else
          mkdir -p "$(dirname "$bak")" &&
            mv "$target" "$bak" && ok "$pkg: backed up conflicting $rel -> $(basename "$bak")" ||
            warn "$pkg: could not back up $rel"
        fi
      done < <(sed -E -n 's/.*over existing (non-directory |directory )?target ([^ ]+).*/\2/p' "$dry_err")
    fi
    rm -f "$dry_err"

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
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
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
  printf '\n%s✓ Done — no warnings.%s Restart your shell; after a login-shell change, log out of Ubuntu and back in.\n' "$G$B" "$X"
else
  printf '\n%s⚠ Done with %d warning(s).%s Review the lines above; after a login-shell change, log out of Ubuntu and back in.\n' "$Y$B" "$WARN" "$X"
fi
