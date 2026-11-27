/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

