# ~/.config/zsh/aliases.zsh

# =========================================================
# Modern CLI Replacements
# =========================================================

# Better ls
alias ls='eza --icons=auto'

# Detailed listing
alias ll='eza -lh --icons=auto --git'

# Detailed listing including hidden files
alias la='eza -lah --icons=auto --git'

# Tree view
alias tree='eza --tree --icons=auto'

# Reuse ls completions for eza (avoids defining a separate completion function)
compdef eza=ls

# Better cat
if [[ -n "$BAT_COMMAND" ]]; then
  alias cat="$BAT_COMMAND"
fi

# fd
if [[ -n "$FD_COMMAND" ]]; then
  alias f="$FD_COMMAND"
fi

# =========================================================
# Core utilities
# =========================================================

alias rg='rg --color=auto'
alias diff='diff --color=auto'

