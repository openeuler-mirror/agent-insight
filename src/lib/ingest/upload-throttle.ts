type PerKeyState = {
  lastRunAt: number
  timer?: NodeJS.Timeout
  pending?: (() => void) | null
}

export function createPerKeyThrottle(intervalMs: number) {
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0
  const stateByKey = new Map<string, PerKeyState>()

  function run(key: string, fn: () => void) {
    const now = Date.now()
    const s = stateByKey.get(key) || { lastRunAt: 0 }
    stateByKey.set(key, s)

    const elapsed = now - s.lastRunAt
    if (elapsed >= ms && !s.timer) {
      s.lastRunAt = now
      fn()
      return
    }

    s.pending = fn
    if (!s.timer) {
      const wait = Math.max(ms - elapsed, 0)
      s.timer = setTimeout(() => {
        s.timer = undefined
        const f = s.pending
        s.pending = null
        s.lastRunAt = Date.now()
        if (f) f()
      }, wait)
    }
  }

  return { run }
}

