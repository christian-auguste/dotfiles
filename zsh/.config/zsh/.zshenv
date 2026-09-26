# ~/.config/zsh/.zshenv

# ---------- XDG base directories ----------
# Centralizes config/cache/data locations
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"

# ---------- Editor ----------
# Default editor used by git, crontab, etc.
export EDITOR="nano"
export VISUAL="nano"

# ---------- CLI command names ----------
# Ubuntu's packaged commands are named fdfind and batcat.
if command -v fd >/dev/null 2>&1; then
  export FD_COMMAND=fd
elif command -v fdfind >/dev/null 2>&1; then
  export FD_COMMAND=fdfind
fi

if command -v bat >/dev/null 2>&1; then
  export BAT_COMMAND=bat
elif command -v batcat >/dev/null 2>&1; then
  export BAT_COMMAND=batcat
fi

# ---------- Pager ----------
if [[ -n "$BAT_COMMAND" ]]; then
  export MANPAGER="$BAT_COMMAND -l man -p"
fi

# ---------- GPG ----------
export GPG_TTY=$(tty)

# ---------- Starship ----------
export STARSHIP_CONFIG="$XDG_CONFIG_HOME/starship.toml"

