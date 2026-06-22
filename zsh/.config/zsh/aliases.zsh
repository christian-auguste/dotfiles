# ~/.config/zsh/aliases.zsh

# =========================================================
# Modern CLI Replacements
# =========================================================

# Better ls
alias ls='eza --icons'

# Detailed listing
alias ll='eza -lh --icons --git'

# Detailed listing including hidden files
alias la='eza -lah --icons --git'

# Tree view
alias tree='eza --tree --icons'

# Reuse ls completions for eza (avoids defining a separate completion function)
compdef eza=ls

# Better cat
alias cat='bat'

# fd 
alias f='fd'

# =========================================================
# Core utilities
# =========================================================

alias rg='rg --color=auto'
alias diff='diff --color=auto'

