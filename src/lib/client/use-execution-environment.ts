'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/client/api'
import type { EnvironmentTask } from '../../../packages/benchmark-protocol/environment.cjs'

export type EnvironmentSelection = {
  datasetId: string | null
  clientId: string
  platform: string
  agent: string
  model: string
  agentOptions?: Record<string, unknown>
  caseIds: string[]
  mode: 'generate' | 'skill-ab' | 'trigger'
  timeoutSeconds: number
  concurrency: number
}
const delay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { signal.removeEventListener('abort', cancel); resolve() }
  const timer = window.setTimeout(done, 1000)
  const cancel = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
})
async function readTask(response: Response): Promise<EnvironmentTask> {
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(typeof value.error === 'string' ? value.error : value.error?.message || '运行环境检查失败，请再次点击“下一步”。'), { status: response.status })
  if (!value.taskId || !['checking', 'preparing', 'needs_action', 'failed', 'ready'].includes(value.state)) throw new Error('环境准备响应不完整，请更新客户端后重试。')
  return value
}
export function useExecutionEnvironment(user: string, selection: EnvironmentSelection | null) {
  const key = selection ? JSON.stringify(selection) : ''
  const current = useRef(key)
  const controller = useRef<AbortController | null>(null)
  const running = useRef(false)
  const [status, setStatus] = useState<{ key: string; task: Pick<EnvironmentTask, 'state' | 'message'> } | null>(null)
  const storageKey = `experiment-environment:${user}`

  useEffect(() => {
    current.current = key
    controller.current?.abort()
    running.current = false
    return () => controller.current?.abort()
  }, [key, user])

  const check = useCallback(async () => {
    if (!selection || !user || running.current) return false
    running.current = true
    const abort = new AbortController()
    controller.current = abort
    setStatus({ key, task: { state: 'checking', message: '正在检查运行环境…' } })
    let task: EnvironmentTask | undefined
    try {
      let saved: { key: string; taskId?: string; requestId: string } | undefined
      try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined } catch {}
      if (saved?.key !== key) saved = { key, requestId: crypto.randomUUID() }
      try { sessionStorage.setItem(storageKey, JSON.stringify(saved)) } catch {}
      const query = `?user=${encodeURIComponent(user)}`
      if (saved.taskId) {
        task = await readTask(await apiFetch(`/api/experiments/environment-preparations/${encodeURIComponent(saved.taskId)}${query}`, { signal: abort.signal }))
        if (abort.signal.aborted || current.current !== key) return false
        if (['ready', 'needs_action', 'failed'].includes(task.state)) {
          saved = { key, requestId: crypto.randomUUID() }
          task = undefined
        }
      }
      if (!task) {
        try { sessionStorage.setItem(storageKey, JSON.stringify(saved)) } catch {}
        task = await readTask(await apiFetch(`/api/experiments/environment-preparations${query}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, requestId: saved.requestId }), signal: abort.signal,
        }))
        if (abort.signal.aborted || current.current !== key) return false
        try { sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, taskId: task.taskId })) } catch {}
      }
      while (!abort.signal.aborted && current.current === key) {
        setStatus({ key, task })
        if (task.state === 'ready') {
          try { sessionStorage.removeItem(storageKey) } catch {}
          return true
        }
        if (['needs_action', 'failed'].includes(task.state)) {
          try { sessionStorage.removeItem(storageKey) } catch {}
          return false
        }
        await delay(abort.signal)
        task = await readTask(await apiFetch(`/api/experiments/environment-preparations/${encodeURIComponent(task.taskId)}${query}`, { signal: abort.signal }))
      }
    } catch (error) {
      if (!abort.signal.aborted && current.current === key) {
        const status = (error as { status?: number })?.status
        if (status && status >= 400 && status < 500 && status !== 429) {
          try { sessionStorage.removeItem(storageKey) } catch {}
        }
        setStatus({ key, task: { state: 'failed', message: error instanceof Error ? error.message : '暂时无法确认环境准备状态，请恢复连接后再次点击“下一步”。' } })
      }
    } finally {
      if (controller.current === abort) running.current = false
    }
    return false
  }, [key, selection, storageKey, user])
  const task = status?.key === key ? status.task : null
  return { check, isCurrent: () => current.current === key && !controller.current?.signal.aborted, fail: (message: string) => setStatus({ key, task: { state: 'failed', message } }), busy: Boolean(task && ['checking', 'preparing'].includes(task.state)), message: task?.state === 'ready' ? '' : task?.message || '', failed: Boolean(task && ['needs_action', 'failed'].includes(task.state)) }
}
