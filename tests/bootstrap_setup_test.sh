#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$ROOT/omnigent/harness-engineering/scripts/bootstrap-setup.sh"
trap '[ -z "${TMP:-}" ] || rm -rf "$TMP"' EXIT

# Stub body shared by all three hosts: `<host> <subcommand-or-flag> <prompt>`
# (codex exec, claude -p, opencode run) all pass the prompt as arg 2. First
# call has no answer on file yet, so it "asks" a question and exits without
# writing project_specs.xml; second call must see the folded-back question
# + answer in its prompt before it writes the spec.
write_stub() {
  bin_dir=$1; host=$2
  cat > "$bin_dir/$host" <<SH
#!/bin/sh
set -eu
shift # drop the subcommand/flag ("exec" / "-p" / "run")
prompt=\$1
count_file="\$PWD/.harness/$host-call-count"
count=0; [ ! -f "\$count_file" ] || count=\$(cat "\$count_file")
count=\$((count + 1)); printf '%s' "\$count" > "\$count_file"
if [ "\$count" -eq 1 ]; then
  echo "Found projects: core, web. Which should I initialize?"
  exit 0
fi
printf '%s' "\$prompt" | grep -q 'Which should I initialize'
printf '%s' "\$prompt" | grep -q 'initialize core'
echo '<project_specification/>' > "\$PWD/project_specs.xml"
echo '[]' > "\$PWD/feature_list.json"
SH
  chmod +x "$bin_dir/$host"
}

wait_for_pid() {
  repo=$1
  [ -f "$repo/.harness/bootstrap.pid" ] || return 0
  pid=$(cat "$repo/.harness/bootstrap.pid")
  while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
}

# Full ask -> surface -> answer -> relaunch -> ready cycle, once per host, so
# the ASKED/WAITING_FOR_ANSWER relay logic is proven host-agnostic and not
# just something that happens to work for codex.
for host in opencode codex claude; do
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap-setup-test.XXXXXX")
  mkdir -p "$TMP/bin" "$TMP/repo"
  write_stub "$TMP/bin" "$host"
  cd "$TMP/repo"
  export PATH="$TMP/bin:/usr/bin:/bin"

  out=$(bash "$SCRIPT" check "$TMP/repo")
  [ "$out" = "RUNNING $host" ]
  wait_for_pid "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo")
  echo "$out" | head -1 | grep -q '^ASKED$'
  echo "$out" | grep -q 'Which should I initialize'

  out=$(bash "$SCRIPT" check "$TMP/repo")
  [ "$out" = "WAITING_FOR_ANSWER" ]

  printf '%s' 'initialize core' | bash "$SCRIPT" answer "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo")
  [ "$out" = "RUNNING $host" ]
  wait_for_pid "$TMP/repo"

  out=$(bash "$SCRIPT" check "$TMP/repo")
  [ "$out" = "READY" ]
  [ -f "$TMP/repo/project_specs.xml" ]
  [ -f "$TMP/repo/feature_list.json" ]

  rm -rf "$TMP"
  echo "ok - bootstrap-setup.sh surfaces a stuck $host question and folds the human answer into a relaunch"
done

# No host on PATH at all.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap-setup-test.XXXXXX")
mkdir -p "$TMP/repo"
out=$(cd "$TMP/repo" && PATH="/usr/bin:/bin" bash "$SCRIPT" check "$TMP/repo")
[ "$out" = "NO_HOST" ]
rm -rf "$TMP"
echo 'ok - bootstrap-setup.sh reports NO_HOST when no coding CLI is on PATH'

# All three on PATH: opencode is preferred (matches roles.example.json's own ordering).
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap-setup-test.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/repo"
for host in opencode codex claude; do write_stub "$TMP/bin" "$host"; done
out=$(cd "$TMP/repo" && PATH="$TMP/bin:/usr/bin:/bin" bash "$SCRIPT" check "$TMP/repo")
[ "$out" = "RUNNING opencode" ]
wait_for_pid "$TMP/repo"
rm -rf "$TMP"
echo 'ok - bootstrap-setup.sh prefers opencode when multiple hosts are installed'

# Monorepo case: the caller's cwd (where omni/the relay process lives, e.g. a
# monorepo root) must NOT be where the host CLI ends up scanning — it must
# scan $REPO (a subproject dir) regardless of the caller's cwd.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap-setup-test.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/monorepo/core"
cat > "$TMP/bin/opencode" <<SH
#!/bin/sh
echo "\$PWD" > "$TMP/host-ran-in.txt"
exit 0
SH
chmod +x "$TMP/bin/opencode"
cd "$TMP/monorepo"
export PATH="$TMP/bin:/usr/bin:/bin"
out=$(bash "$SCRIPT" check "$TMP/monorepo/core")
[ "$out" = "RUNNING opencode" ]
wait_for_pid "$TMP/monorepo/core"
[ "$(cat "$TMP/host-ran-in.txt")" = "$TMP/monorepo/core" ]
rm -rf "$TMP"
echo 'ok - bootstrap-setup.sh runs the host CLI inside $REPO, not the callers cwd'

# A host that dies after writing project_specs.xml but before feature_list.json
# (e.g. hit the timeout mid-initializer) must NOT be reported READY -- that's
# an unfinished setup, not a completed one, and the orchestrator's own
# reconcile --check gate would just stall on it with a confusing "amend/abort"
# input_required instead of a clean re-run.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap-setup-test.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/repo"
cat > "$TMP/bin/opencode" <<SH
#!/bin/sh
echo '<project_specification/>' > "\$PWD/project_specs.xml"
exit 0
SH
chmod +x "$TMP/bin/opencode"
cd "$TMP/repo"
export PATH="$TMP/bin:/usr/bin:/bin"
out=$(bash "$SCRIPT" check "$TMP/repo")
[ "$out" = "RUNNING opencode" ]
wait_for_pid "$TMP/repo"
[ -f "$TMP/repo/project_specs.xml" ]
[ ! -f "$TMP/repo/feature_list.json" ]
out=$(bash "$SCRIPT" check "$TMP/repo")
echo "$out" | head -1 | grep -q '^ASKED$'
rm -rf "$TMP"
echo 'ok - bootstrap-setup.sh does not report READY when feature_list.json is missing'
