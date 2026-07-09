#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  resolveDisplayMode,
  shellQuote,
  spawnInPane,
  closePane,
  getPaneAgentStatus,
  isPaneDone,
  readPaneTail,
} from '../skills/supervisor/lib/herdr-spawn.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'herdr-spawn-test-'))
const bin = join(tmp, 'bin')
const log = join(tmp, 'herdr.log')
mkdirSync(bin, { recursive: true })

writeFileSync(join(bin, 'herdr'), `#!/bin/sh
set -eu
cmd=$1; shift
case "$cmd" in
  pane)
    case "$1" in
      list)
        printf '%s\\n' '{"result":{"panes":[{"pane_id":"1-2","focused":true}]}}'
        ;;
      split)
        printf '%s\\n' '{"result":{"pane":{"pane_id":"1-3"}}}'
        ;;
      run)
        printf '%s %s\\n' "$2" "$3" >>"$HARNESS_TEST_HERDR_LOG"
        ;;
      get)
        printf '%s\\n' '{"result":{"pane":{"agent_status":"working"}}}'
        ;;
      read)
        printf 'worker output line\\n'
        ;;
      close)
        printf '%s\\n' "$2" >>"$HARNESS_TEST_HERDR_LOG"
        ;;
    esac
    ;;
  wait)
  ;;
esac
`)
chmodSync(join(bin, 'herdr'), 0o755)

const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HARNESS_TEST_HERDR_LOG: log, HERDR_ENV: '1' }
process.env.PATH = env.PATH
process.env.HERDR_ENV = '1'
process.env.HARNESS_TEST_HERDR_LOG = log

function assert(condition, message) {
  if (!condition) {
    console.error(`not ok - ${message}`)
    process.exit(1)
  }
}

assert(resolveDisplayMode({}) === 'background', 'default display is background even inside herdr')
assert(resolveDisplayMode({ display: 'background' }) === 'background', '--display background forces background mode')
assert(resolveDisplayMode({ display: 'herdr' }) === 'herdr', '--display herdr opts into pane spawning when herdr is on PATH')
delete process.env.PATH
process.env.PATH = '/usr/bin:/bin'
assert(resolveDisplayMode({ display: 'herdr' }) === 'background', '--display herdr without herdr on PATH falls back to background')
process.env.PATH = env.PATH
assert(shellQuote("it's fine") === "'it'\\''s fine'", 'shellQuote escapes single quotes')

const { paneId } = spawnInPane('node -e "console.log(1)"', 'worker-test')
assert(paneId === '1-3', 'spawnInPane returns new pane id')
assert(getPaneAgentStatus(paneId) === 'working', 'getPaneAgentStatus reads pane state')
assert(isPaneDone(paneId) === false, 'working pane is not done')
assert(readPaneTail(paneId).includes('worker output'), 'readPaneTail returns pane text')
closePane(paneId)

const recorded = spawnSync('cat', [log], { encoding: 'utf8', env }).stdout
assert(recorded.includes('1-3 node -e "console.log(1)"'), 'spawnInPane runs command in new pane')
assert(recorded.includes('1-3'), 'closePane records pane close')

console.log('ok - herdr spawn helpers resolve display mode and drive pane split/run/close')
