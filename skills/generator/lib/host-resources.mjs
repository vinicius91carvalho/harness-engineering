import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'

export function parseMeminfo(text = '') {
  const values = {}
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB$/)
    if (!match) continue
    values[match[1]] = Math.floor(Number(match[2]) / 1024)
  }
  return values
}

export function readHostResources({
  meminfoText = null,
  platform = process.platform,
  now = Date.now(),
} = {}) {
  const cores = availableParallelism()
  const totalMb = Math.floor(totalmem() / 1024 / 1024)
  const fallbackFreeMb = Math.floor(freemem() / 1024 / 1024)
  let meminfo = {}
  if (meminfoText != null) {
    meminfo = parseMeminfo(meminfoText)
  } else if (platform === 'linux') {
    try { meminfo = parseMeminfo(readFileSync('/proc/meminfo', 'utf8')) } catch {}
  }
  const availableMb = Number(meminfo.MemAvailable || fallbackFreeMb)
  const swapTotalMb = Number(meminfo.SwapTotal || 0)
  const swapFreeMb = Number(meminfo.SwapFree || 0)
  const swapUsedMb = Math.max(0, swapTotalMb - swapFreeMb)
  const swapUsedRatio = swapTotalMb > 0 ? swapUsedMb / swapTotalMb : 0
  const loadRatio = loadavg()[0] / Math.max(1, cores)
  return {
    at: new Date(now).toISOString(),
    cpu: { cores, loadRatio: Number(loadRatio.toFixed(2)) },
    memory: { availableMb, freeMb: fallbackFreeMb, totalMb },
    swap: {
      totalMb: swapTotalMb,
      freeMb: swapFreeMb,
      usedMb: swapUsedMb,
      usedRatio: Number(swapUsedRatio.toFixed(3)),
    },
  }
}
