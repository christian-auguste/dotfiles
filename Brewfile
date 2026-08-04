# Brewfile — intentional toolchain only (deps and stray formulae excluded).
# Reinstall / sync:  brew bundle --file=~/dotfiles/Brewfile
# Prune anything NOT listed here:  brew bundle cleanup --file=~/dotfiles/Brewfile
# Works on macOS and Linux (Homebrew). GUI casks + fonts are macOS-only and guarded.

# --- dotfiles stack (see README) ---
brew "stow"          # symlink-manages this repo
brew "starship"      # prompt
brew "zoxide"        # smart cd
brew "fzf"           # fuzzy finder
brew "fd"            # find replacement
brew "eza"           # ls replacement
brew "bat"           # cat replacement
brew "ripgrep"       # grep replacement
brew "tmux"          # terminal multiplexer
brew "herdr"         # agent multiplexer (may require an internal tap on some machines)

# --- dev tooling ---
brew "cloc"          # count lines of code
brew "mise"          # polyglot runtime version manager
brew "node"          # JS runtime (mise can also manage node; kept for a system default)
brew "git-lfs"       # large-file versioning
brew "pipx"          # isolated Python CLIs
brew "ruby"          # scripting
brew "rust-analyzer" # Rust LSP
brew "graphviz"      # diagram rendering
brew "tlrc"          # tldr client
brew "ollama"        # local LLMs
brew "unison"        # file synchronization

# --- macOS GUI apps + fonts (skipped on Linux) ---
if OS.mac?
  cask "ghostty@tip"              # terminal — configured in ghostty/
  cask "font-fira-mono-nerd-font" # font-family used by the ghostty config
  cask "alt-tab"                  # Windows-style alt-tab window switcher
  cask "iterm2"                   # backup terminal
  cask "obs"                      # screen recording / streaming
end
