# ~/.config/zsh/plugins.zsh

# =========================================================
  # Plugins
  # =========================================================

  ZPLUGINDIR="$XDG_CONFIG_HOME/zsh/plugins"

  _zplugin_load() {
    local org="$1"
    local plugin="$2"
    local plugin_path="${ZPLUGINDIR}/${plugin}"

    if [[ ! -d "$plugin_path" ]]; then
      mkdir -p "$ZPLUGINDIR"
      echo "Installing ${plugin}..."
      git clone --depth=1 "https://github.com/${org}/${plugin}" "$plugin_path" \
        || { echo "ERROR: failed to install ${plugin}" >&2; return 1; }
    fi
    source "${plugin_path}/${plugin}.plugin.zsh"
  }

  zplugin-update() {
    local dir
    for dir in "${ZPLUGINDIR}"/*/; do
      echo "Updating ${dir:t}..."
      git -C "$dir" pull --ff-only
    done
  }

  _zplugin_load zsh-users zsh-autosuggestions
  _zplugin_load zsh-users zsh-history-substring-search
  _zplugin_load zdharma-continuum fast-syntax-highlighting