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

### macOS and Ubuntu

Run the installer in a terminal:

```sh
~/dotfiles/install.sh
```

The wizard offers two editable starting profiles. **Personal** selects the full
personal setup, including desktop apps, fonts, and Ollama. **Server** selects
shell and command-line tools, with desktop apps and local AI turned off. macOS
defaults to Personal; Ubuntu defaults to Server. Both offer every supported
package. The profile only sets the initial selections.

Each profile keeps its own software, config, and login-shell draft during the
run. Switch profiles from the final review to customize either draft or
restore your earlier edits. A new run starts from the original defaults.
Unchecking software or a config skips it; it does not uninstall or unlink
anything already on the machine. Node remains selected for the wizard.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move between options |
| `←` / `→` | Collapse or expand a package group |
| `Space` | Toggle an item, a group, or Select all |
| `Tab` or `Enter` | Accept choices and advance |
| `Shift+Tab` | Go back without discarding edits |
| `Ctrl+C` | Cancel |

The header shows the five stages and highlights the current step. Framed
prompts show the focused option, selection markers, and package group counts.
Controls sit directly below each prompt. Unavailable packages and configs
are disabled. The final review shows installation routes, download
sources, permission requirements, Stow targets, backups, and shell changes.
Edit any section directly or switch profiles before approving.

On the review screen, `Tab` moves between actions and never installs.
`Page Up` / `Page Down` scroll the plan; `Home` / `End` jump to its ends.
Select **Install** and press `Enter` to approve. There is no second general
confirmation in Bash. Security questions about Homebrew tap trust or
community-built Ghostty packages still require separate consent.

Cancelling skips the selected installation actions. An approved Node or
Homebrew bootstrap performed before the wizard remains installed.

On Ubuntu, APT installs selected system packages and the installer uses the
existing upstream routes for Starship, mise, Bun, OMP, Herdr, Ollama, and
language tools. Ghostty on Ubuntu 24.04 uses a community-built `.deb` and
requires a separate confirmation. On macOS, Homebrew installs only selected
Brewfile entries. The wizard reuses Node 20.12 or later with npm when present.
Otherwise it asks before bootstrapping Homebrew's Node on macOS or mise's
Node 22 on Ubuntu. The temporary wizard installation and npm cache are
removed when the installer exits; approved bootstrap installations remain.

Installing packages can use `sudo` and affect all accounts on the machine.
Stow links, shell startup edits, and a login-shell change affect the account
running the installer. The installer backs up conflicting files before
linking dotfiles. It does not configure the machine's services. For a shared
login, shell history and the account's configs are shared too; use separate
accounts when users need isolation.

For scripts and remote automation, the wizard is skipped when stdin or stdout
is not a terminal. macOS then uses the Personal defaults; Ubuntu uses Server.
Override the profile with `INSTALL_PROFILE=personal` or
`INSTALL_PROFILE=server`. Review the default selections before running the
installer non-interactively.

Open tmux and press `` ` `` then `I` to install plugins.

Configure OMP separately on each machine. Log in and launch it once so OMP
creates `config.yml`, then run the setup script:

```sh
omp
~/dotfiles/setup-omp.sh
```
The script applies your portable model, appearance, behavior, and plugin
settings. Provider login remains local to each machine. The script leaves
machine-specific paths and extension enablement unchanged.

The `pi` command and OMP's `omp` command can coexist. Pi's tracked configuration
is `pi/.pi/` and is applied only when selected. Launch `pi` once after
installation so it can install the packages in
`~/.pi/agent/settings.json`.

`setup-omp.sh` applies the portable settings from your current OMP config. It
does not copy authentication, UI state, machine-specific paths, or extension
choices. It updates the listed settings in the existing config file.

### Wizard development

Edit `install-wizard/cli.ts`, then regenerate `install-wizard/cli.js`.
Keep the compiled file in the repository so setup machines do not need
TypeScript or development dependencies.

```sh
npm --prefix install-wizard ci
npm --prefix install-wizard run build
python3 install-wizard/test_wizard.py
```

The terminal checks exercise the compiled wizard and its read-only planner.
They do not install system packages or change your account.

To inspect installation actions without opening the wizard or applying them:

```sh
bash install.sh --review-plan ubuntu server 'node zsh starship tmux' 'zsh starship tmux' 1
```



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
- **`~/.omp/agent/config.yml` is deliberately not stowed.** OMP rewrites it atomically and stores machine-local UI state there. `setup-omp.sh` applies selected portable settings without replacing the file. `AGENTS.md` is stowed because OMP reads but never rewrites it.
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

