export const VERDICT_BEGIN = '===HARNESS-VERDICT-BEGIN==='
export const VERDICT_END = '===HARNESS-VERDICT-END==='

export const VERDICT_HINT = `Emit that JSON as the very last thing you print, on its own lines, wrapped exactly:\n${VERDICT_BEGIN}\n{...}\n${VERDICT_END}`

export function parseObject(text) {
  const trimmed = text.trim()
  const open = trimmed.lastIndexOf(VERDICT_BEGIN)
  if (open >= 0) {
    const rest = trimmed.slice(open + VERDICT_BEGIN.length)
    const close = rest.indexOf(VERDICT_END)
    const body = (close >= 0 ? rest.slice(0, close) : rest).trim()
    try { const v = JSON.parse(body); if (v && typeof v === 'object') return v } catch {}
  }
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object') return parsed } catch {}
  }
  return null
}

export function isProviderQuotaLimited(detail) {
  return /\b429\b|rate.?limit|usage limit|try again at|quota exceeded|too many requests/i.test(detail || '')
}

export function fallbackReason(result) {
  const detail = result.timedOut ? 'timeout' : result.detail || ''
  if (isProviderQuotaLimited(detail)) return 'rate-limited'
  if (/auth|credential|unauthorized|forbidden|login/i.test(detail)) return 'authentication-failure'
  if (/model.{0,40}(unavailable|not available|not found|unknown)|unavailable.{0,20}model/i.test(detail)) return 'model-unavailable'
  if (/\b402\b|insufficient credits|payment required|quota exceeded|billing/i.test(detail)) return 'no-credits'
  return result.timedOut ? 'launch-timeout' : 'launch-failure'
}
