# ~/.config/zsh/bindings.zsh

# =========================================================
# Keybindings
# =========================================================

# Ctrl+Right -> move forward one word
  bindkey '^[[1;5C' forward-word

  # Ctrl+Left -> move backward one word
  bindkey '^[[1;5D' backward-word

  # Ctrl+F -> fzf file picker (no hidden files)
  bindkey '^F' _fzf_file_no_hidden

  # Ctrl+\ -> toggle autosuggestions
  bindkey '^\' autosuggest-toggle

  # Up/Down -> history search by substring
  bindkey '^[[A' history-substring-search-up
  bindkey '^[[B' history-substring-search-down