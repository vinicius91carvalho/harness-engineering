/** Live-format host agent streams for herdr panes while preserving verdict text. */

const TOOL_EVENTS = new Set([
  'tool_execution_start',
  'tool_execution_end',
  'tool_start',
  'tool_end',
  'tool_call',
  'tool_result',
])

export function shouldUseJsonAgentStream(program, visible) {
  return Boolean(visible) && (program === 'pi' || program === 'agent')
}

/**
 * Inject streaming flags so thinking/tool events appear under herdr:
 * - pi: `--mode json`
 * - agent (Cursor): `--output-format stream-json --stream-partial-output`
 */
export function withVisibleAgentMode(program, args, visible) {
  if (!shouldUseJsonAgentStream(program, visible)) return args
  const out = [...args]
  if (program === 'agent') {
    if (!out.includes('--output-format')) {
      const printIdx = out.findIndex((arg) => arg === '-p' || arg === '--print')
      const insert = ['--output-format', 'stream-json', '--stream-partial-output']
      if (printIdx >= 0) out.splice(printIdx + 1, 0, ...insert)
      else out.unshift(...insert)
    } else if (!out.includes('--stream-partial-output')) {
      out.push('--stream-partial-output')
    }
    return out
  }
  // pi
  if (out.includes('--mode') || out.includes('-m')) return out
  const printIdx = out.findIndex((arg) => arg === '-p' || arg === '--print')
  if (printIdx >= 0) out.splice(printIdx, 0, '--mode', 'json')
  else out.unshift('--mode', 'json')
  return out
}

function toolLabel(event) {
  if (event.toolName || event.name || event.tool || event.toolCall?.name) {
    return event.toolName || event.name || event.tool || event.toolCall?.name
  }
  // Cursor agent stream-json: tool_call.shellToolCall / readToolCall / …
  const call = event.tool_call
  if (call && typeof call === 'object') {
    const key = Object.keys(call).find((k) => k.endsWith('ToolCall') || k === 'function')
    if (key) {
      const desc = call[key]?.description || call[key]?.args?.description
      const short = key.replace(/ToolCall$/, '')
      return desc ? `${short}: ${String(desc).slice(0, 80)}` : short
    }
  }
  return 'tool'
}

/**
 * Turn NDJSON agent events into short pane lines and accumulate assistant text
 * (for HARNESS-VERDICT parsing). Non-JSON lines pass through unchanged.
 */
export function createAgentStreamFormatter() {
  let buffer = ''
  let assistantText = ''
  let thinkingBuf = ''
  let textBuf = ''
  let lastTool = ''
  const paneChunks = []

  const emitLine = (line) => {
    if (!line) return
    paneChunks.push(line.endsWith('\n') ? line : `${line}\n`)
  }

  const flushThinking = (force = false) => {
    const trimmed = thinkingBuf.trim()
    if (!trimmed) return
    // Prefer complete thoughts: wait for thinking_end unless the buffer is large.
    if (!force && trimmed.length < 200 && !/[.!?]\s*$/.test(trimmed)) return
    emitLine(`thinking: ${trimmed.replace(/\s+/g, ' ')}`)
    thinkingBuf = ''
  }

  const flushText = (force = false) => {
    if (!textBuf) return
    if (!force && !textBuf.includes('\n') && textBuf.length < 120) return
    paneChunks.push(textBuf)
    if (force && !textBuf.endsWith('\n')) paneChunks.push('\n')
    textBuf = ''
  }

  let announced = false
  const handleEvent = (event) => {
    if (!event || typeof event !== 'object') return
    const type = event.type
    const subtype = event.subtype

    if ((type === 'agent_start' || type === 'turn_start' || (type === 'system' && subtype === 'init')) && !announced) {
      emitLine('agent: working…')
      announced = true
      return
    }

    // Cursor agent: thinking deltas
    if (type === 'thinking') {
      if (subtype === 'delta' && event.text) {
        thinkingBuf += event.text
        flushThinking(false)
      } else if (subtype === 'completed') {
        flushThinking(true)
      }
      return
    }

    // Cursor agent: assistant text deltas (and final full message — skip duplicate full)
    if (type === 'assistant' && event.message?.role === 'assistant') {
      const parts = event.message.content || []
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('')
      if (!text) return
      // Final event often repeats the full answer; prefer accumulating deltas only.
      // Never replace assistantText with a shorter summary that drops the harness verdict.
      if (text.length > 80 && assistantText && text.startsWith(assistantText.slice(0, Math.min(40, assistantText.length)))) {
        if (!(assistantText.includes('===HARNESS-VERDICT-BEGIN===') && !text.includes('===HARNESS-VERDICT-BEGIN==='))) {
          assistantText = text
        }
        return
      }
      assistantText += text
      textBuf += text
      flushText(false)
      return
    }

    if (type === 'result' && event.result) {
      flushThinking(true)
      flushText(true)
      const resultText = String(event.result)
      if (resultText && !assistantText.includes(resultText)) {
        assistantText += resultText.endsWith('\n') ? resultText : `${resultText}\n`
      }
      return
    }

    if (type === 'message_update') {
      const ev = event.assistantMessageEvent || {}
      if (ev.type === 'thinking_delta' && ev.delta) {
        thinkingBuf += ev.delta
        flushThinking(false)
      } else if (ev.type === 'thinking_end') {
        if (ev.content) thinkingBuf = String(ev.content)
        flushThinking(true)
      } else if (ev.type === 'text_delta' && ev.delta) {
        assistantText += ev.delta
        textBuf += ev.delta
        flushText(false)
      } else if (ev.type === 'text_end' && ev.content != null) {
        if (!assistantText) assistantText = String(ev.content)
        if (ev.content && textBuf === '') textBuf = String(ev.content)
        flushText(true)
      }
      return
    }
    if (type === 'message_end' && event.message?.role === 'assistant') {
      const parts = event.message.content || []
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('')
      if (text && !assistantText.includes(text)) {
        assistantText += text
        textBuf += text
        flushText(true)
      }
      return
    }
    if (TOOL_EVENTS.has(type) || type === 'tool_call') {
      const name = toolLabel(event)
      const isStart = subtype === 'started' || type.includes('start') || (type === 'tool_call' && subtype !== 'completed')
      const isEnd = subtype === 'completed' || type.includes('end') || type === 'tool_result'
      if (isStart && !isEnd) {
        if (lastTool !== `start:${name}`) {
          flushThinking(true)
          flushText(true)
          emitLine(`tool → ${name}`)
          lastTool = `start:${name}`
        }
      } else if (isEnd) {
        if (lastTool !== `end:${name}`) {
          emitLine(`tool ✓ ${name}`)
          lastTool = `end:${name}`
        }
      }
      return
    }
  }

  return {
    push(chunk) {
      const text = String(chunk)
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const out = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            handleEvent(JSON.parse(trimmed))
            out.push(...paneChunks.splice(0))
            continue
          } catch {
            // fall through — treat as plain text
          }
        }
        assistantText += `${line}\n`
        out.push(`${line}\n`)
      }
      out.push(...paneChunks.splice(0))
      return out.join('')
    },
    flush() {
      flushThinking(true)
      flushText(true)
      const out = []
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        buffer = ''
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            handleEvent(JSON.parse(trimmed))
          } catch {
            assistantText += `${trimmed}\n`
            out.push(`${trimmed}\n`)
          }
        } else {
          assistantText += `${trimmed}\n`
          out.push(`${trimmed}\n`)
        }
      }
      out.push(...paneChunks.splice(0))
      return out.join('')
    },
    assistantText() {
      return assistantText
    },
  }
}
