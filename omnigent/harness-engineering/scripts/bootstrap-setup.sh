#!/usr/bin/env bash
# Bootstraps project_specs.xml via the first available full-context host
# (opencode/codex/claude, same preference order as roles.example.json),
# backgrounded so the relay's tool call returns immediately. Idempotent:
# safe to call every tick. See skills/harness-relay/SKILL.md for how the
# relay reacts to each outcome.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TIMEOUT="$SCRIPT_DIR/portable-timeout.sh"

BOOTSTRAP_TIMEOUT_SECONDS="${BOOTSTRAP_TIMEOUT_SECONDS:-1800}"

cmd=${1:?"usage: bootstrap-setup.sh check|answer <repo>"}
REPO=${2:?"usage: bootstrap-setup.sh check|answer <repo>"}
REPO=$(CDPATH= cd -- "$REPO" && pwd)
DIR="$REPO/.harness"
LOGFILE="$DIR/bootstrap.log"
PIDFILE="$DIR/bootstrap.pid"
HOSTFILE="$DIR/bootstrap.host"
ANSWERFILE="$DIR/bootstrap.answer"
AWAITFILE="$DIR/bootstrap.awaiting"

mkdir -p "$DIR"

# tail -c cuts at a byte offset, which can slice a multi-byte UTF-8 character
# in half (opencode/codex/claude TUI output is full of box-drawing/Unicode).
# A half character embedded back into a host CLI prompt argument fails with
# "invalid UTF-8 was detected in one or more arguments" and kills the job.
log_tail() {
  tail -c 2000 "$LOGFILE" 2>/dev/null | iconv -f utf-8 -t utf-8 -c 2>/dev/null || true
}

case "$cmd" in
  answer)
    cat > "$ANSWERFILE"
    exit 0
    ;;
  check)
    # feature_list.json is setup's own stop condition (skills/setup/SKILL.md
    # step 5-6) — project_specs.xml alone can exist mid-run if the host died
    # after writing the spec but before scaffolding+committing feature_list.json.
    if [ -f "$REPO/project_specs.xml" ] && [ -f "$REPO/feature_list.json" ]; then
      rm -f "$PIDFILE" "$AWAITFILE" "$ANSWERFILE"
      echo READY
      exit 0
    fi

    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "RUNNING $(cat "$HOSTFILE" 2>/dev/null || echo host)"
      exit 0
    fi

    if [ -f "$PIDFILE" ]; then
      # job just died without producing a spec — surface why, once
      rm -f "$PIDFILE"
      : > "$AWAITFILE"
      echo ASKED
      log_tail
      exit 0
    fi

    if [ -f "$AWAITFILE" ] && [ ! -f "$ANSWERFILE" ]; then
      echo WAITING_FOR_ANSWER
      exit 0
    fi

    host=""
    for candidate in opencode codex claude agent; do
      command -v "$candidate" >/dev/null 2>&1 && { host="$candidate"; break; }
    done
    if [ -z "$host" ]; then
      echo NO_HOST
      exit 0
    fi

    BASE_PROMPT="Load the installed harness setup skill and run it for this \
repository: inspect it, derive project_specs.xml and feature_list.json, \
preserve application files, and commit on main. Take no goal, feature, or \
scope argument. You are running non-interactively: if you would normally \
ask the user a question, print the question and options as your final \
output and stop instead — do not guess, do not proceed on an assumed \
default. Scope your work to ONLY this directory ($REPO). If you notice a \
monorepo registry (e.g. .harness/projects.json) referencing sibling \
subprojects, do NOT inspect, bootstrap, or dispatch any work for them — \
each sibling is bootstrapped by a separate, later invocation of this same \
job. This restriction is about siblings only: any sub-agent dispatch the \
setup skill itself defines for scaffolding THIS subproject (e.g. an \
initializer sub-agent) is expected and fine, as long as it stays scoped to \
$REPO — invoke it the normal way your tool provides, do not read another \
agent's instruction file directly as a substitute."

    if [ -f "$AWAITFILE" ] && [ -f "$ANSWERFILE" ]; then
      PROMPT="$BASE_PROMPT

A prior attempt could not proceed non-interactively and asked:

$(log_tail)

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
      codex)    nohup "$TIMEOUT" "$BOOTSTRAP_TIMEOUT_SECONDS" codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" >"$LOGFILE" 2>&1 & ;;
      claude)   nohup "$TIMEOUT" "$BOOTSTRAP_TIMEOUT_SECONDS" claude -p "$PROMPT" >"$LOGFILE" 2>&1 & ;;
      opencode) nohup "$TIMEOUT" "$BOOTSTRAP_TIMEOUT_SECONDS" opencode run "$PROMPT" >"$LOGFILE" 2>&1 & ;;
      agent)    nohup "$TIMEOUT" "$BOOTSTRAP_TIMEOUT_SECONDS" agent -p --force --trust "$PROMPT" >"$LOGFILE" 2>&1 & ;;
    esac
    echo $! > "$PIDFILE"
    echo "RUNNING $host"
    ;;
  *)
    echo "usage: bootstrap-setup.sh check|answer <repo>" >&2
    exit 1
    ;;
esac
