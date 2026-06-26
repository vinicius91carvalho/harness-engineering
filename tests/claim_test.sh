#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-claim-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo"
git -C "$TMP/repo" init -b main -q
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
cat >"$TMP/repo/feature_list.json" <<'JSON'
[
  {"id":"A","context":"alpha","implementation":false,"qa":false},
  {"id":"B","context":"beta","implementation":false,"qa":false}
]
JSON
git -C "$TMP/repo" add feature_list.json
git -C "$TMP/repo" commit -qm init

bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" all '' 1001 >"$TMP/one.json" &
p1=$!
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" all '' 1002 >"$TMP/two.json" &
p2=$!
wait "$p1"; wait "$p2"

jq -s -e 'length == 2 and (map(.context) | unique | length) == 2 and (map(.port) | unique | length) == 2' \
  "$TMP/one.json" "$TMP/two.json" >/dev/null
test ! -d "$TMP/repo/.git/harness-locks/generator-state"
echo 'ok - atomic directory claims assign distinct contexts and ports'
