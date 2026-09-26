# =========================================================
# ~/.config/zsh/fzf.zsh
# =========================================================

if [[ -n "$FD_COMMAND" ]]; then
  export FZF_DEFAULT_COMMAND="$FD_COMMAND --type f --hidden --strip-cwd-prefix"
else
  export FZF_DEFAULT_COMMAND='find . -type f'
fi

# Ctrl-T uses the same file listing command.
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"

# UI
export FZF_DEFAULT_OPTS='
  --height=60%
  --layout=reverse
  --border=rounded
  --prompt="  "
  --pointer="  "
  --preview-window=right:65%:wrap:border-left
'

if [[ -n "$BAT_COMMAND" ]]; then
  export _FZF_PREVIEW_CMD="$BAT_COMMAND --color=always --style=plain,numbers --line-range=:500 {}"
else
  export _FZF_PREVIEW_CMD='cat {}'
fi
export FZF_CTRL_T_OPTS="--preview '$_FZF_PREVIEW_CMD'"

# Ctrl+F: file picker excluding hidden files
_fzf_file_no_hidden() {
  local cmd result
  cmd="${FZF_DEFAULT_COMMAND/--hidden /}"
  result=$(eval "${cmd:-find . -type f}" | fzf --preview "$_FZF_PREVIEW_CMD") \
    && LBUFFER+="$result"  # LBUFFER is the text left of the cursor
  zle reset-prompt
}
zle -N _fzf_file_no_hidden