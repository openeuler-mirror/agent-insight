'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import {
  DangerOutlineButton,
  DeleteIconButton,
  RerunIconButton,
  StopIconButton,
} from '@/components/fault-injection/ActionIcons'
import {
  PlatformChip,
  TaskProgressBar,
  TaskStatusBadge,
} from '@/components/fault-injection/TaskStatus'
import type { ProgressCounts } from '@/components/fault-injection/types'
import { cn } from '@/lib/utils'

type StatusFilter = 'all' | 'running' | 'completed' | 'failed'

type TaskRow = {
  task_id: string
  name: string
  status: string
  platform: string
  items?: unknown[]
  progress?: ProgressCounts
  updated_at?: string
}

export default function FaultInjectionTasksPage() {
  const router = useRouter()
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const qs = statusFilter === 'all' ? '' : `?status=${encodeURIComponent(statusFilter)}`
    const res = await fetch(`/api/fault-injection/tasks${qs}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'load tasks failed')
    setTasks(data.tasks || [])
  }, [statusFilter])

  useEffect(() => {
    setLoading(true)
    void refresh()
      .catch((e) => toast.error(String(e.message || e)))
      .finally(() => setLoading(false))
  }, [refresh])

  const hasRunning = tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [hasRunning, refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tasks
    return tasks.filter(
      (task) =>
        task.name.toLowerCase().includes(q) || task.task_id.toLowerCase().includes(q),
    )
  }, [tasks, query])

  const allSelected =
    filtered.length > 0 && filtered.every((task) => selected.has(task.task_id))
  const someSelected =
    filtered.some((task) => selected.has(task.task_id)) && !allSelected

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  const selectedTasks = tasks.filter((task) => selected.has(task.task_id))
  const canStop = selectedTasks.some((task) => task.status === 'running')
  const canDelete = selectedTasks.some((task) => task.status !== 'running')

  const toggleOne = (taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const stopTasks = async (ids: string[]) => {
    if (!ids.length) return
    if (
      !window.confirm(
        `确认停止 ${ids.length} 个运行中的任务？停止后对应 run 将记为失败。`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/fault-injection/tasks/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ids }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'stop failed')
      await refresh()
      setSelected(new Set())
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteTasks = async (ids: string[]) => {
    if (!ids.length) {
      toast.error('运行中的任务不可删除，请先停止')
      return
    }
    if (
      !window.confirm(
        `确认删除 ${ids.length} 个任务？任务记录与关联产物引用将一并移除。`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/fault-injection/tasks/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ids }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'delete failed')
      await refresh()
      setSelected(new Set())
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FiPageShell title="注入任务">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['all', '全部'],
              ['running', '运行中'],
              ['completed', '运行完成'],
              ['failed', '运行失败'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                'rounded-md border px-2.5 py-1 text-sm font-medium',
                statusFilter === value
                  ? 'border-primary/40 bg-[var(--primary-subtle)] text-primary'
                  : 'border-border bg-card text-foreground-muted',
              )}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => router.push('/agent-ras/fault-injection/tasks/new')}>
          新建任务
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="text-xs text-foreground-muted">
            已选 {selected.size} / 当前筛选 {filtered.length}
          </span>
          <input
            className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            placeholder="搜索名称或 ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canStop || busy}
            onClick={() =>
              void stopTasks(
                selectedTasks.filter((t) => t.status === 'running').map((t) => t.task_id),
              )
            }
          >
            停止
          </Button>
          <DangerOutlineButton
            disabled={!canDelete || busy}
            onClick={() =>
              void deleteTasks(
                selectedTasks.filter((t) => t.status !== 'running').map((t) => t.task_id),
              )
            }
          >
            删除
          </DangerOutlineButton>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-background-secondary text-left text-[11px] text-foreground-muted">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => {
                      if (allSelected) setSelected(new Set())
                      else setSelected(new Set(filtered.map((t) => t.task_id)))
                    }}
                  />
                </th>
                <th className="px-3 py-2.5">状态</th>
                <th className="px-3 py-2.5">任务</th>
                <th className="px-3 py-2.5">平台</th>
                <th className="px-3 py-2.5">故障数</th>
                <th className="px-3 py-2.5">进度</th>
                <th className="px-3 py-2.5">更新</th>
                <th className="w-28 px-3 py-2.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => {
                const progress = task.progress || {
                  total: 0,
                  queued: 0,
                  running: 0,
                  completed: 0,
                  failed: 0,
                }
                const isSelected = selected.has(task.task_id)
                return (
                  <tr
                    key={task.task_id}
                    className={cn(
                      'cursor-pointer border-t border-border hover:bg-background-secondary/60',
                      isSelected && 'bg-[var(--primary-subtle)]/40',
                    )}
                    onClick={() =>
                      router.push(`/agent-ras/fault-injection/tasks/${task.task_id}`)
                    }
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(task.task_id)}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <TaskStatusBadge status={task.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{task.name}</div>
                      <div className="font-mono text-[11px] text-foreground-muted">
                        {task.task_id}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <PlatformChip platform={task.platform} />
                    </td>
                    <td className="px-3 py-2.5">
                      {Array.isArray(task.items) ? task.items.length : '—'}
                    </td>
                    <td className="min-w-[9rem] px-3 py-2.5">
                      <TaskProgressBar progress={progress} showCount />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-foreground-muted">
                      {task.updated_at ? new Date(task.updated_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-0.5">
                        {task.status === 'running' ? (
                          <StopIconButton
                            disabled={busy}
                            onClick={() => void stopTasks([task.task_id])}
                          />
                        ) : (
                          <RerunIconButton
                            disabled={busy}
                            onClick={() =>
                              router.push(
                                `/agent-ras/fault-injection/tasks/new?rerunFrom=${encodeURIComponent(task.task_id)}`,
                              )
                            }
                          />
                        )}
                        <DeleteIconButton
                          disabled={busy || task.status === 'running'}
                          onClick={() => void deleteTasks([task.task_id])}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!filtered.length && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-foreground-muted">
                    {loading ? (
                      '加载中…'
                    ) : (
                      <span>
                        暂无注入任务。
                        <Link
                          href="/agent-ras/fault-injection/tasks/new"
                          className="ml-1 text-primary hover:underline"
                        >
                          新建任务
                        </Link>
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </FiPageShell>
  )
}
