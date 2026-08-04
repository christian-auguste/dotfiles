# Dotfiles

Personal shell and terminal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Requirements

- [Homebrew](https://brew.sh)
- Zsh

## Install

macOS or Linux, one command:

```zsh
git clone git@github.com:christian-auguste/dotfiles.git ~/dotfiles
~/dotfiles/install.sh
```

`install.sh` is idempotent (safe to re-run). It installs Homebrew if missing,
runs `brew bundle` against the [Brewfile](./Brewfile), creates the XDG dirs the
zsh config expects, `stow`s every package, and clones TPM. On Linux the macOS
casks/fonts in the Brewfile are skipped automatically.

Finish tmux setup: open tmux and press `` ` `` then `I` to install plugins.

<details>
<summary>Manual steps (what install.sh does)</summary>

```zsh
# 1. Homebrew (if missing), then load it into the shell
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"          # Linux: /home/linuxbrew/.linuxbrew/bin/brew

# 2. Packages
brew bundle --file=~/dotfiles/Brewfile

# 3. Required directories
mkdir -p ~/.local/state/zsh ~/.cache/zsh

# 4. Stow
cd ~/dotfiles && stow */

# 5. tmux plugin manager
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```
</details>

## Homebrew packages

The intentional toolchain lives in the [Brewfile](./Brewfile) — the source of
truth, replacing the old hand-maintained `brew install` line. Add a tool by
editing the Brewfile, then run `brew bundle`. Transitive dependencies are **not**
listed (Homebrew pulls those in on its own). To see what is installed but not
recorded, run `brew bundle cleanup --file=~/dotfiles/Brewfile`.

## Packages

| Package | What it configures |
|---------|---|
| `zsh/` | Shell environment, history, completion, plugins, aliases, keybindings |
| `tmux/` | Terminal multiplexer with Catppuccin theme |
| `ghostty/` | Terminal emulator (Gruvbox Material Light, FiraMono Nerd Font) |
| `starship/` | Cross-shell prompt |
| `herdr/` | Agent multiplexer for the terminal (prefix set to backtick to match tmux) |
| `pi/` | Pi coding agent config (`settings.json`, `mcp.json`, extensions, theme) -- excludes auth.json, caches, sessions, memory, `npm/` |
| `agents/` | Shared agent skills in `~/.agents/skills/` (tree-folded — new skills need no re-stow) |

## Zsh plugins (auto-installed on first shell load)

- [fast-syntax-highlighting](https://github.com/zdharma-continuum/fast-syntax-highlighting) — colors commands as you type
- [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) — ghost text completions from history
- [zsh-history-substring-search](https://github.com/zsh-users/zsh-history-substring-search) — up/down arrows filter history by current input

## Structure

```
dotfiles/
├── Brewfile                     (intentional Homebrew packages — source of truth)
├── install.sh                   (idempotent macOS/Linux setup)
├── agents/.agents/skills/       (one dir symlink — add skills freely)
├── ghostty/.config/ghostty/config
├── herdr/.config/herdr/config.toml
├── pi/.pi/
│   ├── knowledge-search.json
│   └── agent/
│       ├── settings.json     (packages, theme, models)
│       ├── mcp.json
│       ├── extensions/       (*.ts)
│       └── themes/           (gruvbox-light.json)
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

- `ZDOTDIR` is set to `$XDG_CONFIG_HOME/zsh` in `~/.zshenv`, so the interactive config (`$ZDOTDIR/.zshrc` — aliases, prompt, plugins) loads automatically; no manual source line is needed. Caveat: this makes zsh ignore `$HOME/.zshrc`, so on a managed machine that injects tool setup there, either leave `ZDOTDIR` unset or re-source those entries from `$ZDOTDIR/.zshrc`. Machine-local env (Homebrew path, per-host `PATH`) belongs in `~/.zshenv.local`, which the bootstrap sources if present
- Zoxide replaces `cd` via `--cmd cd` flag — smart matching with full `cd /exact/path` still working
- `~/.zshenv` bootstraps XDG directories and sources `~/.config/zsh/.zshenv`
- Employer-specific agent config (`~/.kiro/steering/`) is intentionally untracked — it documents internal build and deployment systems that don't belong in a personal repo, and wouldn't apply elsewhere. The pi steering extension no-ops when the directory is absent.
- `~/.pi/agent/npm/package.json` is derived from `settings.json` by pi and is not tracked; `packages` in `settings.json` is the source of truth

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

### Herdr (prefix: `` ` ``)

herdr's prefix is set to a bare backtick to match tmux, so the leader key is consistent across both multiplexers. Default herdr keybindings apply after the prefix; only the prefix is customized. Reload config with `herdr server reload-config`.
