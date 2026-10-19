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
WIZARD_TMP=""
cleanup() {
  stty sane 2>/dev/null || true
  [ -z "$WIZARD_TMP" ] || rm -rf "$WIZARD_TMP"
}

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"


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

# Shared selection mappings for the read-only review and the installer.
_apt_package_for() {
  case "$1" in
    zsh|zoxide|fzf|eza|bat|ripgrep|tmux|cloc|git-lfs|pipx|ruby|graphviz|unison|ruff|rust-analyzer|xclip|wl-clipboard) printf '%s\n' "$1" ;;
    fd) printf 'fd-find\n' ;;
    node) printf 'nodejs npm\n' ;;
    font-fira-mono) printf 'fontconfig\n' ;;
  esac
}
_selected_apt_packages() {
  printf 'git curl ca-certificates gpg tar xz-utils unzip stow'
  local component mapped
  for component in $SELECTED_PACKAGES; do
    mapped="$(_apt_package_for "$component")"
    [ -z "$mapped" ] || printf ' %s' "$mapped"
  done
  printf '\n'
}
_brewfile_package() {
  local kind="$1" name
  name="$(printf '%s\n' "$2" | sed -E 's/^[[:space:]]*(brew|cask)[[:space:]]+"([^"]+)".*/\2/')"
  case "$kind:$name" in
    brew:can1357/tap/omp) printf 'omp\n' ;;
    cask:ghostty@tip) printf 'ghostty\n' ;;
    cask:font-fira-mono-nerd-font) printf 'font-fira-mono\n' ;;
    cask:visual-studio-code) printf 'vscode\n' ;;
    brew:*|cask:*) printf '%s\n' "${name##*/}" ;;
  esac
}
_selected_brewfile() {
  local kind line package
  selected_package omp && printf 'tap "can1357/tap"\n'
  printf 'brew "stow"\n'
  while IFS='|' read -r kind line; do
    [ "$kind" = tap ] && continue
    package="$(_brewfile_package "$kind" "$line")"
    selected_package "$package" || continue
    if [ "$kind" = cask ]; then
      printf 'if OS.mac?\n%s\nend\n' "$line"
    else
      printf '%s\n' "$line"
    fi
  done < <(_brewfile_entries "$DOTFILES/Brewfile")
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

selected_package() {
  case " ${SELECTED_PACKAGES:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
selected_stow() {
  case " ${SELECTED_STOW:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

_validate_plan_list() {
  local value="$1" allowed="$2" label="$3" item seen=""
  case "$value" in *[!a-z0-9\ -]*) die "$label must be space-separated package IDs" ;; esac
  for item in $value; do
    case " $allowed " in *" $item "*) ;; *) die "Unsupported $label entry: $item" ;; esac
    case " $seen " in *" $item "*) die "Duplicate $label entry: $item" ;; esac
    seen="$seen $item"
  done
}

review_plan() {
  local component mapped kind line package source relative
  local allowed="zsh starship zoxide fzf fd eza bat ripgrep tmux cloc mise node bun git-lfs pipx ruby graphviz unison ruff rust-analyzer basedpyright typescript-language-server vscode-langservers-extracted omp herdr pi vscode ghostty font-fira-mono ollama"
  [ "$#" -eq 5 ] || die "Usage: --review-plan PLATFORM PROFILE 'PACKAGES' 'STOW' 0_OR_1"
  PLATFORM="$1"; PROFILE="$2"; SELECTED_PACKAGES="$3"; SELECTED_STOW="$4"; SET_LOGIN_SHELL="$5"
  case "$PLATFORM" in
    ubuntu) allowed="$allowed xclip wl-clipboard" ;;
    darwin) allowed="$allowed tlrc alt-tab iterm2 obs" ;;
    *) die "Platform must be ubuntu or darwin" ;;
  esac
  case "$PROFILE" in personal|server) ;; *) die "Profile must be personal or server" ;; esac
  case "$SET_LOGIN_SHELL" in 0|1) ;; *) die "Login-shell choice must be 0 or 1" ;; esac
  _validate_plan_list "$SELECTED_PACKAGES" "$allowed" software
  _validate_plan_list "$SELECTED_STOW" "agents codex ghostty herdr omp pi pi-ollama starship tmux zsh" Stow
  selected_package node || die "Node must remain selected for the wizard"
  [ -r "$DOTFILES/Brewfile" ] || die "Cannot read the repository Brewfile"
  for package in $SELECTED_STOW; do
    [ -d "$DOTFILES/$package" ] || die "Missing Stow source: $package"
  done

  printf 'Installation review\nProfile: %s\nPlatform: %s\n' "$PROFILE" "$PLATFORM"
  printf 'Repository: %q\nAccount home: %q\n' "$DOTFILES" "$HOME"
  printf 'This is a read-only plan. Nothing is installed or changed by this command.\n'
  printf 'Unchecked software and configs are skipped, not uninstalled or unstowed.\n'
  printf '\nSoftware and dependencies\n'
  if [ "$PLATFORM" = ubuntu ]; then
    printf 'APT uses this machine'\''s configured Ubuntu repositories, runs sudo apt-get update,\n'
    printf 'and installs missing packages system-wide with sudo apt-get install -y.\n'
    printf 'Always-required tools: git curl ca-certificates gpg tar xz-utils unzip stow.\n'
    printf 'Complete APT selection: %s\n' "$(_selected_apt_packages)"
    for component in $SELECTED_PACKAGES; do
      mapped="$(_apt_package_for "$component")"
      [ -z "$mapped" ] || printf '  %s: APT -> %s, system-wide with sudo.\n' "$component" "$mapped"
      case "$component" in
        fd) printf '    Account link ~/.local/bin/fd -> /usr/bin/fdfind; existing unexpected paths stay untouched.\n' ;;
        bat) printf '    Account link ~/.local/bin/bat -> /usr/bin/batcat; existing unexpected paths stay untouched.\n' ;;
        starship) printf '  starship: executes https://starship.rs/install.sh with -y if absent.\n    Upstream installs the binary, normally /usr/local/bin, and may request sudo.\n' ;;
        mise) printf '  mise: executes https://mise.run if absent, under this account.\n' ;;
        bun) printf '  bun: executes https://bun.sh/install if absent, normally in ~/.bun.\n' ;;
        omp) printf '  omp: executes https://omp.sh/install if absent.\n    Upstream installer controls destinations and any privilege requests.\n' ;;
        herdr) printf '  herdr: executes https://herdr.dev/install.sh if absent.\n    Upstream installer controls destinations and any privilege requests.\n' ;;
        node) printf '    Also mise use --global node@22 if mise is available; global here means this account'\''s mise config.\n' ;;
        basedpyright) printf '  basedpyright: pipx install basedpyright from PyPI, account-local, only if pipx is available.\n' ;;
        typescript-language-server|vscode-langservers-extracted)
          printf '  %s: mise exec -- npm install --global from the configured npm registry.\n' "$component"
          printf '    Requires mise; its Node prefix determines the install location, normally account-local.\n' ;;
        pi) printf '  pi: bun install -g @earendil-works/pi-coding-agent from the configured npm registry if absent.\n    Requires Bun; global install uses this account'\''s Bun prefix.\n' ;;
        vscode) printf '  vscode: if absent, downloads https://packages.microsoft.com/keys/microsoft.asc.\n    sudo writes /usr/share/keyrings/microsoft.gpg and /etc/apt/sources.list.d/vscode.list,\n    adds https://packages.microsoft.com/repos/code stable main, updates APT and installs code system-wide.\n' ;;
        ghostty) printf '  ghostty: if absent, Ubuntu 26.04 uses sudo apt-get install -y ghostty.\n    Ubuntu 24.04 asks separate consent before executing the community-built installer\n    https://raw.githubusercontent.com/mkasberg/ghostty-ubuntu/HEAD/install.sh.\n    This is not an official Ghostty package; the script controls changes and privilege requests.\n    Other Ubuntu versions have no configured route and warn without installing Ghostty.\n' ;;
        font-fira-mono) printf '    Downloads https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FiraMono.tar.xz\n    to ~/.local/share/fonts, extracts there, removes the archive and runs fc-cache for this account.\n' ;;
        ollama) printf '  ollama: executes https://ollama.com/install.sh, which may use sudo and install a system service.\n    If ollama is then available, ollama pull nomic-embed-text downloads the embedding model.\n    Model storage follows Ollama'\''s configured service/account environment.\n' ;;
      esac
    done
  else
    printf 'Homebrew is required; if missing, executes the upstream installer:\n'
    printf 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh\n'
    printf 'Homebrew bootstrap may request sudo. Formulae install into the shared Homebrew prefix;\n'
    printf 'casks may install applications/fonts system-wide and request sudo. Dependencies are resolved by brew.\n'
    printf 'Selected entries read from %q, plus required Stow:\n' "$DOTFILES/Brewfile"
    while IFS='|' read -r kind line; do
      [ "$kind" = tap ] && { printf '  %s\n' "$line"; continue; }
      package="$(_brewfile_package "$kind" "$line")"
      printf '  %s: Homebrew %s -> %s\n' "$package" "$kind" "$line"
    done < <(_selected_brewfile | _brewfile_entries /dev/stdin)
    selected_package zsh && printf '  zsh: uses the existing macOS Zsh; no Zsh Brewfile entry is installed.\n'
    selected_package pi && printf '  pi: if absent, npm install --global --ignore-scripts @earendil-works/pi-coding-agent.\n    Uses the configured npm registry; the npm prefix determines account/shared scope and permissions.\n'
    selected_package ollama && printf '  ollama: Homebrew formula only. The macOS path does not download nomic-embed-text.\n'
    printf 'Homebrew shellenv is evaluated now and appended if missing to %q.\n' "$HOME/.zshenv.local"
    printf 'That append has no backup; the shared Zsh hook sources this file when Zsh config is selected.\n'
    if selected_package omp; then
      printf 'OMP adds can1357/tap from https://github.com/can1357/homebrew-tap.\n'
      printf 'Homebrew may ask a separate security question before trusting can1357/tap/omp.\n'
      printf 'Trust permits the tap'\''s Ruby code to execute during brew operations; approval here does not grant trust.\n'
      printf 'An accepted item-specific grant is stored at %q.\n' "${XDG_CONFIG_HOME:-$HOME/.config}/homebrew/trust.json"
      printf 'Declined or non-interactive trust is not auto-approved; Homebrew can reject the entry and warn.\n'
    fi
  fi
  printf 'Package managers and downloaded installers may fetch further dependencies and execute upstream code.\n'
  printf 'Existing command/package checks can skip satisfied installs; upstream installers govern their own changes.\n'
  printf '\nStow sources and account targets\n'
  if [ -z "$SELECTED_STOW" ]; then printf 'No Stow packages selected.\n'; fi
  for package in $SELECTED_STOW; do
    printf '  %s: stow --restow, source %q, target %q\n' "$package" "$DOTFILES/$package" "$HOME"
    while IFS= read -r -d '' source; do
      relative="${source#"$DOTFILES/$package/"}"
      printf '    %q -> %q\n' "$source" "$HOME/$relative"
    done < <(find "$DOTFILES/$package" -mindepth 1 -maxdepth 1 -print0)
    if [ -d "$DOTFILES/$package/.config" ]; then
      while IFS= read -r -d '' source; do
        relative="${source#"$DOTFILES/$package/"}"
        printf '    config %q -> %q\n' "$source" "$HOME/$relative"
      done < <(find "$DOTFILES/$package/.config" -mindepth 1 -maxdepth 1 -print0)
    fi
  done
  printf 'Stow links/merges the selected source trees, including local contents, subject to Stow ignore rules.\n'
  printf 'It simulates each restow first. Conflicting real files/directories move to <target>.dotfiles-bak.\n'
  printf 'If that backup already exists, the target is left in place and the conflict must be resolved manually.\n'
  printf 'Existing symlink conflicts are not backed up; Stow may warn. No --adopt or deletion of unchecked configs.\n'
  printf '\nShared shell hooks and account changes\n'
  printf 'Always creates %q and %q for Zsh state/cache.\n' "$HOME/.local/state/zsh" "$HOME/.cache/zsh"
  if selected_stow zsh; then
    printf 'Append one fenced dotfiles block to %q and %q only when its marker is absent.\n' "$HOME/.zshenv" "$HOME/.zshrc"
    printf 'The .zshenv hook defaults XDG_CONFIG_HOME to ~/.config, prepends ~/.local/bin and ~/.bun/bin,\n'
    printf 'sources $XDG_CONFIG_HOME/zsh/.zshenv and ~/.zshenv.local when present.\n'
    printf 'The .zshrc hook sources $XDG_CONFIG_HOME/zsh/.zshrc when present.\n'
    printf 'Existing shared files are copied to <file>.dotfiles-bak before appending; existing backups are kept\n'
    printf 'by default, or can be printed/overwritten after an interactive question. Existing marked blocks stay unchanged.\n'
  else
    printf 'No shared .zshenv/.zshrc hooks are added.\n'
  fi
  if [ "$SET_LOGIN_SHELL" = 1 ] && selected_package zsh; then
    printf 'If Zsh is available and not already the account shell, chsh -s <zsh> <current-user> changes the login shell.\n'
    printf 'chsh may require authentication/account policy approval; effect starts after logout/login.\n'
  else
    printf 'Login shell unchanged'
    [ "$SET_LOGIN_SHELL" = 0 ] || printf ' because Zsh software is not selected'
    printf '.\n'
  fi
  if selected_package tmux; then
    printf 'If absent, clone https://github.com/tmux-plugins/tpm to %q for this account.\n' "$HOME/.tmux/plugins/tpm"
    printf 'TPM plugins are not installed now; open tmux and press ` then I later.\n'
  fi
  selected_package omp && printf 'OMP setup is not run automatically. Launch omp once, then run ./setup-omp.sh separately.\n'
  printf '\nWizard bootstrap and cleanup\n'
  printf 'Interactive setup may already have installed Node before this review, after a separate bootstrap confirmation.\n'
  printf 'On macOS it uses Homebrew Node and may bootstrap Homebrew; Ubuntu uses https://mise.run and mise Node 22.\n'
  printf 'Those bootstrap installs remain even if the wizard is cancelled. Temporary wizard install/cache files are removed.\n'
  printf 'Only the explicit Install action approves installation. Later trust, backup, sudo and community-source questions remain separate.\n'
}

# Dispatch before platform detection, terminal cleanup traps, bootstrap, or writes.
if [ "$#" -gt 0 ]; then
  B=; R=; G=; Y=; C=; X=
  [ "$1" = --review-plan ] || die "Only --review-plan accepts command-line arguments"
  shift
  set -f
  review_plan "$@"
  exit $?
fi
trap cleanup EXIT
# Homebrew keeps its tap-trust store at $XDG_CONFIG_HOME/homebrew/trust.json,
# falling back to ~/.homebrew/trust.json when the var is unset. The zsh block in
# step 7 exports XDG_CONFIG_HOME as ~/.config, so pin the same value here —
# otherwise `brew trust` below writes to ~/.homebrew and the login shell, which
# looks in ~/.config, never sees it.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
TRUST_FILE="$(_brew_user_config_home)/trust.json"
TRUST_FILE_STRAY="$HOME/.homebrew/trust.json"   # where a bare `brew trust` lands

step "Detecting platform"
IS_UBUNTU=0
IS_MACOS=0
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=1
  PLATFORM=darwin
elif [ "$(uname -s)" = "Linux" ] && [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" = ubuntu ]; then
    IS_UBUNTU=1
    PLATFORM=ubuntu
    ok "Distro: ${PRETTY_NAME:-Ubuntu}"
  else
    die "This installer currently supports macOS and Ubuntu; detected ${PRETTY_NAME:-${ID:-unknown}}"
  fi
else
  die "This installer currently supports macOS and Ubuntu"
fi
ok "Platform: $PLATFORM $(uname -m)"

node_compatible() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 12) ? 0 : 1)' &&
    command -v npm >/dev/null 2>&1
}
confirm_bootstrap() {
  local answer
  printf '\nThe setup wizard needs Node 20.12 or later and npm. This bootstrap will remain installed.\n'
  if [ "$IS_MACOS" -eq 1 ]; then
    printf 'macOS will install the Homebrew node formula.\n'
    [ -x "$(command -v brew 2>/dev/null || true)" ] || printf 'Homebrew will also be installed if needed.\n'
  else
    printf 'Ubuntu will use mise to install Node 22 under this account.\n'
  fi
  read -r -p "Continue with the Node bootstrap? [Y/n] " answer
  [ -z "$answer" ] || [ "$answer" = y ] || [ "$answer" = Y ] || [ "$answer" = yes ] || [ "$answer" = YES ]
}
if [ -t 0 ] && [ -t 1 ]; then
  if ! node_compatible; then
    confirm_bootstrap || die "Node bootstrap declined; no other install actions were started"
    if [ "$IS_MACOS" -eq 1 ]; then
      if ! command -v brew >/dev/null 2>&1; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" ||
          die "Homebrew bootstrap failed"
      fi
      for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        [ -x "$brew_path" ] && eval "$("$brew_path" shellenv)" && break
      done
      command -v brew >/dev/null 2>&1 || die "Homebrew is not available after bootstrap"
      brew install node || die "Node bootstrap failed"
    else
      export PATH="$HOME/.local/bin:$PATH"
      if ! command -v mise >/dev/null 2>&1; then
        curl -fsSL https://mise.run | sh || die "mise bootstrap failed"
        export PATH="$HOME/.local/bin:$PATH"
      fi
      mise use --global node@22 || die "Node 22 bootstrap failed"
      eval "$(mise activate bash)"
    fi
    node_compatible || die "A compatible Node and npm are required to run the wizard"
  fi

  WIZARD_TMP="$(mktemp -d)" || die "could not create temporary wizard directory"
  wizard_result="$WIZARD_TMP/selection.json"
  wizard_archive="$(npm pack --silent --pack-destination "$WIZARD_TMP" "$DOTFILES/install-wizard")" ||
    die "Could not package the setup wizard"
  if ! npm_config_cache="$WIZARD_TMP/npm-cache" npm install --prefix "$WIZARD_TMP/runtime" \
    --no-save --package-lock=false "$WIZARD_TMP/$wizard_archive"; then
    die "Could not prepare the setup wizard"
  fi
  node "$WIZARD_TMP/runtime/node_modules/dotfiles-install-wizard/cli.js" \
    --platform "$PLATFORM" --result-file "$wizard_result" --installer "$DOTFILES/install.sh"
  wizard_status=$?
  [ "$wizard_status" -eq 0 ] || exit "$wizard_status"
  {
    IFS= read -r PROFILE
    IFS= read -r SELECTED_PACKAGES
    IFS= read -r SELECTED_STOW
    IFS= read -r SET_LOGIN_SHELL
  } < <(node -e 'const s=require("node:fs").readFileSync(process.argv[1],"utf8");const v=JSON.parse(s);console.log(v.profile);console.log(v.packages.join(" "));console.log(v.stow.join(" "));console.log(v.setLoginShell?"1":"0")' "$wizard_result")
else
  PROFILE="${INSTALL_PROFILE:-}"
  if [ -z "$PROFILE" ]; then
    [ "$IS_UBUNTU" -eq 1 ] && PROFILE=server || PROFILE=personal
  fi
  case "$PROFILE" in personal|server) ;; *) die "INSTALL_PROFILE must be personal or server" ;; esac
  if [ "$PROFILE" = personal ]; then
    SELECTED_PACKAGES="zsh starship zoxide fzf fd eza bat ripgrep tmux xclip wl-clipboard cloc mise node bun git-lfs pipx ruby graphviz unison ruff rust-analyzer basedpyright typescript-language-server vscode-langservers-extracted omp herdr pi vscode ghostty font-fira-mono alt-tab iterm2 obs ollama"
    SELECTED_STOW="agents codex ghostty herdr omp pi pi-ollama starship tmux zsh"
  else
    SELECTED_PACKAGES="zsh starship zoxide fzf fd eza bat ripgrep tmux cloc mise node bun git-lfs pipx ruby graphviz unison ruff rust-analyzer basedpyright typescript-language-server vscode-langservers-extracted omp herdr pi"
    SELECTED_STOW="agents codex herdr omp pi starship tmux zsh"
  fi
  if [ "$IS_UBUNTU" -eq 1 ]; then
    SELECTED_PACKAGES="${SELECTED_PACKAGES// tlrc/}"
    SELECTED_PACKAGES="${SELECTED_PACKAGES// alt-tab/}"
    SELECTED_PACKAGES="${SELECTED_PACKAGES// iterm2/}"
    SELECTED_PACKAGES="${SELECTED_PACKAGES// obs/}"
  else
    SELECTED_PACKAGES="${SELECTED_PACKAGES// vscode/}"
  fi
  SELECTED_PACKAGES="node $SELECTED_PACKAGES"
  SET_LOGIN_SHELL=1
fi

step "Install plan"
printf '  Profile: %s\n  Software: %s\n  Dotfile packages to Stow: %s\n' \
  "$PROFILE" "$SELECTED_PACKAGES" "${SELECTED_STOW:-none}"
if [ "$SET_LOGIN_SHELL" = 1 ]; then
  printf '  Account change: set Zsh as the login shell\n'
else
  printf '  Account change: leave the login shell unchanged\n'
fi
printf '  Scope: package-manager installs may be system-wide; Stow links and shell changes affect this account.\n'
printf '  Existing conflicting config files are backed up before Stow; Homebrew and Node bootstrap changes, if any, remain.\n'
if [ -t 0 ] && [ ! -t 1 ]; then
  read -r -p "Install this plan? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) die "Plan cancelled; no selected package installs were started" ;; esac
fi

# The full plan is approved. System package and account changes start below.
if [ "$IS_UBUNTU" -eq 1 ] && selected_package zsh; then
  if ! command -v zsh >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y zsh || warn "zsh install failed"
  fi
fi
if selected_package zsh && [ "$SET_LOGIN_SHELL" = 1 ]; then
  zsh_bin="$(command -v zsh || true)"
  if [ -n "$zsh_bin" ]; then
    account_shell="${SHELL:-}"
    if [ "$IS_UBUNTU" -eq 1 ]; then
      account_shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
      if [ -z "$account_shell" ] && [ -r /etc/passwd ]; then
        account_shell="$(awk -F: -v user="$(id -un)" '$1 == user { print $7; exit }' /etc/passwd)"
      fi
    fi
    case "$account_shell" in
      */zsh) ok "configured account shell already zsh ($account_shell)" ;;
      *) chsh -s "$zsh_bin" "$(id -un)" && ok "login shell -> $zsh_bin (effective after logging out and back in)" \
           || warn "chsh failed (managed account or shell policy?) — change it manually" ;;
    esac
  fi
fi

if [ "$IS_UBUNTU" -eq 1 ]; then
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
  step "Ubuntu package mapping"
  apt_packages="$(_selected_apt_packages)"
  sudo apt-get update && ok "apt package indexes updated" || warn "apt update failed"
  for package in $apt_packages; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      ok "$package already installed"
    elif sudo apt-get install -y "$package"; then ok "$package installed"
    else warn "apt install failed: $package"; fi
  done

  if selected_package fd || selected_package bat; then
    mkdir -p "$HOME/.local/bin"
    for pair in "fd:/usr/bin/fdfind" "bat:/usr/bin/batcat"; do
      name="${pair%%:*}"; binary="${pair#*:}"; link="$HOME/.local/bin/$name"
      selected_package "$name" || continue
      [ -x "$binary" ] || continue
      if [ -L "$link" ] && [ "$(readlink -f "$link" 2>/dev/null)" = "$binary" ]; then
        ok "$name compatibility link already correct"
      elif [ ! -e "$link" ] && [ ! -L "$link" ]; then
        ln -s "$binary" "$link" && ok "$name compatibility link created" || warn "could not create $name compatibility link"
      else
        warn "$link already exists and is not the expected package link; preserving it"
      fi
    done
  fi

  if selected_package starship && ! command -v starship >/dev/null 2>&1; then
    curl -fsSL https://starship.rs/install.sh | sh -s -- -y || warn "Starship official installer failed"
  fi
  if selected_package mise && ! command -v mise >/dev/null 2>&1; then
    curl -fsSL https://mise.run | sh || warn "mise upstream installer failed"
  fi
  if selected_package bun && ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash || warn "Bun upstream installer failed"
  fi
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
  if selected_package omp && ! command -v omp >/dev/null 2>&1; then
    curl -fsSL https://omp.sh/install | bash || warn "OMP official installer failed"
  fi
  if selected_package herdr && ! command -v herdr >/dev/null 2>&1; then
    curl -fsSL https://herdr.dev/install.sh | sh || warn "Herdr official installer failed"
  fi
  if selected_package node && command -v mise >/dev/null 2>&1; then
    mise use --global node@22 || warn "mise Node 22 install failed"
  fi
  npm_language_servers=""
  selected_package typescript-language-server && npm_language_servers="$npm_language_servers typescript-language-server"
  selected_package vscode-langservers-extracted && npm_language_servers="$npm_language_servers vscode-langservers-extracted"
  if [ -n "$npm_language_servers" ] && command -v mise >/dev/null 2>&1; then
    mise exec -- npm install --global $npm_language_servers || warn "language-server npm installs failed"
  fi
  if selected_package basedpyright && command -v pipx >/dev/null 2>&1; then
    pipx install basedpyright || warn "basedpyright installation failed"
  fi
  if selected_package vscode && ! command -v code >/dev/null 2>&1; then
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /usr/share/keyrings/microsoft.gpg >/dev/null &&
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" | sudo tee /etc/apt/sources.list.d/vscode.list >/dev/null &&
      sudo apt-get update && sudo apt-get install -y code || warn "VS Code install failed"
  fi
  if selected_package ghostty && ! command -v ghostty >/dev/null 2>&1; then
    if [ "${VERSION_ID:-}" = "26.04" ]; then
      sudo apt-get install -y ghostty || warn "Ghostty apt install failed"
    elif [ "${VERSION_ID:-}" = "24.04" ]; then
      read -r -p "Ghostty on Ubuntu 24.04 uses a community-built installer. Continue? [y/N] " answer
      case "$answer" in y|Y|yes|YES) curl -fsSL https://raw.githubusercontent.com/mkasberg/ghostty-ubuntu/HEAD/install.sh | bash || warn "Ghostty community installer failed" ;; *) warn "Ghostty installation declined" ;; esac
    else
      warn "Ghostty has no configured package route for Ubuntu ${VERSION_ID:-unknown}"
    fi
  fi
  if selected_package font-fira-mono; then
    font_dir="$HOME/.local/share/fonts"
    mkdir -p "$font_dir" &&
      curl -fL https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FiraMono.tar.xz -o "$font_dir/FiraMono.tar.xz" &&
      tar -xJf "$font_dir/FiraMono.tar.xz" -C "$font_dir" &&
      rm -f "$font_dir/FiraMono.tar.xz" && fc-cache -f "$font_dir" && ok "FiraMono Nerd Font v3.5.1 installed user-locally" ||
      warn "FiraMono Nerd Font download/install failed"
  fi
  if selected_package ollama; then
    curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama upstream installer failed"
    if command -v ollama >/dev/null 2>&1; then
      ollama pull nomic-embed-text || warn "nomic-embed-text pull failed"
    fi
  fi
  if selected_package pi && ! command -v pi >/dev/null 2>&1; then
    if command -v bun >/dev/null 2>&1; then
      bun install -g @earendil-works/pi-coding-agent || warn "Pi CLI install failed"
    else warn "Pi CLI skipped: Bun unavailable"; fi
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

if [ -z "$WIZARD_TMP" ]; then
  WIZARD_TMP="$(mktemp -d)" || die "could not create temporary package directory"
fi
bundle_file="$WIZARD_TMP/Brewfile"
if [ "$IS_MACOS" -eq 1 ]; then
  _selected_brewfile >"$bundle_file"
fi

# 3. Preflight: the one decision Homebrew needs a human for.
#    An untrusted third-party formula does NOT get skipped — brew raises
#    UntrustedTapError while it builds the dependency map, before it installs
#    anything, so the whole Brewfile aborts with zero packages installed.
#    Resolve it up front, asking brew for its trust state directly rather than
#    scraping suggestions out of `brew bundle check` (which never prints them).
step "Preflight: third-party tap trust"
untrusted="$(untrusted_items "$bundle_file")"
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
      untrusted="$(untrusted_items "$bundle_file")"
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
if selected_package pi; then
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
fi


# 5. Directories the zsh config expects
step "Creating XDG directories"
mkdir -p ~/.local/state/zsh ~/.cache/zsh && ok "state + cache dirs ready" || warn "could not create XDG dirs"

# 6. Stow the packages the dotfiles fully own (pure symlinks, no shared files).
#    zsh ships only ~/.config/zsh/* (no top-level ~/.zshenv), so it is safe here.
step "Stowing owned packages"
cd "$DOTFILES"

if command -v stow >/dev/null 2>&1; then
  for pkg in agents codex ghostty herdr omp pi pi-ollama starship tmux zsh; do
    [ -d "$pkg" ] || continue
    selected_stow "$pkg" || continue



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
if selected_stow zsh; then
  step "Wiring shell config (coexist)"
  append_block "$HOME/.zshenv" \
'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
[ -f "$XDG_CONFIG_HOME/zsh/.zshenv" ] && source "$XDG_CONFIG_HOME/zsh/.zshenv"
[ -f "$HOME/.zshenv.local" ] && source "$HOME/.zshenv.local"'
  append_block "$HOME/.zshrc" \
'[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc" ] && source "$XDG_CONFIG_HOME/zsh/.zshrc"'
fi

if selected_package tmux; then
  step "tmux plugin manager (TPM)"
  if [ -d ~/.tmux/plugins/tpm ]; then ok "TPM already present"
  elif git clone -q https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm; then ok "TPM cloned"
  else warn "TPM clone failed"; fi
fi

# 9. Next steps this script deliberately does not run.
#    setup-omp.sh needs omp installed AND launched once (the wizard writes
#    config.yml first), so it cannot be chained safely from here.
step "Next steps"
if selected_package tmux; then
  printf '  %s-%s tmux: open it and press ` then I to install plugins\n' "$C" "$X"
fi
if selected_package omp; then
  if command -v omp >/dev/null 2>&1; then
    printf '  %s-%s omp: launch it once, then run ./setup-omp.sh\n' "$C" "$X"
  else
    printf '  %s-%s omp: not installed — skip setup-omp.sh until it is\n' "$C" "$X"
  fi
fi

# Summary
if [ "$WARN" -eq 0 ]; then
  printf '\n%s✓ Done — no warnings.%s Restart your shell; after a login-shell change, log out of Ubuntu and back in.\n' "$G$B" "$X"
else
  printf '\n%s⚠ Done with %d warning(s).%s Review the lines above; after a login-shell change, log out of Ubuntu and back in.\n' "$Y$B" "$WARN" "$X"
fi
