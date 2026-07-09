#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { readyWorkItems } from './ready-work-items.mjs'

const args = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1]
  if (key?.startsWith('--') && value !== undefined) options[key.slice(2)] = value
}

let queue
try {
  const input = process.stdin.isTTY ? readFileSync(options.file, 'utf8') : readFileSync(0, 'utf8')
  queue = JSON.parse(input)
} catch (error) {
  process.stderr.write(`cli-ready: ${error.message}\n`)
  process.exit(2)
}

const mode = options.mode || 'all'
const ready = readyWorkItems(queue, {
  mode,
  context: options.context || null,
  taskId: options.task || options.selector || null,
})
process.stdout.write(`${JSON.stringify(ready)}\n`)
