# Dotfiles

Personal shell and terminal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## New machine setup

Set your global Git identity. Replace the placeholders with your own name and email:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global --get-regexp '^user\.(name|email)$'
```

Git identity labels commits. SSH authentication lets GitHub verify your access. They are separate settings. Set a different identity for one repository from inside its directory:

```sh
git config user.name "Work Name"
git config user.email "you@work.example"
```

Create an SSH key and display its public key:

```sh
ssh-keygen -t ed25519 -C "you@example.com"
cat ~/.ssh/id_ed25519.pub
```

Add the displayed key under [GitHub SSH keys](https://github.com/settings/keys). Keep the private key (`~/.ssh/id_ed25519`) secret. Then test the connection:

```sh
ssh -T git@github.com
```

See [GitHub's SSH key guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh) and [Git's identity settings](https://git-scm.com/book/en/v2/Getting-Started-First-Time-Git-Setup).

## Install

Clone this repository with SSH after you add and test your key:

```sh
git clone git@github.com:christian-auguste/dotfiles.git ~/dotfiles
```

### macOS

Run the installer. It installs Homebrew if needed, installs the [Brewfile](./Brewfile) packages, installs Pi, stows the dotfiles, wires the shared zsh files, and installs TPM.

```sh
~/dotfiles/install.sh
```

The Pi Ollama local-search package installs by default on macOS to preserve the existing setup.

### Ubuntu

On Ubuntu, the installer uses APT for system tools (`stow`, `zoxide`, `fzf`, `fd-find`, `eza`, `bat`, `ripgrep`, `tmux`, `cloc`, `nodejs`, `npm`, `git-lfs`, `pipx`, `ruby`, `graphviz`, `unison`, `ruff`, and `rust-analyzer`), plus `xclip` and `wl-clipboard`. It installs Starship through its official Linux installer, and OMP and Herdr through their official Linux installers. Interactive prompts default to yes for Visual Studio Code, Ghostty, and FiraMono Nerd Font, and no for Pi local search. In non-interactive runs those same defaults apply without prompting. Set `INSTALL_PI_OLLAMA=1` to enable local search without the prompt. The installer also sets zsh as your login shell, stows the dotfiles, wires the shared zsh files, and installs TPM. If it changes your login shell, log out of Ubuntu and back in so terminal apps inherit the change.

```sh
~/dotfiles/install.sh
```

By default, Ubuntu selects Visual Studio Code, Ghostty, and FiraMono Nerd Font; Pi local search is opt-in. To install Pi local search with Ollama, set:

```sh
INSTALL_PI_OLLAMA=1 ~/dotfiles/install.sh
```

This installs Ollama and `nomic-embed-text`, and stows the separate `pi-ollama` package. The `pi` command installs through Bun if missing.

The installer uses Microsoft's signed APT repository for VS Code. Ghostty uses Ubuntu's official APT package on 26.04; on 24.04 it offers the [community-built `.deb` installer](https://ghostty.org/docs/install/binary#debian-and-ubuntu), which runs only after explicit consent (default no) and is not an official Ubuntu package. FiraMono Nerd Font v3.5.1 installs under `~/.local/share/fonts`. The installer uses mise to install Node 22 and the TypeScript and VS Code language servers, pipx for basedpyright, and upstream installers for Starship, Bun, OMP, Herdr, and Ollama when Pi local search is selected.

The installer deliberately skips `tlrc` because no Ubuntu route is configured. If you decline Ghostty's community installer, or mise/Node 22 or Bun is unavailable, it reports the affected package as skipped.

Open tmux and press `` ` `` then `I` to install plugins.

Configure omp separately. It must be installed and launched once so its setup wizard can write `config.yml` before this script edits it:

```sh
omp                    # let the wizard run, then quit
~/dotfiles/setup-omp.sh
```

The standalone `pi` command and OMP's `omp` command can coexist. Pi's tracked configuration is `pi/.pi/` and is applied by the normal Stow step. Launch `pi` once after installation so it can install the packages listed in `~/.pi/agent/settings.json`.

`setup-omp.sh` is idempotent. It sets only settings that differ from omp's defaults, installs the Kiro provider plugin, and never deletes keys. Any setting it does not mention resolves from omp's schema at read time.

<details>
<summary>Manual steps shared by both installers</summary>

```sh
# Create directories the zsh config expects
mkdir -p ~/.local/state/zsh ~/.cache/zsh

# macOS: include pi-ollama with the default packages
cd ~/dotfiles && stow agents codex ghostty herdr omp pi pi-ollama starship tmux zsh

# Ubuntu: omit optional pi-ollama unless selected
cd ~/dotfiles && stow agents codex ghostty herdr omp pi starship tmux zsh
# selected Ubuntu setup:
cd ~/dotfiles && stow agents codex ghostty herdr omp pi pi-ollama starship tmux zsh

# Wire the shared shell files (appends fenced blocks and backs up first)
printf '\n# >>> christian dotfiles >>>\nexport XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"\n[ -f "$XDG_CONFIG_HOME/zsh/.zshenv" ] && source "$XDG_CONFIG_HOME/zsh/.zshenv"\n[ -f "$HOME/.zshenv.local" ] && source "$HOME/.zshenv.local"\n# <<< christian dotfiles <<<\n' >> ~/.zshenv
printf '\n# >>> christian dotfiles >>>\n[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc" ] && source "${XDG_CONFIG_HOME:-$HOME/.config}/zsh/.zshrc"\n# <<< christian dotfiles <<<\n' >> ~/.zshrc

# Install tmux plugin manager
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```
</details>


## Homebrew packages

The [Brewfile](./Brewfile) is the source of truth for macOS Homebrew packages. Add a tool by editing the Brewfile, then run `brew bundle`. Transitive dependencies are not listed. To see packages installed but not recorded, run `brew bundle cleanup --file=~/dotfiles/Brewfile`.

Ubuntu uses APT and upstream installation routes instead of Homebrew.

## Packages

| Package | What it configures |
|---------|---|
| `zsh/` | Shell environment, history, completion, plugins, aliases, keybindings |
| `tmux/` | Terminal multiplexer with Catppuccin theme |
| `ghostty/` | Terminal emulator (Gruvbox Material Light, FiraMono Nerd Font) |
| `starship/` | Cross-shell prompt |
| `herdr/` | Agent multiplexer for the terminal (prefix set to backtick to match tmux) |
| `pi/` | Pi coding agent config (`settings.json`, `mcp.json`, extensions, theme) -- excludes auth.json, caches, sessions, memory, `npm/` |
| `pi-ollama/` | Optional Pi local search with Ollama (enabled with `INSTALL_PI_OLLAMA=1` on Ubuntu; installed by default on macOS) |
| `omp/` | Oh My Pi agent config (`AGENTS.md`) -- excludes `config.yml`, which omp rewrites itself |
| `agents/` | Shared agent skills in `~/.agents/skills/` (tree-folded — new skills need no re-stow) |
| `codex/` | Codex global instructions at `~/.codex/AGENTS.md`, linked to the shared `~/.agents/AGENTS.md` |

## Zsh plugins (auto-installed on first shell load)

- [fast-syntax-highlighting](https://github.com/zdharma-continuum/fast-syntax-highlighting) — colors commands as you type
- [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) — ghost text completions from history
- [zsh-history-substring-search](https://github.com/zsh-users/zsh-history-substring-search) — up/down arrows filter history by current input

## Structure

```
dotfiles/
├── Brewfile                     (intentional Homebrew packages — source of truth)
├── install.sh                   (idempotent macOS/Ubuntu setup)
├── agents/.agents/skills/       (one dir symlink — add skills freely)
├── codex/.codex/AGENTS.md       (link to shared agent instructions)
├── ghostty/.config/ghostty/config
├── herdr/.config/herdr/config.toml
├── pi/.pi/
│   └── agent/
│       ├── settings.json     (packages, theme, models)
│       ├── mcp.json
│       ├── extensions/       (*.ts)
│       └── themes/           (gruvbox-light.json)
├── pi-ollama/.pi/
│   └── knowledge-search.json
├── omp/.omp/agent/
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
├── .gitignore
└── setup-omp.sh                 (omp settings — run after launching omp once)
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
- **`~/.omp/agent/config.yml` is deliberately not stowed.** omp rewrites it atomically (temp file + rename), and a rename replaces a symlink with a real file — the dotfiles copy would silently go stale on the first write. omp also persists its own UI toggles there, so the file is genuinely dynamic. `setup-omp.sh` applies the handful of settings worth reproducing instead. `AGENTS.md` *is* stowed: omp reads but never rewrites it.
- **`models.yml` cannot fix kiro's missing thinking ladder.** omp applies `modelOverrides` only to models its own registry produces (bundled catalog plus runtime discovery). Kiro models are registered by the plugin through `pi.registerProvider(...)`, a path the override merge never revisits — verified by overriding `name`, `contextWindow` and `thinking` on `kiro/claude-opus-5` and observing all three ignored, while the same overrides applied cleanly to `amazon-bedrock/anthropic.claude-opus-5`. The fix belongs in the provider plugin, which must publish `thinking` instead of the pi-era `thinkingLevelMap`.

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

