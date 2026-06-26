#!/usr/bin/env node
// Convert JSONC to JSON without corrupting comment-like text inside strings.
const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8')
let output = ''
let string = false
let escaped = false
for (let i = 0; i < input.length; i++) {
  const char = input[i]
  const next = input[i + 1]
  if (string) {
    output += char
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (char === '"') string = false
    continue
  }
  if (char === '"') { string = true; output += char; continue }
  if (char === '/' && next === '/') {
    i += 2
    while (i < input.length && input[i] !== '\n') i++
    output += '\n'
    continue
  }
  if (char === '/' && next === '*') {
    i += 2
    while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
    i++
    continue
  }
  output += char
}
output = output.replace(/,\s*([}\]])/g, '$1')
JSON.parse(output)
process.stdout.write(`${JSON.stringify(JSON.parse(output), null, 2)}\n`)
