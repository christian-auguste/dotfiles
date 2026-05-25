. "$HOME/.cargo/env"

# Added by AIM CLI
export PATH="$HOME/.aim/mcp-servers:$PATH"

# Set XDG_HOME_CONFIG var
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

[[ -f "$XDG_CONFIG_HOME/zsh/.zshenv" ]] && source "$XDG_CONFIG_HOME/zsh/.zshenv"
