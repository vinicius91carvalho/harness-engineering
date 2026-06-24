#!/usr/bin/env bash
# Claude Code status line script
# Displays: context %, rate limits, token counts, git branch, worktrees, tmux session

input=$(cat)

# ── ANSI colors (will be dimmed by Claude Code) ──────────────────────────────
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"

C_CYAN="\033[36m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_MAGENTA="\033[35m"
C_BLUE="\033[34m"
C_WHITE="\033[37m"

SEP="${DIM}│${RESET}"

# ── Helper: color a percentage value ─────────────────────────────────────────
color_pct() {
  local pct="$1"
  local val
  val=$(printf "%.0f" "$pct" 2>/dev/null) || val=0
  if [ "$val" -ge 90 ]; then
    printf "${C_RED}${BOLD}%s%%${RESET}" "$val"
  elif [ "$val" -ge 70 ]; then
    printf "${C_YELLOW}%s%%${RESET}" "$val"
  else
    printf "${C_GREEN}%s%%${RESET}" "$val"
  fi
}

# ── Helper: format token count (e.g. 123456 → 123k) ─────────────────────────
fmt_tokens() {
  local n="$1"
  if [ -z "$n" ] || [ "$n" = "null" ]; then echo "0"; return; fi
  if [ "$n" -ge 1000000 ]; then
    printf "%.1fM" "$(echo "scale=1; $n/1000000" | bc)"
  elif [ "$n" -ge 1000 ]; then
    printf "%dk" "$(( n / 1000 ))"
  else
    echo "$n"
  fi
}

# ── 1. Context window ─────────────────────────────────────────────────────────
used_pct=$(echo "$input"   | jq -r '.context_window.used_percentage      // empty')
total_in=$(echo "$input"   | jq -r '.context_window.total_input_tokens   // 0')
total_out=$(echo "$input"  | jq -r '.context_window.total_output_tokens  // 0')
ctx_size=$(echo "$input"   | jq -r '.context_window.context_window_size  // 0')

ctx_part=""
if [ -n "$used_pct" ]; then
  colored=$(color_pct "$used_pct")
  in_fmt=$(fmt_tokens "$total_in")
  out_fmt=$(fmt_tokens "$total_out")
  size_fmt=$(fmt_tokens "$ctx_size")
  ctx_part="${C_CYAN}ctx${RESET} ${colored} ${DIM}(${in_fmt}in ${out_fmt}out / ${size_fmt})${RESET}"
fi

# ── 2. Rate limits ────────────────────────────────────────────────────────────
five_pct=$(echo "$input"  | jq -r '.rate_limits.five_hour.used_percentage  // empty')
seven_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage  // empty')

# Monthly is not a native field — we derive it from 7-day when available,
# and label it clearly. If Claude.ai ever exposes monthly data it will be here.
rate_part=""
[ -n "$five_pct"  ] && rate_part="${rate_part}${C_MAGENTA}5h${RESET} $(color_pct "$five_pct") "
[ -n "$seven_pct" ] && rate_part="${rate_part}${C_MAGENTA}7d${RESET} $(color_pct "$seven_pct") "
# Monthly field (not yet in API — placeholder shown only if key exists)
monthly_pct=$(echo "$input" | jq -r '.rate_limits.monthly.used_percentage // empty')
[ -n "$monthly_pct" ] && rate_part="${rate_part}${C_MAGENTA}mo${RESET} $(color_pct "$monthly_pct") "
rate_part="${rate_part%% }"  # trim trailing space

# ── 3. Git branch + worktrees ─────────────────────────────────────────────────
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')

git_part=""
if [ -n "$cwd" ]; then
  branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    # Current worktree = basename of this worktree's toplevel
    cur_wt=$(basename "$(git -C "$cwd" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)")
    git_part="${C_BLUE}${RESET} ${C_WHITE}${branch}${RESET} ${DIM}@${cur_wt}${RESET}"

    # All worktrees, current one marked with *
    all_wt=$(git -C "$cwd" --no-optional-locks worktree list --porcelain 2>/dev/null \
      | awk -v cur="$cur_wt" '
          /^worktree / { name=$2; sub(".*/","",name) }
          /^branch /   { br=$2; sub("refs/heads/","",br);
                         printf "%s%s ", (name==cur?"*":""), br }
          /^detached/  { printf "%s(detached) ", (name==cur?"*":"") }' \
      | sed 's/ $//')
    if [ -n "$all_wt" ] && [ "$(echo "$all_wt" | wc -w | tr -d ' ')" -gt 1 ]; then
      git_part="${git_part} ${DIM}worktrees(${all_wt})${RESET}"
    fi
  fi
fi

# ── 4. Tmux session ───────────────────────────────────────────────────────────
tmux_part=""
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null)
  [ -n "$tmux_session" ] && tmux_part="${C_YELLOW}tmux${RESET}${DIM}:${RESET}${C_YELLOW}${tmux_session}${RESET}"
fi

# ── Assemble output ────────────────────────────────────────────────────────────
parts=()
[ -n "$ctx_part"  ] && parts+=("$ctx_part")
[ -n "$rate_part" ] && parts+=("$rate_part")
[ -n "$git_part"  ] && parts+=("$git_part")
[ -n "$tmux_part" ] && parts+=("$tmux_part")

out=""
for part in "${parts[@]}"; do
  if [ -z "$out" ]; then
    out="$part"
  else
    out="${out}  ${SEP}  ${part}"
  fi
done

printf "%b\n" "$out"
