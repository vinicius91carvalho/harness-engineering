#!/usr/bin/env bash
# Dispatches the planner skill in Feature mode to layer new Acceptance Checks
# onto an already-bootstrapped repo (project_specs.xml + feature_list.json
# must already exist), backgrounded so the relay's tool call returns
# immediately. Idempotent: safe to call every tick. Same check/answer/RUNNING/
# ASKED/WAITING_FOR_ANSWER contract as bootstrap-setup.sh -- see that script
# and skills/harness-relay/SKILL.md for how the relay reacts to each outcome.
#
# Goal text lives in a companion file (default: current-goal.txt next to this
# script) so relay messages stay short -- "plan check <repo>" -- with no goal
# text to retype per subproject or per tick.
set -euo pipefail

PLAN_TIMEOUT_SECONDS="${PLAN_TIMEOUT_SECONDS:-1800}"

cmd=${1:?"usage: plan-feature.sh check|answer <repo> [goal-file]"}
REPO=${2:?"usage: plan-feature.sh check|answer <repo> [goal-file]"}
REPO=$(CDPATH= cd -- "$REPO" && pwd)
GOAL_FILE=${3:-"$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/current-goal.txt"}
DIR="$REPO/.harness"
LOGFILE="$DIR/plan.log"
PIDFILE="$DIR/plan.pid"
HOSTFILE="$DIR/plan.host"
ANSWERFILE="$DIR/plan.answer"
AWAITFILE="$DIR/plan.awaiting"
DONEFILE="$DIR/plan.done"

mkdir -p "$DIR"

case "$cmd" in
  answer)
    cat > "$ANSWERFILE"
    exit 0
    ;;
  check)
    # The host touches DONEFILE itself as its last action on success -- there
    # is no fixed output filename to gate on (unlike setup's feature_list.json),
    # since Feature mode appends to files that already exist.
    if [ -f "$DONEFILE" ]; then
      rm -f "$PIDFILE" "$AWAITFILE" "$ANSWERFILE"
      echo READY
      exit 0
    fi

    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "RUNNING $(cat "$HOSTFILE" 2>/dev/null || echo host)"
      exit 0
    fi

    if [ -f "$PIDFILE" ]; then
      # job just died without touching DONEFILE -- surface why, once
      rm -f "$PIDFILE"
      : > "$AWAITFILE"
      echo ASKED
      tail -c 2000 "$LOGFILE" 2>/dev/null
      exit 0
    fi

    if [ -f "$AWAITFILE" ] && [ ! -f "$ANSWERFILE" ]; then
      echo WAITING_FOR_ANSWER
      exit 0
    fi

    if [ ! -f "$GOAL_FILE" ]; then
      echo "NO_GOAL_FILE $GOAL_FILE"
      exit 0
    fi

    host=""
    for candidate in opencode codex claude; do
      command -v "$candidate" >/dev/null 2>&1 && { host="$candidate"; break; }
    done
    if [ -z "$host" ]; then
      echo NO_HOST
      exit 0
    fi

    GOAL=$(cat "$GOAL_FILE")
    BASE_PROMPT="Load the installed planner skill and run it in Feature mode \
for this repository: project_specs.xml already exists -- do NOT re-grill on \
already-covered basics, do NOT touch application files. Append new \
Acceptance Checks for this feature, then commit on main:

$GOAL

You are running non-interactively: make reasonable product decisions \
yourself. If you would normally ask the user a question, print the question \
and options as your final output and stop instead -- do not guess, do not \
proceed on an assumed default. When you finish successfully (new checks \
appended and committed), run exactly this command as your last action: \
touch '$DONEFILE'"

    if [ -f "$AWAITFILE" ] && [ -f "$ANSWERFILE" ]; then
      PROMPT="$BASE_PROMPT

A prior attempt could not proceed non-interactively and asked:

$(tail -c 2000 "$LOGFILE" 2>/dev/null)

The user answered:

$(cat "$ANSWERFILE")

Proceed using that answer. Do not ask again; if another decision is
unavoidable, print the question as your final output and stop."
      rm -f "$AWAITFILE" "$ANSWERFILE"
    else
      PROMPT="$BASE_PROMPT"
    fi

    echo "$host" > "$HOSTFILE"
    cd "$REPO" # host CLI must scan $REPO, not the relay/omni server's own cwd (a monorepo root)
    case "$host" in
      codex)    nohup timeout "$PLAN_TIMEOUT_SECONDS" codex exec "$PROMPT" >"$LOGFILE" 2>&1 & ;;
      claude)   nohup timeout "$PLAN_TIMEOUT_SECONDS" claude -p "$PROMPT" >"$LOGFILE" 2>&1 & ;;
      opencode) nohup timeout "$PLAN_TIMEOUT_SECONDS" opencode run "$PROMPT" >"$LOGFILE" 2>&1 & ;;
    esac
    echo $! > "$PIDFILE"
    echo "RUNNING $host"
    ;;
  *)
    echo "usage: plan-feature.sh check|answer <repo> [goal-file]" >&2
    exit 1
    ;;
esac
