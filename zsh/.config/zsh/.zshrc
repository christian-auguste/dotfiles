# zsh configuration

# Uses:
#   Plugins:      fast-syntax-highlighting, zsh-autosuggestions,
#                 zsh-history-substring-search, zsh-vi-mode
#   Prompt:       starship
#   Navigation:   zoxide, fzf, fd
#   CLI tools:    eza, bat, nvim, ripgrep
#   Node:         nvm

# =========================================================
# History
# =========================================================

HISTFILE="$XDG_STATE_HOME/zsh/history"
HISTSIZE=100000
SAVEHIST=100000

setopt APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_IGNORE_DUPS
setopt HIST_IGNORE_SPACE
setopt HIST_EXPIRE_DUPS_FIRST
setopt HIST_FIND_NO_DUPS

# =========================================================
# Shell behaviour
# =========================================================

setopt AUTOCD
setopt NOBEEP
setopt NUMERIC_GLOB_SORT  # sort file10 after file9, not after file1

# Load mise-managed tools, including the Ubuntu Node 22 runtime.
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
fi


# =========================================================
# # Initialize zoxide w/ cd alias
# =========================================================

eval "$(zoxide init --cmd cd zsh)"

# =========================================================
# Completion
# =========================================================

# Load completion system
autoload -Uz compinit

# Initialize completion with cached metadata file
compinit -d "$XDG_CACHE_HOME/zsh/zcompdump"

# Enable interactive completion menu selection
zstyle ':completion:*' menu select

# Make completion case-insensitive
# Example: "doc" can complete to "Documents"
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'  # lowercase input matches upper and lower

# =========================================================
# Fuzzy finder
# =========================================================

# Load fzf's native integration when available, then fall back to packaged
# shell scripts used by older Ubuntu and Homebrew releases.
if command -v fzf >/dev/null 2>&1; then
  _fzf_zsh_integration=$(fzf --zsh 2>/dev/null)
  if [[ -n "$_fzf_zsh_integration" ]]; then
    eval "$_fzf_zsh_integration"
  else
    for _fzf_shell_dir in /usr/share/doc/fzf/examples /opt/homebrew/opt/fzf/shell; do
      if [[ -f "$_fzf_shell_dir/key-bindings.zsh" && -f "$_fzf_shell_dir/completion.zsh" ]]; then
        source "$_fzf_shell_dir/key-bindings.zsh"
        source "$_fzf_shell_dir/completion.zsh"
        break
      fi
    done
  fi
  unset _fzf_zsh_integration _fzf_shell_dir
fi

# =========================================================
# Modular Config Files
# =========================================================

# fzf configuration
source "$XDG_CONFIG_HOME/zsh/fzf.zsh"

# Aliases
source "$XDG_CONFIG_HOME/zsh/aliases.zsh"

# Custom keybindings
source "$XDG_CONFIG_HOME/zsh/bindings.zsh"

# Plugins and plugin manager
source "$XDG_CONFIG_HOME/zsh/plugins.zsh"

# Prompt/theme
source "$XDG_CONFIG_HOME/zsh/prompt.zsh"
