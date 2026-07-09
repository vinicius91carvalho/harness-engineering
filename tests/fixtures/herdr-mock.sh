#!/bin/sh
set -eu
cmd=$1; shift
state="$HARNESS_TEST_HERDR_STATE"
case "$cmd" in
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
        node "$HARNESS_TEST_HERDR_HELPER" pane-list "$state"
        ;;
      split)
        source=$2
        node "$HARNESS_TEST_HERDR_HELPER" pane-split "$state" "$source"
        ;;
      run)
        printf '%s %s\n' "$2" "$3" >>"$HARNESS_TEST_HERDR_LOG"
        printf '%s\n' "{\"result\":{\"type\":\"ok\"}}"
        ;;
      get)
        node "$HARNESS_TEST_HERDR_HELPER" pane-get "$state" "$2"
        ;;
      read)
        printf 'worker output line\n'
        ;;
      close)
        printf '%s\n' "$2" >>"$HARNESS_TEST_HERDR_LOG"
        node "$HARNESS_TEST_HERDR_HELPER" pane-close "$state" "$2"
        ;;
      report-agent)
        paneId=$2
        shift 2
        agentState=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --state) agentState=$2; shift 2 ;;
            --source|--agent|--seq|--message) shift 2 ;;
            *) shift ;;
          esac
        done
        printf 'report-agent %s %s\n' "$paneId" "$agentState" >>"$HARNESS_TEST_HERDR_LOG"
        node "$HARNESS_TEST_HERDR_HELPER" pane-report-agent "$state" "$paneId" "$agentState"
        ;;
    esac
    ;;
  wait)
  ;;
esac
