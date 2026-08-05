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
zsh config expects, `stow`s the packages the dotfiles own, wires the shared
shell files (see Notes → coexist), and clones TPM. On Linux the macOS
casks/fonts in the Brewfile are skipped automatically.

Finish tmux setup: open tmux and press `` ` `` then `I` to install plugins.

Configure omp separately, because it needs omp installed *and* launched once —
the setup wizard writes `config.yml` before this script can edit it:

```zsh
omp                    # let the wizard run, then quit
~/dotfiles/setup-omp.sh
```

`setup-omp.sh` is idempotent too. It sets only the settings that differ from
omp's own defaults, installs the Kiro provider plugin, and never deletes keys —
anything it does not mention resolves from omp's schema at read time.

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

# 4. Stow the packages the dotfiles own
cd ~/dotfiles && stow */

# 5. Wire the shared shell files (coexist — appends a fenced block, backs up first)
printf '\n# >>> christian dotfiles >>>\nexport XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"\n[ -f "$XDG_CONFIG_HOME/zsh/.zshenv" ] && source "$XDG_CONFIG_HOME/zsh/.zshenv"\n[ -f "$HOME/.zshenv.local" ] && source "$HOME/.zshenv.local"\n# <<< christian dotfiles <<<\n' >> ~/.zshenv
printf '\n# >>> christian dotfiles >>>\n[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc" ] && source "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc"\n# <<< christian dotfiles <<<\n' >> ~/.zshrc

# 6. tmux plugin manager
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
| `omp/` | Oh My Pi agent config (`models.yml`, `AGENTS.md`) -- excludes `config.yml`, which omp rewrites itself |
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
├── setup-omp.sh                 (omp settings — run after launching omp once)
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
├── omp/.omp/agent/
│   ├── models.yml            (Kiro thinking-ladder bridge)
│   └── AGENTS.md             (steering refs)
├── starship/.config/starship.toml
├── tmux/
│   ├── .tmux.conf
│   └── .tmux/plugins/        (gitignored — managed by TPM)
├── zsh/
│   └── .config/zsh/          (stowed; the shared ~/.zshenv & ~/.zshrc get a fenced source block instead)
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

- **Coexist wiring for shared shell files.** `~/.zshenv` and `~/.zshrc` are also written to by tools (rustup, Homebrew, nvm, etc.), so the dotfiles do **not** stow or replace them. Instead `install.sh` appends one fenced block (`# >>> christian dotfiles >>> … # <<<`) that sets `XDG_CONFIG_HOME` and sources `~/.config/zsh/.zshenv` + `~/.config/zsh/.zshrc` (your real config, which *is* stowed). Re-running is a no-op once the block exists, and the script backs each file up to `<file>.dotfiles-bak` before its first change. Machine-local env (Homebrew path, per-host `PATH`) goes in `~/.zshenv.local`, sourced by the block. To uninstall: `stow -D`, then delete the fenced block (or restore the `.bak`) — tool lines are never touched.
- Zoxide replaces `cd` via `--cmd cd` flag — smart matching with full `cd /exact/path` still working
- Employer-specific agent config (`~/.kiro/steering/`) is intentionally untracked — it documents internal build and deployment systems that don't belong in a personal repo, and wouldn't apply elsewhere. The pi steering extension no-ops when the directory is absent.
- `~/.pi/agent/npm/package.json` is derived from `settings.json` by pi and is not tracked; `packages` in `settings.json` is the source of truth
- **`~/.omp/agent/config.yml` is deliberately not stowed.** omp rewrites it atomically (temp file + rename), and a rename replaces a symlink with a real file — the dotfiles copy would silently go stale on the first write. omp also persists its own UI toggles there, so the file is genuinely dynamic. `setup-omp.sh` applies the handful of settings worth reproducing instead. `models.yml` and `AGENTS.md` *are* stowed: omp reads but never rewrites those.

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

### Oh My Pi (`omp`)

Defaults, not customized here. Remaps go in `~/.omp/agent/keybindings.yml` — a flat action-id map, **not** `config.yml`. An empty array disables a binding. `/hotkeys` lists the live bindings.

| Key | Action |
|-----|--------|
| `Ctrl+P` | Cycle models |
| `Alt+M` | Model selector — assigning a role **writes `modelRoles` into `config.yml`** |
| `Alt+P` | Temporary model (rest of this session, not persisted to `config.yml`) |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+T` | Toggle thinking blocks |
| `Ctrl+O` | Expand tool output (also expands compaction dividers) |
| `Ctrl+Shift+O` | Hide tool activity |
| `Enter` (while streaming) | **Steer** the running turn |
| `Ctrl+Enter` / `Ctrl+Q` | **Queue** a follow-up for after the turn |
| `Shift+Up` | Dequeue the follow-up |
| `Ctrl+R` | Prompt history |
| `Ctrl+G` | Edit draft in `$EDITOR` |
| `Alt+R` | Retry failed turn |
| `Alt+A` | Agent hub |
| `Ctrl+V` | Paste image |
| `Ctrl+L` | Live voice |
| Hold `Space` | Push-to-talk speech-to-text |

The steer-versus-queue split is the one worth building a habit around: mid-stream, plain `Enter` redirects the turn that is already running, while `Ctrl+Enter` holds your message until it finishes. Redirecting beats waiting and re-prompting.

Note `Ctrl+T` and `Ctrl+R` collide with the zsh bindings above. Inside omp the omp binding wins, since it owns the terminal; the zsh ones apply at the shell prompt.

