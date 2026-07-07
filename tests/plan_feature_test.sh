#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$ROOT/omnigent/harness-engineering/scripts/plan-feature.sh"
trap '[ -z "${TMP:-}" ] || rm -rf "$TMP"' EXIT

# Stub body shared by all three hosts: `<host> <subcommand-or-flag> <prompt>`
# (codex exec, claude -p, opencode run) all pass the prompt as arg 2. First
# call has no answer on file yet, so it "asks" a question and exits without
# touching DONEFILE; second call must see the folded-back question + answer
# in its prompt before it touches DONEFILE.
write_stub() {
  bin_dir=$1; host=$2
  cat > "$bin_dir/$host" <<'SH'
#!/bin/sh
set -eu
shift # drop the subcommand/flag ("exec" / "-p" / "run")
prompt=$1
count_file="$PWD/.harness/HOST-call-count"
count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")
count=$((count + 1)); printf '%s' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  echo "Which billing replacement do you want, plan A or plan B?"
  exit 0
fi
printf '%s' "$prompt" | grep -q 'Which billing replacement'
printf '%s' "$prompt" | grep -q 'plan A'
touch "$PWD/.harness/plan.done"
SH
  sed -i "s/HOST-call-count/$host-call-count/" "$bin_dir/$host"
  chmod +x "$bin_dir/$host"
}

wait_for_pid() {
  repo=$1
  [ -f "$repo/.harness/plan.pid" ] || return 0
  pid=$(cat "$repo/.harness/plan.pid")
  while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
}

# Full ask -> surface -> answer -> relaunch -> ready cycle, once per host.
for host in opencode codex claude; do
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-plan-feature-test.XXXXXX")
  mkdir -p "$TMP/bin" "$TMP/repo/.harness"
  write_stub "$TMP/bin" "$host"
  echo 'remove Stripe' > "$TMP/goal.txt"
  echo '<project_specification/>' > "$TMP/repo/project_specs.xml"
  cd "$TMP/repo"
  export PATH="$TMP/bin:/usr/bin:/bin"

  out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
  [ "$out" = "RUNNING $host" ]
  wait_for_pid "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
  echo "$out" | head -1 | grep -q '^ASKED$'
  echo "$out" | grep -q 'Which billing replacement'

  out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
  [ "$out" = "WAITING_FOR_ANSWER" ]

  printf '%s' 'plan A' | bash "$SCRIPT" answer "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
  [ "$out" = "RUNNING $host" ]
  wait_for_pid "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
  [ "$out" = "READY" ]
  [ -f "$TMP/repo/.harness/plan.done" ]

  rm -rf "$TMP"
  echo "ok - plan-feature.sh surfaces a stuck $host question and folds the human answer into a relaunch"
done

# Missing goal file: never dispatches a host, just reports it.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-plan-feature-test.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/repo"
write_stub "$TMP/bin" "opencode"
cd "$TMP/repo"
export PATH="$TMP/bin:/usr/bin:/bin"
out=$(bash "$SCRIPT" check "$TMP/repo" "$TMP/does-not-exist.txt")
echo "$out" | grep -q '^NO_GOAL_FILE '
[ ! -f "$TMP/repo/.harness/plan.pid" ]
rm -rf "$TMP"
echo 'ok - plan-feature.sh reports NO_GOAL_FILE and does not dispatch a host when the goal file is missing'

# No host on PATH at all.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-plan-feature-test.XXXXXX")
mkdir -p "$TMP/repo"
echo 'remove Stripe' > "$TMP/goal.txt"
out=$(cd "$TMP/repo" && PATH="/usr/bin:/bin" bash "$SCRIPT" check "$TMP/repo" "$TMP/goal.txt")
[ "$out" = "NO_HOST" ]
rm -rf "$TMP"
echo 'ok - plan-feature.sh reports NO_HOST when no coding CLI is on PATH'

# Monorepo case: the host CLI must scan $REPO, not the caller's cwd.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-plan-feature-test.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/monorepo/core"
echo 'remove Stripe' > "$TMP/goal.txt"
cat > "$TMP/bin/opencode" <<SH
#!/bin/sh
echo "\$PWD" > "$TMP/host-ran-in.txt"
touch "\$PWD/.harness/plan.done" 2>/dev/null || true
exit 0
SH
chmod +x "$TMP/bin/opencode"
mkdir -p "$TMP/monorepo/core/.harness"
cd "$TMP/monorepo"
export PATH="$TMP/bin:/usr/bin:/bin"
out=$(bash "$SCRIPT" check "$TMP/monorepo/core" "$TMP/goal.txt")
[ "$out" = "RUNNING opencode" ]
wait_for_pid "$TMP/monorepo/core"
[ "$(cat "$TMP/host-ran-in.txt")" = "$TMP/monorepo/core" ]
rm -rf "$TMP"
echo 'ok - plan-feature.sh runs the host CLI inside $REPO, not the callers cwd'
