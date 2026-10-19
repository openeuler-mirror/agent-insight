'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/client/api'

type DirectoryState = { key: string; value: string; saved: string; loading: boolean; saving: boolean; error: string }
const emptyState: DirectoryState = { key: '', value: '', saved: '', loading: true, saving: false, error: '' }

export function useZsoftTasksDirectory(user: string, datasetId: string, clientId: string, enabled: boolean) {
  const key = enabled ? JSON.stringify([user, datasetId, clientId]) : ''
  const [state, setState] = useState<DirectoryState>(emptyState)
  const activeRequest = useRef<{ active: boolean } | null>(null)
  const current = state.key === key ? state : emptyState

  useEffect(() => {
    const request = { active: true }
    activeRequest.current = request
    if (!enabled || !user || !datasetId || !clientId) return
    const controller = new AbortController()
    apiFetch(`/api/benchmark/v1/execution-targets?user=${encodeURIComponent(user)}&datasetId=${encodeURIComponent(datasetId)}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error?.message || '无法读取 ZSoft 任务目录')
        const target = body.items?.find((item: { clientId: string }) => item.clientId === clientId)
        if (!target) throw new Error('所选客户端当前不支持该 Benchmark，请刷新客户端列表')
        const value = target.benchmarkConfig?.tasksDir || ''
        if (request.active) setState({ key, value, saved: value, loading: false, saving: false, error: '' })
      })
      .catch(error => {
        if (request.active && !controller.signal.aborted) {
          setState({ ...emptyState, key, loading: false, error: error.message })
        }
      })
    return () => { controller.abort(); request.active = false }
  }, [key, enabled, user, datasetId, clientId])

  const validPath = current.value.trim().startsWith('/') && current.value.trim().length <= 4096 && !/[\0\r\n]/.test(current.value)
  const ready = !enabled || (state.key === key && !current.loading && !current.saving && !current.error
    && Boolean(current.saved) && current.value.trim() === current.saved)
  const save = async () => {
    if (!validPath || current.loading || current.saving) return
    const request = activeRequest.current
    setState(previous => ({ ...previous, saving: true, error: '' }))
    try {
      const response = await apiFetch('/api/benchmark/v1/execution-targets', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, datasetId, clientId, tasksDir: current.value.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message || '保存失败')
      if (request?.active) {
        const value = body.benchmarkConfig.tasksDir
        setState({ key, value, saved: value, loading: false, saving: false, error: '' })
      }
    } catch (error) {
      if (request?.active) setState(previous => ({ ...previous, saving: false, error: error instanceof Error ? error.message : '保存失败' }))
    }
  }
  return { ...current, ready, validPath, save,
    change: (value: string) => setState(previous => ({ ...previous, value, error: '' })) }
}

export function ZsoftTasksDirectoryField({ directory, host }: {
  directory: ReturnType<typeof useZsoftTasksDirectory>
  host: string
}) {
  return <section className="mb-4 grid gap-2" aria-label="ZSoft Benchmark 配置">
    <label htmlFor="zsoft-tasks-dir" className="text-sm font-semibold">ZSoft 任务目录 *</label>
    <div className="flex gap-2">
      <Input id="zsoft-tasks-dir" value={directory.value} disabled={directory.loading || directory.saving}
        placeholder="执行机上的绝对路径，例如 /srv/zsoft/tasks"
        onChange={event => directory.change(event.target.value)}
        aria-describedby="zsoft-tasks-dir-help" aria-invalid={Boolean(directory.value) && !directory.validPath} />
      <Button type="button" variant="outline" disabled={directory.loading || directory.saving || !directory.validPath}
        onClick={directory.save}>{directory.saving ? '保存中…' : '保存目录'}</Button>
    </div>
    <p id="zsoft-tasks-dir-help" className="text-xs text-foreground-muted">
      填写执行客户端{host ? `（${host}）` : ''}上的原生 ZSoft tasks-dir，目录内应有 &lt;task-id&gt;/task.json 和 public/。
      这是 Benchmark 配置，保存后该客户端的 ZSoft 实验会复用，可随时修改。无需额外导入资料包。
    </p>
    {directory.loading ? <p className="text-xs text-foreground-muted">正在读取已保存目录…</p>
      : directory.error ? <p className="text-sm text-error" role="alert">{directory.error}</p>
        : <p className="text-xs text-foreground-muted">{directory.ready ? '目录已保存' : '请填写并保存目录后继续'}</p>}
  </section>
}
