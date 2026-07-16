#!/usr/bin/env bash
# Claude Code status line script
# Two lines:
#   line 1: [model] 📁 dir │ 🌿 branch (+worktrees)
#   line 2: <ctx bar> % (tokens) │ $cost │ ⏱ to 5h │ ⏱ to 7d │ 5h/7d limits │ tmux
# Context and cost segments are gated on numeric fields so empty/null payload
# columns cannot shift into the wrong slot (e.g. epoch shown as $cost).

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

dir_has_entries() {
  [ -d "$1" ] || return 1
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] && return 0
  done
  return 1
}

# ── Self-check: `statusline.sh --selftest` exercises the arithmetic helpers ───
if [ "$1" = "--selftest" ]; then
  [ "$(fmt_dur 423)"  = "7m 3s" ]      || { echo "fmt_dur 423 -> $(fmt_dur 423)"; exit 1; }
  [ "$(fmt_dur 3720)" = "1h 2m" ]      || { echo "fmt_dur 3720 -> $(fmt_dur 3720)"; exit 1; }
  [ "$(fmt_dur 0)"    = "now" ]        || { echo "fmt_dur 0 -> $(fmt_dur 0)"; exit 1; }
  [ "$(make_bar 42)"  = "████░░░░░░" ] || { echo "make_bar 42 -> $(make_bar 42)"; exit 1; }
  [ "$(make_bar 100)" = "██████████" ] || { echo "make_bar 100 -> $(make_bar 100)"; exit 1; }
  tmp_selftest=$(mktemp -d)
  trap 'rm -rf "$tmp_selftest"' EXIT
  mkdir -p "$tmp_selftest/bin" "$tmp_selftest/repo/.git"
  cat >"$tmp_selftest/bin/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$HARNESS_STATUSLINE_GIT_LOG"
case "$*" in
  *"rev-parse --abbrev-ref HEAD --show-toplevel"*)
    printf 'main\n%s\n' "$HARNESS_STATUSLINE_REPO"
    ;;
  *"rev-parse --git-common-dir"*)
    printf '%s\n' "$HARNESS_STATUSLINE_REPO/.git"
    ;;
  *"worktree list"*)
    echo 'unexpected worktree list' >&2
    exit 9
    ;;
esac
EOF
  chmod +x "$tmp_selftest/bin/git"
  reset_epoch=$(( $(date +%s) + 423 ))
  seven_reset_epoch=$(( $(date +%s) + 86400 ))
  payload=$(cat <<JSON
{"model":{"display_name":"Test Model"},"workspace":{"current_dir":"$tmp_selftest/repo"},"context_window":{"used_percentage":42,"total_input_tokens":12000,"total_output_tokens":3400,"context_window_size":200000},"cost":{"total_cost_usd":1.23},"rate_limits":{"five_hour":{"resets_at":$reset_epoch,"used_percentage":70},"seven_day":{"resets_at":$seven_reset_epoch,"used_percentage":20}}}
JSON
)
  export HARNESS_STATUSLINE_REPO="$tmp_selftest/repo"
  export HARNESS_STATUSLINE_GIT_LOG="$tmp_selftest/git.log"
  rendered=$(PATH="$tmp_selftest/bin:$PATH" bash "$0" <<<"$payload")
  printf '%s' "$rendered" | grep -q 'Test Model' || { echo "statusline missing model: $rendered"; exit 1; }
  printf '%s' "$rendered" | grep -q '42%' || { echo "statusline missing context: $rendered"; exit 1; }
  printf '%s' "$rendered" | grep -q '\$1.23' || { echo "statusline missing cost: $rendered"; exit 1; }
  printf '%s' "$rendered" | grep -q 'to 5h' || { echo "statusline missing 5h timer: $rendered"; exit 1; }
  printf '%s' "$rendered" | grep -q 'to 7d' || { echo "statusline missing 7d timer: $rendered"; exit 1; }
  printf '%s' "$rendered" | grep -q 'main' || { echo "statusline missing branch: $rendered"; exit 1; }
  ! grep -q 'worktree list' "$tmp_selftest/git.log" || { echo "statusline should skip worktree list for single-worktree repos"; exit 1; }

  null_ctx_payload=$(cat <<JSON
{"model":{"display_name":"Null Ctx"},"workspace":{"current_dir":"$tmp_selftest/repo"},"context_window":{"total_input_tokens":12000,"total_output_tokens":3400,"context_window_size":200000},"cost":{"total_cost_usd":2.50},"rate_limits":{"five_hour":{"resets_at":$reset_epoch,"used_percentage":70},"seven_day":{"used_percentage":20}}}
JSON
)
  null_ctx_rendered=$(PATH="$tmp_selftest/bin:$PATH" bash "$0" <<<"$null_ctx_payload")
  printf '%s' "$null_ctx_rendered" | grep -q '\$2.50' || { echo "null context missing cost: $null_ctx_rendered"; exit 1; }
  printf '%s' "$null_ctx_rendered" | grep -q '42%' && { echo "null context must not show context bar: $null_ctx_rendered"; exit 1; }
  printf '%s' "$null_ctx_rendered" | grep -qE '\$'"$reset_epoch" && { echo "null context showed epoch as cost: $null_ctx_rendered"; exit 1; }

  echo "selftest ok"; exit 0
fi

input=$(cat)

# One jq parse; use "-" sentinels so empty/null middle columns never shift TSV fields.
fields=$(printf '%s' "$input" | jq -r '[
  (.model.display_name // "-"),
  (.workspace.current_dir // .cwd // "-"),
  (if (.context_window.used_percentage | type) == "number" then .context_window.used_percentage else "-" end),
  (.context_window.total_input_tokens // 0),
  (.context_window.total_output_tokens // 0),
  (.context_window.context_window_size // 0),
  (if (.cost.total_cost_usd | type) == "number" then .cost.total_cost_usd else "-" end),
  (if (.rate_limits.five_hour.resets_at | type) == "number" then .rate_limits.five_hour.resets_at else "-" end),
  (if (.rate_limits.five_hour.used_percentage | type) == "number" then .rate_limits.five_hour.used_percentage else "-" end),
  (if (.rate_limits.seven_day.resets_at | type) == "number" then .rate_limits.seven_day.resets_at else "-" end),
  (if (.rate_limits.seven_day.used_percentage | type) == "number" then .rate_limits.seven_day.used_percentage else "-" end),
  (if (.rate_limits.monthly.used_percentage | type) == "number" then .rate_limits.monthly.used_percentage else "-" end)
] | @tsv')
IFS=$'\t' read -r model cwd used_pct total_in total_out ctx_size cost five_reset five_pct seven_reset seven_pct monthly_pct <<EOF
$fields
EOF
[ "$model" = "-" ] && model=""
[ "$cwd" = "-" ] && cwd=""
[ "$used_pct" = "-" ] && used_pct=""
[ "$cost" = "-" ] && cost=""
[ "$five_reset" = "-" ] && five_reset=""
[ "$five_pct" = "-" ] && five_pct=""
[ "$seven_reset" = "-" ] && seven_reset=""
[ "$seven_pct" = "-" ] && seven_pct=""
[ "$monthly_pct" = "-" ] && monthly_pct=""

# ── Model badge ───────────────────────────────────────────────────────────────
model_part=""
[ -n "$model" ] && model_part="${BOLD}${C_CYAN}[${model}]${RESET}"

# ── Directory ─────────────────────────────────────────────────────────────────
dir_part=""
[ -n "$cwd" ] && dir_part="📁 ${C_WHITE}$(basename "$cwd")${RESET}"

# ── Context window (bar + % + tokens) ─────────────────────────────────────────
ctx_part=""
if [[ "$used_pct" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  in_fmt=$(fmt_tokens "$total_in")
  out_fmt=$(fmt_tokens "$total_out")
  size_fmt=$(fmt_tokens "$ctx_size")
  ctx_part="$(pct_color "$used_pct")$(make_bar "$used_pct")${RESET} $(color_pct "$used_pct") ${DIM}(${in_fmt}in ${out_fmt}out / ${size_fmt})${RESET}"
fi

# ── Cost ──────────────────────────────────────────────────────────────────────
cost_part=""
if [[ "$cost" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  cost_fmt=$(printf "%.2f" "$cost" 2>/dev/null) || cost_fmt="$cost"
  cost_part="${C_GREEN}\$${cost_fmt}${RESET}"
fi

# ── Time until the 5-hour / 7-day rate-limit windows reset ────────────────────
reset_part=""
if [ -n "$five_reset" ]; then
  reset_part="⏱ $(fmt_dur "$(( five_reset - $(date +%s) ))")${DIM} to 5h${RESET}"
fi
seven_reset_part=""
if [ -n "$seven_reset" ]; then
  seven_reset_part="⏱ $(fmt_dur "$(( seven_reset - $(date +%s) ))")${DIM} to 7d${RESET}"
fi

# ── Rate-limit percentages ────────────────────────────────────────────────────
rate_part=""
[ -n "$five_pct"  ] && rate_part="${rate_part}${C_MAGENTA}5h${RESET} $(color_pct "$five_pct") "
[ -n "$seven_pct" ] && rate_part="${rate_part}${C_MAGENTA}7d${RESET} $(color_pct "$seven_pct") "
# Monthly is not a native field — appears automatically if Anthropic adds it.
[ -n "$monthly_pct" ] && rate_part="${rate_part}${C_MAGENTA}mo${RESET} $(color_pct "$monthly_pct") "
rate_part="${rate_part%% }"  # trim trailing space

# ── Git branch + worktrees ────────────────────────────────────────────────────
git_part=""
if [ -n "$cwd" ]; then
  git_meta=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD --show-toplevel 2>/dev/null || true)
  branch=${git_meta%%$'\n'*}
  top=${git_meta#*$'\n'}
  if [ -n "$branch" ] && [ -n "$top" ] && [ "$top" != "$git_meta" ]; then
    cur_wt=$(basename "$top")
    git_part="🌿 ${C_WHITE}${branch}${RESET} ${DIM}@${cur_wt}${RESET}"

    common_raw=$(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir 2>/dev/null || true)
    common_git=""
    case "$common_raw" in
      /*) common_git=$common_raw ;;
      ?*) common_git=$(CDPATH= cd -- "$cwd/$common_raw" 2>/dev/null && pwd -P) || common_git="" ;;
    esac
    if [ -n "$common_git" ] && dir_has_entries "$common_git/worktrees"; then
      all_wt=$(git -C "$cwd" --no-optional-locks worktree list --porcelain 2>/dev/null \
        | awk -v cur="$cur_wt" '
            /^worktree / { name=$2; sub(".*/","",name) }
            /^branch /   { br=$2; sub("refs/heads/","",br);
                           token=(name==cur?"*":"") br; out=out (out?" ":"") token; count++ }
            /^detached/  { token=(name==cur?"*":"") "(detached)"; out=out (out?" ":"") token; count++ }
            END { if (count > 1) print out }')
      if [ -n "$all_wt" ]; then
        git_part="${git_part} ${DIM}worktrees(${all_wt})${RESET}"
      fi
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
line2=$(join_parts "$ctx_part" "$cost_part" "$reset_part" "$seven_reset_part" "$rate_part" "$tmux_part")

if [ -n "$line1" ] && [ -n "$line2" ]; then
  printf "%b\n%b\n" "$line1" "$line2"
else
  printf "%b\n" "${line1}${line2}"
fi
