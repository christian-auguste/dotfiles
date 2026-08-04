. "$HOME/.cargo/env"

# Added by AIM CLI
export PATH="$HOME/.aim/mcp-servers:$PATH"

# XDG + ZDOTDIR — with ZDOTDIR set, zsh loads $ZDOTDIR/.zshrc (aliases, prompt,
# plugins) automatically, so no per-machine "source .zshrc" hook is needed.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export ZDOTDIR="$XDG_CONFIG_HOME/zsh"

[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"

# Machine-local env (Homebrew path, per-host PATH, etc.). Untracked; safe if absent.
[[ -f "$HOME/.zshenv.local" ]] && source "$HOME/.zshenv.local"
