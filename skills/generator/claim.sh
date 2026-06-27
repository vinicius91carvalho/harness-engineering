#!/usr/bin/env bash
# claim.sh — atomic, cross-session coordination for parallel /generator runs.
#
# All shared state lives under the repo's single shared .git (so every worktree
# sees the same registry):
#   .git/generator-claims.json     map: context -> {branch,worktree,port,session,status,started}
#   .git/harness-locks/generator-state  atomic mkdir lock for claim mutations
#   .git/harness-locks/generator-merge  mkdir mutex for serialized merges
#
# Requires: bash, git, jq. Atomic directory locks work on Linux, macOS, and Git Bash.
set -euo pipefail

BASE_PORT="${GEN_BASE_PORT:-5170}"

die() { echo "claim.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need git; need jq

gitdir()  { local d; d="$(git -C "$1" rev-parse --git-common-dir)"; case "$d" in /*) printf '%s' "$d";; *) printf '%s/%s' "$1" "$d";; esac; }  # absolute shared .git
claims()  { echo "$(gitdir "$1")/generator-claims.json"; }
stateld() { echo "$(gitdir "$1")/harness-locks/generator-state"; }
mergeld() { echo "$(gitdir "$1")/harness-locks/generator-merge"; }
sani()    { printf '%s' "$1" | tr -c 'a-zA-Z0-9_-' '_'; }

read_claims() { local f; f="$(claims "$1")"; [ -s "$f" ] && cat "$f" || echo '{}'; }

acquire_state_lock() {
  local repo="$1" ld tries=0 token; ld="$(stateld "$repo")"
  mkdir -p "$(dirname "$ld")"
  token="${BASHPID:-$$}.$RANDOM.$(date +%s)"
  while :; do
    if mkdir "$ld" 2>/dev/null; then
      printf '%s\n' "$token" > "$ld/owner"
      sleep 0.02
      if [ "$(cat "$ld/owner" 2>/dev/null || true)" = "$token" ]; then
        STATE_LOCK_TOKEN=$token
        return 0
      fi
    fi
    tries=$((tries + 1)); [ "$tries" -lt 300 ] || die "timed out waiting for state lock: $ld"
    sleep 0.1
  done
}
release_state_lock() {
  local ld owner; ld="$(stateld "$1")"; owner="$(cat "$ld/owner" 2>/dev/null || true)"
  [ -n "${STATE_LOCK_TOKEN:-}" ] && [ "$owner" = "$STATE_LOCK_TOKEN" ] || return 0
  rm -f "$ld/owner"; rmdir "$ld" 2>/dev/null || true
}

# ---- select-claim <repo> <mode> <selector> <session> -----------------------
# Picks the next eligible context, creates its worktree+branch, records the claim,
# prints {context,worktree,port,featureIds}. Prints NOTHING when there's no work.
select_claim_locked() {
  local repo="$1" mode="$2" selector="${3:-}" session="${4:-$$}"
  local fl; fl="$(git -C "$repo" show main:feature_list.json 2>/dev/null || echo '')"
  [ -z "$fl" ] && return 0             # not scaffolded yet -> nothing to claim

  local pending_filter
  case "$mode" in
    qa)            pending_filter='.implementation==true and .qa==false' ;;
    *)             pending_filter='.implementation==false or .qa==false' ;;
  esac

  local cj; cj="$(read_claims "$repo")"
  # contexts with pending work, in first-appearance (priority) order, minus claimed ones
  local ctx=""
  if [ "$mode" = "feature" ]; then
    ctx="$selector"
  elif [ "$mode" = "task" ]; then
    ctx="$(jq -r --arg id "$selector" '.[] | select(.id==$id) | .context' <<<"$fl" | head -1)"
  else
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      if [ "$(jq --arg c "$c" 'has($c)' <<<"$cj")" = "false" ]; then ctx="$c"; break; fi
    done < <(jq -r "[.[] | select($pending_filter)] | .[].context" <<<"$fl" | awk '!seen[$0]++')
  fi
  [ -z "$ctx" ] && return 0
  # guard: explicit context already claimed?
  [ "$(jq --arg c "$ctx" 'has($c)' <<<"$cj")" = "true" ] && return 0

  # feature ids to work on within the claim
  local ids
  case "$mode" in
    task) ids="$(jq -cn --arg id "$selector" '[$id]')" ;;
    qa)   ids="$(jq -c --arg c "$ctx" "[.[] | select(.context==\$c and (.implementation==true and .qa==false)) | .id]" <<<"$fl")" ;;
    *)    ids="$(jq -c --arg c "$ctx" "[.[] | select(.context==\$c and ($pending_filter)) | .id]" <<<"$fl")" ;;
  esac
  [ "$(jq 'length' <<<"$ids")" -eq 0 ] && return 0

  # unique port: BASE + smallest free slot among existing claims
  local used slot=0 port
  used="$(jq -r '[.[].port // empty] | @tsv' <<<"$cj")"
  while grep -qw "$((BASE_PORT+slot))" <<<"$used"; do slot=$((slot+1)); done
  port=$((BASE_PORT+slot))

  local sctx wt branch
  sctx="$(sani "$ctx")"; branch="gen/$sctx"; wt="${repo%/}-wt-$sctx"
  if [ -d "$wt" ]; then :                                   # reuse stale worktree
  elif git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$wt" "$branch" >/dev/null
  else
    git -C "$repo" worktree add "$wt" -b "$branch" main >/dev/null || return 75
  fi

  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq --arg c "$ctx" --arg b "$branch" --arg w "$wt" --argjson p "$port" \
     --arg s "$session" --arg t "$started" \
     '.[$c] = {branch:$b, worktree:$w, port:$p, session:$s, status:"building", started:$t}' \
     <<<"$cj" > "$(claims "$repo")"

  jq -cn --arg c "$ctx" --arg w "$wt" --argjson p "$port" --argjson ids "$ids" \
     '{context:$c, worktree:$w, port:$p, featureIds:$ids}'
}

select_claim() {
  local repo="$1" status attempts=0
  while :; do
    acquire_state_lock "$repo"
    trap 'release_state_lock "$repo"; exit 130' HUP INT TERM
    set +e
    (set -e; select_claim_locked "$@")
    status=$?
    set -e
    release_state_lock "$repo"
    trap - HUP INT TERM
    [ "$status" -ne 75 ] && return "$status"
    attempts=$((attempts + 1)); [ "$attempts" -lt 10 ] || return 75
    sleep 0.05
  done
}

# ---- release <repo> <context> ----------------------------------------------
release_locked() {
  local repo="$1" ctx="$2"
  local wt branch
  wt="$(jq -r --arg c "$ctx" '.[$c].worktree // empty' <<<"$(read_claims "$repo")")"
  branch="$(jq -r --arg c "$ctx" '.[$c].branch // empty' <<<"$(read_claims "$repo")")"
  [ -n "$wt" ] && git -C "$repo" worktree remove --force "$wt" 2>/dev/null || true
  [ -n "$branch" ] && git -C "$repo" branch -D "$branch" 2>/dev/null || true
  jq --arg c "$ctx" 'del(.[$c])' <<<"$(read_claims "$repo")" > "$(claims "$repo")"
  echo "released $ctx"
}

release() {
  local repo="$1" status
  acquire_state_lock "$repo"
  trap 'release_state_lock "$repo"; exit 130' HUP INT TERM
  set +e
  (set -e; release_locked "$@")
  status=$?
  set -e
  release_state_lock "$repo"
  trap - HUP INT TERM
  return "$status"
}

# ---- merge-acquire <repo> <session> ----------------------------------------
# Serializes merges across sessions (mkdir mutex survives across skill steps).
# Prints the integration worktree dir (a checkout of main) on success.
merge_acquire() {
  local repo="$1" session="${2:-$$}" ld; ld="$(mergeld "$repo")"
  mkdir -p "$(dirname "$ld")"
  if ! mkdir "$ld" 2>/dev/null; then
    echo "BUSY"; return 1
  fi
  echo "$session" > "$ld/owner"
  # integration dir = whichever worktree has main checked out, else create one
  local integ; integ="$(git -C "$repo" worktree list --porcelain | awk '
    /^worktree /{w=$2} /^branch refs\/heads\/main$/{print w; exit}')"
  if [ -z "$integ" ]; then
    integ="${repo%/}-wt-integration"
    [ -d "$integ" ] || git -C "$repo" worktree add "$integ" main >/dev/null
  fi
  echo "$integ"
}

# ---- merge-do <repo> <context> <integ-dir> ---------------------------------
# Attempts the merge in the integration dir. exit 0 = clean; exit 2 = conflict.
merge_do() {
  local repo="$1" ctx="$2" integ="$3"
  local branch; branch="$(jq -r --arg c "$ctx" '.[$c].branch // empty' <<<"$(read_claims "$repo")")"
  [ -z "$branch" ] && branch="gen/$(sani "$ctx")"
  if git -C "$integ" merge --no-edit "$branch" >/dev/null 2>&1; then
    echo "clean"; return 0
  fi
  echo "conflict in: $integ"
  git -C "$integ" diff --name-only --diff-filter=U
  return 2
}

# ---- merge-release <repo> --------------------------------------------------
merge_release() { local ld; ld="$(mergeld "$1")"; rm -f "$ld/owner"; rmdir "$ld" 2>/dev/null || true; echo "merge-lock released"; }

# ---- list <repo> -----------------------------------------------------------
list_claims() {
  local cj; cj="$(read_claims "$1")"
  [ "$(jq 'length' <<<"$cj")" -eq 0 ] && { echo "no active claims"; return 0; }
  jq -r 'to_entries[] | "\(.key)\tport=\(.value.port)\t\(.value.status)\t\(.value.worktree)"' <<<"$cj"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  select-claim)  select_claim "$@" ;;
  release)       release "$@" ;;
  merge-acquire) merge_acquire "$@" ;;
  merge-do)      merge_do "$@" ;;
  merge-release) merge_release "$@" ;;
  list)          list_claims "$@" ;;
  *) die "usage: claim.sh {select-claim|release|merge-acquire|merge-do|merge-release|list} <repo> ..." ;;
esac
