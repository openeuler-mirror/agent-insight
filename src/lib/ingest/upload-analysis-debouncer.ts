const timersByKey = new Map<string, NodeJS.Timeout>()

export function debounceByKey(key: string, delayMs: number, fn: () => void) {
  const prev = timersByKey.get(key)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    timersByKey.delete(key)
    fn()
  }, delayMs)
  timersByKey.set(key, t)
}

