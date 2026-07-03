#!/usr/bin/env bash
# claim.sh — atomic, cross-session coordination for parallel /generator runs.
#
# All shared state lives under the repo's single shared .git (so every worktree
# sees the same registry):
#   .git/generator-claims.json     map: context -> {branch,worktree,port,session,status,started,featureIds}
#   .git/harness-locks/generator-state  atomic mkdir lock for claim mutations
#   .git/harness-locks/generator-merge  mkdir mutex for serialized merges
#
# Requires: bash, git, jq. Atomic directory locks work on Linux, macOS, and Git Bash.
set -euo pipefail

BASE_PORT="${GEN_BASE_PORT:-5170}"
LEASE_TIMEOUT="${HARNESS_LEASE_TIMEOUT_SECONDS:-60}"

die() { echo "claim.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need git; need jq

gitdir()  { local d; d="$(git -C "$1" rev-parse --git-common-dir)"; case "$d" in /*) printf '%s' "$d";; *) printf '%s/%s' "$1" "$d";; esac; }  # absolute shared .git
gitroot() { git -C "$1" rev-parse --show-toplevel; }
project_prefix() { git -C "$1" rev-parse --show-prefix; }
project_id() { local p; p="$(project_prefix "$1")"; [ -n "$p" ] && sani "${p%/}" || printf root; }
claim_key() { local id; id="$(project_id "$1")"; [ "$id" = root ] && printf '%s' "$2" || printf '%s--%s' "$id" "$2"; }
claims()  { echo "$(gitdir "$1")/generator-claims.json"; }
stateld() { echo "$(gitdir "$1")/harness-locks/generator-state"; }
mergeld() { echo "$(gitdir "$1")/harness-locks/generator-merge"; }
rundir()  { echo "$(gitdir "$1")/harness-runs"; }
runstate(){ echo "$(rundir "$1")/$(sani "$2").json"; }
strikefile() { echo "$(rundir "$1")/strikes--$(project_id "$1").json"; }
sani()    { printf '%s' "$1" | tr -c 'a-zA-Z0-9_-' '_'; }
port_in_use() { (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1; }

read_claims() { local f; f="$(claims "$1")"; [ -s "$f" ] && cat "$f" || echo '{}'; }
write_claims() {
  local repo="$1" json="$2" file tmp
  file="$(claims "$repo")"; tmp="$file.tmp.${BASHPID:-$$}.$RANDOM"
  printf '%s\n' "$json" > "$tmp"; mv "$tmp" "$file"
}
write_runstate() {
  local repo="$1" ctx="$2" json="$3" file tmp
  mkdir -p "$(rundir "$repo")"
  file="$(runstate "$repo" "$ctx")"; tmp="$file.tmp.${BASHPID:-$$}.$RANDOM"
  printf '%s\n' "$json" > "$tmp"; mv "$tmp" "$file"
}
read_strikes() { local f; f="$(strikefile "$1")"; [ -s "$f" ] && cat "$f" || echo '{}'; }
write_strikes() {
  local repo="$1" json="$2" file tmp
  mkdir -p "$(rundir "$repo")"
  file="$(strikefile "$repo")"; tmp="$file.tmp.${BASHPID:-$$}.$RANDOM"
  printf '%s\n' "$json" > "$tmp"; mv "$tmp" "$file"
}

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
  local prefix project fl; prefix="$(project_prefix "$repo")"; project="$(project_id "$repo")"
  fl="$(git -C "$repo" show "main:${prefix}feature_list.json" 2>/dev/null || echo '')"
  [ -z "$fl" ] && return 0             # not scaffolded yet -> nothing to claim

  local pending_filter
  case "$mode" in
    qa)            pending_filter='.implementation==true and (.qa!=true or .integration!=true)' ;;
    *)             pending_filter='.integration!=true' ;;
  esac

  # A Work Item is ready only when every Acceptance Check dependency has passed
  # Integrated Verification. Legacy entries without dependencies remain ready.
  local ready
  ready="$(jq -c "[. as \$all | .[] | select($pending_filter) | select(
    (.depends_on // []) as \$deps |
    all(\$deps[]; . as \$dep | any(\$all[]; (.integration == true) and ((.acceptance_checks // []) | index(\$dep))))
  )]" <<<"$fl")"

  local cj; cj="$(read_claims "$repo")"
  # contexts with pending work, in first-appearance (priority) order, minus claimed ones
  local ctx=""
  if [ "$mode" = "feature" ]; then
    ctx="$selector"
  elif [ "$mode" = "task" ]; then
    ctx="$(jq -r --arg id "$selector" '.[] | select(.id==$id) | .context' <<<"$ready" | head -1)"
  else
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      local k; k="$(claim_key "$repo" "$c")"
      if [ "$(jq --arg c "$k" 'has($c)' <<<"$cj")" = "false" ]; then ctx="$c"; break; fi
    done < <(jq -r '.[].context' <<<"$ready" | awk '!seen[$0]++')
  fi
  [ -z "$ctx" ] && return 0
  local key; key="$(claim_key "$repo" "$ctx")"
  # guard: explicit context already claimed?
  [ "$(jq --arg c "$key" 'has($c)' <<<"$cj")" = "true" ] && return 0

  # feature ids to work on within the claim
  local ids
  case "$mode" in
    task) ids="$(jq -cn --arg id "$selector" '[$id]')" ;;
    *)    ids="$(jq -c --arg c "$ctx" '[.[] | select(.context==$c) | .id]' <<<"$ready")" ;;
  esac
  [ "$(jq 'length' <<<"$ids")" -eq 0 ] && return 0

  # unique port: BASE + smallest free slot among existing claims
  local used slot=0 port
  used="$(jq -r '[.[].port // empty] | @tsv' <<<"$cj")"
  while grep -qw "$((BASE_PORT+slot))" <<<"$used" || port_in_use "$((BASE_PORT+slot))"; do slot=$((slot+1)); done
  port=$((BASE_PORT+slot))

  local sctx checkout wt branch root
  root="$(gitroot "$repo")"; sctx="$(sani "$ctx")"; branch="gen/$project-$sctx"; checkout="${root%/}-wt-$project-$sctx"; wt="${checkout%/}/${prefix%/}"
  [ -n "$prefix" ] || wt="$checkout"
  if [ -d "$checkout" ]; then :                              # reuse stale worktree
  elif git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$checkout" "$branch" >/dev/null
  else
    git -C "$repo" worktree add "$checkout" -b "$branch" main >/dev/null || return 75
  fi

  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local next_claims
  next_claims="$(jq --arg c "$key" --arg b "$branch" --arg w "$wt" --argjson p "$port" \
     --arg s "$session" --arg t "$started" --argjson ids "$ids" \
     --arg project "$project" --arg context "$ctx" \
     '.[$c] = {branch:$b, worktree:$w,project:$project,context:$context,port:$p,session:$s,status:"building",started:$t,featureIds:$ids}' \
     <<<"$cj")"
  write_claims "$repo" "$next_claims"
  local epoch host
  epoch="$(date +%s)"; host="$(hostname 2>/dev/null || echo unknown)"
  write_runstate "$repo" "$key" "$(jq -cn --arg c "$ctx" --arg h "$host" --arg w "$wt" \
    --argjson p "$port" --argjson ids "$ids" --argjson e "$epoch" \
    '{context:$c,status:"claimed",phase:"claimed",ownerHost:$h,ownerPid:null,childPid:null,worktree:$w,port:$p,featureIds:$ids,attempt:1,nextAction:"start-orchestrator",heartbeatEpoch:$e}')"

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
  local key wt branch checkout; key="$(claim_key "$repo" "$ctx")"
  wt="$(jq -r --arg c "$key" '.[$c].worktree // empty' <<<"$(read_claims "$repo")")"
  branch="$(jq -r --arg c "$key" '.[$c].branch // empty' <<<"$(read_claims "$repo")")"
  checkout="$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$checkout" ] && git -C "$repo" worktree remove --force "$checkout" 2>/dev/null || true
  [ -n "$branch" ] && git -C "$repo" branch -D "$branch" 2>/dev/null || true
  write_claims "$repo" "$(jq --arg c "$key" 'del(.[$c])' <<<"$(read_claims "$repo")")"
  rm -f "$(runstate "$repo" "$key")"
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
  local repo="$1" session="${2:-$$}" ld current_host owner_host owner_pid; ld="$(mergeld "$repo")"
  mkdir -p "$(dirname "$ld")"
  if ! mkdir "$ld" 2>/dev/null; then
    current_host="$(hostname 2>/dev/null || echo unknown)"
    owner_host="$(cat "$ld/host" 2>/dev/null || true)"
    owner_pid="$(cat "$ld/owner" 2>/dev/null || true)"
    if [ "$owner_host" = "$current_host" ] && { [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; }; then
      rm -f "$ld/owner" "$ld/host"; rmdir "$ld" 2>/dev/null || true
      mkdir "$ld" 2>/dev/null || { echo "BUSY"; return 1; }
    else
      echo "BUSY"; return 1
    fi
  fi
  echo "$session" > "$ld/owner"
  hostname > "$ld/host" 2>/dev/null || echo unknown > "$ld/host"
  # integration dir = whichever worktree has main checked out, else create one
  local integ; integ="$(git -C "$repo" worktree list --porcelain | awk '
    /^worktree /{w=$2} /^branch refs\/heads\/main$/{print w; exit}')"
  if [ -z "$integ" ]; then
    integ="${repo%/}-wt-integration"
    [ -d "$integ" ] || git -C "$repo" worktree add "$integ" main >/dev/null
  fi
  local prefix; prefix="$(project_prefix "$repo")"
  [ -n "$prefix" ] && echo "${integ%/}/${prefix%/}" || echo "$integ"
}

# ---- merge-do <repo> <context> <integ-dir> ---------------------------------
# Attempts the merge in the integration dir. exit 0 = clean; 1 = operational failure; 2 = conflict.
merge_do() {
  local repo="$1" ctx="$2" integ="$3"
  local key branch output status unmerged; key="$(claim_key "$repo" "$ctx")"; branch="$(jq -r --arg c "$key" '.[$c].branch // empty' <<<"$(read_claims "$repo")")"
  [ -z "$branch" ] && branch="gen/$(project_id "$repo")-$(sani "$ctx")"
  set +e
  output="$(git -C "$integ" merge --no-edit "$branch" 2>&1)"; status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "clean"; return 0
  fi
  unmerged="$(git -C "$integ" diff --name-only --diff-filter=U)"
  if [ -z "$unmerged" ]; then
    echo "$output" >&2
    return 1
  fi
  echo "conflict in: $integ"
  echo "$unmerged"
  return 2
}

# ---- merge-release <repo> --------------------------------------------------
merge_release() {
  local ld owner session="${2:-}"; ld="$(mergeld "$1")"; owner="$(cat "$ld/owner" 2>/dev/null || true)"
  [ -z "$session" ] || [ "$owner" = "$session" ] || die "merge lock is owned by $owner"
  rm -f "$ld/owner" "$ld/host"; rmdir "$ld" 2>/dev/null || true; echo "merge-lock released"
}

# ---- block/resume ----------------------------------------------------------
block_claim_locked() {
  local repo="$1" ctx="$2" key cj state; key="$(claim_key "$repo" "$ctx")"
  cj="$(read_claims "$repo")"
  [ "$(jq --arg c "$key" 'has($c)' <<<"$cj")" = true ] || die "unknown claim: $ctx"
  write_claims "$repo" "$(jq --arg c "$key" '.[$c].status="blocked" | .[$c].session=""' <<<"$cj")"
  state="$(runstate "$repo" "$key")"
  if [ -s "$state" ]; then
    write_runstate "$repo" "$key" "$(jq '.status="blocked" | .phase="blocked" | .ownerPid=null | .childPid=null | .nextAction="user-guidance"' "$state")"
  fi
  echo "blocked $ctx"
}

block_claim() {
  local repo="$1" status
  acquire_state_lock "$repo"
  set +e; (set -e; block_claim_locked "$@"); status=$?; set -e
  release_state_lock "$repo"
  return "$status"
}

resume_claim_locked() {
  local repo="$1" selector="${2:-}" session="${3:-$$}" force="${4:-auto}"
  local cj ctx key state current_host owner_host owner_pid child_pid heartbeat now status live=false
  cj="$(read_claims "$repo")"
  if [ -n "$selector" ]; then ctx="$selector"; key="$(claim_key "$repo" "$ctx")"; else
    key="$(jq -r --arg p "$(project_id "$repo")" 'to_entries[] | select(.value.project==$p and .value.status=="building") | .key' <<<"$cj" | head -1)"
    ctx="$(jq -r --arg c "$key" '.[$c].context // empty' <<<"$cj")"
  fi
  [ -n "$ctx" ] || return 0
  [ "$(jq --arg c "$key" 'has($c)' <<<"$cj")" = true ] || return 0
  status="$(jq -r --arg c "$key" '.[$c].status' <<<"$cj")"
  [ "$status" != blocked ] || [ "$force" = force ] || { echo "BLOCKED $ctx requires explicit resume" >&2; return 0; }

  state="$(runstate "$repo" "$key")"; current_host="$(hostname 2>/dev/null || echo unknown)"
  if [ ! -s "$state" ]; then
    [ "$force" = force ] || { echo "STALE $ctx has no Run State and requires explicit takeover" >&2; return 0; }
  fi
  owner_host="$(jq -r '.ownerHost // empty' "$state" 2>/dev/null || true)"
  owner_pid="$(jq -r '.ownerPid // empty' "$state" 2>/dev/null || true)"
  child_pid="$(jq -r '.childPid // empty' "$state" 2>/dev/null || true)"
  heartbeat="$(jq -r '.heartbeatEpoch // 0' "$state" 2>/dev/null || echo 0)"
  local phase; phase="$(jq -r '.phase // empty' "$state" 2>/dev/null || true)"
  if [ "$owner_host" = "$current_host" ]; then
    { [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; } && live=true
    { [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; } && live=true
    [ "$live" = false ] || { echo "LIVE $ctx owner=$owner_pid child=$child_pid" >&2; return 0; }
    now="$(date +%s)"
    if [ "$phase" = claimed ] && [ $((now - heartbeat)) -lt "$LEASE_TIMEOUT" ] && [ "$force" != force ]; then
      echo "LIVE $ctx is waiting for its orchestrator to start" >&2; return 0
    fi
  elif [ -n "$owner_host" ]; then
    now="$(date +%s)"
    [ $((now - heartbeat)) -ge "$LEASE_TIMEOUT" ] || { echo "LIVE $ctx heartbeat is fresh on $owner_host" >&2; return 0; }
    [ "$force" = force ] || { echo "STALE $ctx on $owner_host requires explicit takeover" >&2; return 0; }
  fi

  write_claims "$repo" "$(jq --arg c "$key" --arg s "$session" '.[$c].status="building" | .[$c].session=$s' <<<"$cj")"
  if [ "$status" != blocked ] && [ -s "$state" ]; then
    write_runstate "$repo" "$key" "$(jq --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.previousPhase=.phase | .status="resuming" | .resumedAt=$t | .ownerPid=null | .childPid=null' "$state")"
  fi
  jq -c --arg c "$key" '.[$c] | {context,worktree,port,featureIds,resumed:true}' <<<"$(read_claims "$repo")"
}

resume_claim() {
  local repo="$1" status
  acquire_state_lock "$repo"
  set +e; (set -e; resume_claim_locked "$@"); status=$?; set -e
  release_state_lock "$repo"
  return "$status"
}

# ---- list <repo> -----------------------------------------------------------
list_claims() {
  local repo="$1" cj project; cj="$(read_claims "$repo")"; project="$(project_id "$repo")"
  cj="$(jq --arg p "$project" 'with_entries(select(.value.project==$p or (.value.project==null and $p=="root")))' <<<"$cj")"
  [ "$(jq 'length' <<<"$cj")" -eq 0 ] && { echo "no active claims"; return 0; }
  while IFS=$'\t' read -r key ctx line; do
    local state phase attempt next heartbeat child app
    state="$(runstate "$repo" "$key")"
    phase="$(jq -r '.phase // "-"' "$state" 2>/dev/null || echo -)"
    attempt="$(jq -r '.attempt // "-"' "$state" 2>/dev/null || echo -)"
    next="$(jq -r '.nextAction // "-"' "$state" 2>/dev/null || echo -)"
    heartbeat="$(jq -r '.heartbeat // "-"' "$state" 2>/dev/null || echo -)"
    child="$(jq -r '.childPid // "-"' "$state" 2>/dev/null || echo -)"
    app="$(jq -r '.appPid // "-"' "$state" 2>/dev/null || echo -)"
    printf '%s\t%s\tphase=%s\tattempt=%s\tnext=%s\tchild=%s\tapp=%s\theartbeat=%s\n' "$ctx" "$line" "$phase" "$attempt" "$next" "$child" "$app" "$heartbeat"
  done < <(jq -r 'to_entries[] | [.key, (.value.context // .key), "tasks=\(.value.featureIds // [] | join(","))\tport=\(.value.port)\t\(.value.status)\t\(.value.worktree)"] | @tsv' <<<"$cj")
}

# ---- strike <repo> <key> <delta> -------------------------------------------
strike_locked() {
  local repo="$1" key="$2" delta="$3"
  write_strikes "$repo" "$(jq --arg k "$key" --argjson d "$delta" \
    '.[$k] = ([((.[$k]//0) + $d), 0] | max)' <<<"$(read_strikes "$repo")")"
}

strike() {
  local repo="$1" status
  acquire_state_lock "$repo"
  set +e; (set -e; strike_locked "$@"); status=$?; set -e
  release_state_lock "$repo"
  return "$status"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  select-claim)  select_claim "$@" ;;
  resume)        resume_claim "$@" ;;
  block)         block_claim "$@" ;;
  release)       release "$@" ;;
  merge-acquire) merge_acquire "$@" ;;
  merge-do)      merge_do "$@" ;;
  merge-release) merge_release "$@" ;;
  list)          list_claims "$@" ;;
  strike)        strike "$@" ;;
  strikes)       read_strikes "$@" ;;
  *) die "usage: claim.sh {select-claim|resume|block|release|merge-acquire|merge-do|merge-release|list|strike|strikes} <repo> ..." ;;
esac
