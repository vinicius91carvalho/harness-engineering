#!/usr/bin/env bash
# Claude Code status line script
# Two lines:
#   line 1: [model] 📁 dir │ 🌿 branch (+worktrees)
#   line 2: <ctx bar> % (tokens) │ $cost │ ⏱ time-until-5h-reset │ 5h/7d limits │ tmux

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
  local pct="$1" val
  val=$(printf "%.0f" "$pct" 2>/dev/null) || val=0
  if [ "$val" -ge 90 ]; then
    printf "${C_RED}${BOLD}%s%%${RESET}" "$val"
  elif [ "$val" -ge 70 ]; then
    printf "${C_YELLOW}%s%%${RESET}" "$val"
  else
    printf "${C_GREEN}%s%%${RESET}" "$val"
  fi
}

# ── Helper: ANSI color code for a percentage (for the bar) ───────────────────
pct_color() {
  local val
  val=$(printf "%.0f" "$1" 2>/dev/null) || val=0
  if [ "$val" -ge 90 ]; then printf "%b" "$C_RED"
  elif [ "$val" -ge 70 ]; then printf "%b" "$C_YELLOW"
  else printf "%b" "$C_GREEN"; fi
}

# ── Helper: 10-cell progress bar (█ filled, ░ empty), rounded ────────────────
make_bar() {
  local width=10 val filled empty bar="" i
  val=$(printf "%.0f" "$1" 2>/dev/null) || val=0
  [ "$val" -lt 0 ] && val=0; [ "$val" -gt 100 ] && val=100
  filled=$(( (val * width + 50) / 100 ))
  empty=$(( width - filled ))
  for ((i = 0; i < filled; i++)); do bar="${bar}█"; done
  for ((i = 0; i < empty; i++)); do bar="${bar}░"; done
  printf "%s" "$bar"
}

# ── Helper: humanize a seconds duration (e.g. 423 → "7m 3s") ─────────────────
fmt_dur() {
  local s="$1" h m sec
  [ "$s" -le 0 ] && { printf "now"; return; }
  h=$(( s / 3600 )); m=$(( (s % 3600) / 60 )); sec=$(( s % 60 ))
  if [ "$h" -gt 0 ]; then printf "%dh %dm" "$h" "$m"
  elif [ "$m" -gt 0 ]; then printf "%dm %ds" "$m" "$sec"
  else printf "%ds" "$sec"; fi
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

# ── Self-check: `statusline.sh --selftest` exercises the arithmetic helpers ───
if [ "$1" = "--selftest" ]; then
  [ "$(fmt_dur 423)"  = "7m 3s" ]      || { echo "fmt_dur 423 -> $(fmt_dur 423)"; exit 1; }
  [ "$(fmt_dur 3720)" = "1h 2m" ]      || { echo "fmt_dur 3720 -> $(fmt_dur 3720)"; exit 1; }
  [ "$(fmt_dur 0)"    = "now" ]        || { echo "fmt_dur 0 -> $(fmt_dur 0)"; exit 1; }
  [ "$(make_bar 42)"  = "████░░░░░░" ] || { echo "make_bar 42 -> $(make_bar 42)"; exit 1; }
  [ "$(make_bar 100)" = "██████████" ] || { echo "make_bar 100 -> $(make_bar 100)"; exit 1; }
  echo "selftest ok"; exit 0
fi

input=$(cat)

# ── Model badge ───────────────────────────────────────────────────────────────
model=$(echo "$input" | jq -r '.model.display_name // empty')
model_part=""
[ -n "$model" ] && model_part="${BOLD}${C_CYAN}[${model}]${RESET}"

# ── Directory ─────────────────────────────────────────────────────────────────
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
dir_part=""
[ -n "$cwd" ] && dir_part="📁 ${C_WHITE}$(basename "$cwd")${RESET}"

# ── Context window (bar + % + tokens) ─────────────────────────────────────────
used_pct=$(echo "$input"  | jq -r '.context_window.used_percentage      // empty')
total_in=$(echo "$input"  | jq -r '.context_window.total_input_tokens   // 0')
total_out=$(echo "$input" | jq -r '.context_window.total_output_tokens  // 0')
ctx_size=$(echo "$input"  | jq -r '.context_window.context_window_size  // 0')

ctx_part=""
if [ -n "$used_pct" ]; then
  in_fmt=$(fmt_tokens "$total_in")
  out_fmt=$(fmt_tokens "$total_out")
  size_fmt=$(fmt_tokens "$ctx_size")
  ctx_part="$(pct_color "$used_pct")$(make_bar "$used_pct")${RESET} $(color_pct "$used_pct") ${DIM}(${in_fmt}in ${out_fmt}out / ${size_fmt})${RESET}"
fi

# ── Cost ──────────────────────────────────────────────────────────────────────
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
cost_part=""
if [ -n "$cost" ]; then
  cost_fmt=$(printf "%.2f" "$cost" 2>/dev/null) || cost_fmt="$cost"
  cost_part="${C_GREEN}\$${cost_fmt}${RESET}"
fi

# ── Time until the 5-hour rate-limit window resets ───────────────────────────
five_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
reset_part=""
if [ -n "$five_reset" ]; then
  reset_part="⏱ $(fmt_dur "$(( five_reset - $(date +%s) ))")${DIM} to 5h${RESET}"
fi

# ── Rate-limit percentages ────────────────────────────────────────────────────
five_pct=$(echo "$input"  | jq -r '.rate_limits.five_hour.used_percentage  // empty')
seven_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage  // empty')
rate_part=""
[ -n "$five_pct"  ] && rate_part="${rate_part}${C_MAGENTA}5h${RESET} $(color_pct "$five_pct") "
[ -n "$seven_pct" ] && rate_part="${rate_part}${C_MAGENTA}7d${RESET} $(color_pct "$seven_pct") "
# Monthly is not a native field — appears automatically if Anthropic adds it.
monthly_pct=$(echo "$input" | jq -r '.rate_limits.monthly.used_percentage // empty')
[ -n "$monthly_pct" ] && rate_part="${rate_part}${C_MAGENTA}mo${RESET} $(color_pct "$monthly_pct") "
rate_part="${rate_part%% }"  # trim trailing space

# ── Git branch + worktrees ────────────────────────────────────────────────────
git_part=""
if [ -n "$cwd" ]; then
  branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    cur_wt=$(basename "$(git -C "$cwd" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)")
    git_part="🌿 ${C_WHITE}${branch}${RESET} ${DIM}@${cur_wt}${RESET}"

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

# ── Tmux session ──────────────────────────────────────────────────────────────
tmux_part=""
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null)
  [ -n "$tmux_session" ] && tmux_part="${C_YELLOW}tmux${RESET}${DIM}:${RESET}${C_YELLOW}${tmux_session}${RESET}"
fi

# ── Assemble: two lines (identity, then usage) ───────────────────────────────
# ponytail: always two lines (matches the screenshot); skipped measuring terminal
# width to decide 1-vs-2 — the harness has no width in the payload, two lines reads
# fine at any size.
join_parts() {
  local out="" p
  for p in "$@"; do
    [ -z "$p" ] && continue
    if [ -z "$out" ]; then out="$p"; else out="${out}  ${SEP}  ${p}"; fi
  done
  printf "%s" "$out"
}

id_part="$model_part"
[ -n "$dir_part" ] && id_part="${id_part:+$id_part }$dir_part"

line1=$(join_parts "$id_part" "$git_part")
line2=$(join_parts "$ctx_part" "$cost_part" "$reset_part" "$rate_part" "$tmux_part")

if [ -n "$line1" ] && [ -n "$line2" ]; then
  printf "%b\n%b\n" "$line1" "$line2"
else
  printf "%b\n" "${line1}${line2}"
fi
