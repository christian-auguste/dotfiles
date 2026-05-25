# Dotfiles

Personal shell and terminal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Requirements

- [Homebrew](https://brew.sh)
- Zsh

## Install

### 1. Install Homebrew (if not already installed)

```zsh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

### 2. Install dependencies

```zsh
brew install stow starship zoxide fzf fd eza bat ripgrep tmux
brew install --cask ghostty font-fira-mono-nerd-font
```

### 3. Clone and stow

```zsh
git clone git@github.com:christian-auguste/dotfiles.git ~/dotfiles
cd ~/dotfiles
stow */
```

### 4. Create required directories

```zsh
mkdir -p ~/.local/state/zsh ~/.cache/zsh
```

### 5. Install tmux plugins

Clone TPM:

```zsh
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

Open tmux and press `` ` `` then `I` to install plugins.

## Packages

| Package | What it configures |
|---------|---|
| `zsh/` | Shell environment, history, completion, plugins, aliases, keybindings |
| `tmux/` | Terminal multiplexer with Catppuccin theme |
| `ghostty/` | Terminal emulator (Catppuccin Mocha, FiraMono Nerd Font) |
| `starship/` | Cross-shell prompt |

## Zsh plugins (auto-installed on first shell load)

- [fast-syntax-highlighting](https://github.com/zdharma-continuum/fast-syntax-highlighting) — colors commands as you type
- [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) — ghost text completions from history
- [zsh-history-substring-search](https://github.com/zsh-users/zsh-history-substring-search) — up/down arrows filter history by current input

## Structure

```
dotfiles/
├── ghostty/.config/ghostty/config
├── starship/.config/starship.toml
├── tmux/
│   ├── .tmux.conf
│   └── .tmux/plugins/        (gitignored — managed by TPM)
├── zsh/
│   ├── .zshenv               (bootstrap: XDG vars, sources config)
│   └── .config/zsh/
│       ├── .zshenv           (env vars: editor, pager, paths)
│       ├── .zshrc            (interactive: history, completion, plugins)
│       ├── aliases.zsh
│       ├── bindings.zsh
│       ├── fzf.zsh
│       ├── plugins.zsh
│       └── prompt.zsh
└── .gitignore
```

## Updating

```zsh
cd ~/dotfiles && git pull
```

To update zsh plugins:

```zsh
zplugin-update
```

## Notes

- On a managed work machine, add `source "$XDG_CONFIG_HOME/zsh/.zshrc"` at the end of `~/.zshrc` to load the modular config alongside tool-managed entries
- Zoxide replaces `cd` via `--cmd cd` flag — smart matching with full `cd /exact/path` still working
- `~/.zshenv` bootstraps XDG directories and sources `~/.config/zsh/.zshenv`

## Keybindings

### Zsh

| Key | Action |
|-----|--------|
| `Ctrl+Right` | Move forward one word |
| `Ctrl+Left` | Move backward one word |
| `Ctrl+F` | fzf file picker (no hidden files) |
| `Ctrl+T` | fzf file picker (includes hidden files) |
| `Ctrl+R` | fzf history search |
| `Alt+C` | fzf cd into directory |
| `Ctrl+\` | Toggle autosuggestions |
| `Up` | History substring search up |
| `Down` | History substring search down |

### Tmux (prefix: `` ` ``)

| Key | Action |
|-----|--------|
| `` ` `` + `r` | Reload tmux config |
| `` ` `` + `c` | New window (in current directory) |
| `` ` `` + `"` | Split pane horizontal (in current directory) |
| `` ` `` + `%` | Split pane vertical (in current directory) |
| `` ` `` + `I` | Install plugins (TPM) |
| `y` (copy mode) | Copy selection to clipboard |
| Mouse drag | Highlight text (no auto-copy) |
| Click (copy mode) | Clear selection |
