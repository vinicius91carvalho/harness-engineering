#!/bin/sh
set -eu
cmd=$1; shift
state="$HARNESS_TEST_HERDR_STATE"
case "$cmd" in
  agent)
    case "$1" in
      start)
        name=$2; shift 2
        tab=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --cwd) shift 2 ;;
            --tab) tab=$2; shift 2 ;;
            --split|--no-focus) shift ;;
            --) shift; break ;;
            *) shift ;;
          esac
        done
        printf '%s %s %s\n' "$name" "$tab" "$*" >>"$HARNESS_TEST_HERDR_LOG"
        node "$HARNESS_TEST_HERDR_HELPER" bump-tab "$state" "$tab"
        printf '%s\n' "{\"result\":{\"agent\":{\"pane_id\":\"1-3\",\"tab_id\":\"$tab\",\"name\":\"$name\"}}}"
        ;;
    esac
    ;;
  tab)
    case "$1" in
      list)
        node "$HARNESS_TEST_HERDR_HELPER" tab-list "$state" "$3"
        ;;
      create)
        label=""
        workspace=""
        shift
        while [ $# -gt 0 ]; do
          case "$1" in
            --workspace) workspace=$2; shift 2 ;;
            --label) label=$2; shift 2 ;;
            --no-focus) shift ;;
            *) shift ;;
          esac
        done
        node "$HARNESS_TEST_HERDR_HELPER" tab-create "$state" "$workspace" "$label"
        ;;
    esac
    ;;
  pane)
    case "$1" in
      list)
        printf '%s\n' '{"result":{"panes":[{"pane_id":"1-2","focused":true,"workspace_id":"1"}]}}'
        ;;
      split)
        printf '%s\n' '{"result":{"pane":{"pane_id":"1-4"}}}'
        ;;
      run)
        printf '%s %s\n' "$2" "$3" >>"$HARNESS_TEST_HERDR_LOG"
        printf '%s\n' "{\"result\":{\"type\":\"ok\"}}"
        ;;
      get)
        if [ "$2" = "1-9" ]; then
          printf '%s\n' '{"error":{"code":"pane_not_found"}}'
          exit 1
        fi
        printf '%s\n' "{\"result\":{\"pane\":{\"pane_id\":\"$2\",\"agent_status\":\"working\"}}}"
        ;;
      read)
        printf 'worker output line\n'
        ;;
      close)
        printf '%s\n' "$2" >>"$HARNESS_TEST_HERDR_LOG"
        ;;
    esac
    ;;
  wait)
  ;;
esac
