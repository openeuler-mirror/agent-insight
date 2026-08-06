'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import {
  DeleteIconButton,
  RerunIconButton,
  StopIconButton,
} from '@/components/fault-injection/ActionIcons'
import {
  PlatformChip,
  RunStatusBadge,
  TaskProgressBar,
  TaskStatusBadge,
} from '@/components/fault-injection/TaskStatus'
import {
  CONTAINMENT_LABELS,
  OUTCOME_LABELS,
  labelMap,
  type ProgressCounts,
} from '@/components/fault-injection/types'
import {
  loadFaultLabelsMap,
  peekFaultLabelsCache,
} from '@/lib/fault-injection/fault-labels-cache'

type TaskDetail = {
  task_id: string
  name: string
  status: string
  platform: string
  agent: string
  prompt: string
  items?: Array<Record<string, unknown>>
  progress?: ProgressCounts
  runs?: Array<{
    run_id: string
    fault: string
    status: string
    outcome?: string | null
    fault_containment_status?: string | null
    judge_reason?: string | null
    error?: string | null
    submode?: string | null
    phase?: string | null
  }>
  model?: string | null
  workspace?: string
  started_at?: string | null
}

export default function FaultInjectionTaskDetailPage() {
  const params = useParams<{ taskId: string }>()
  const router = useRouter()
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [faultLabels, setFaultLabels] = useState<Record<string, string> | null>(
    () => peekFaultLabelsCache(),
  )

  const refresh = useCallback(async () => {
    if (!params.taskId) return
    const res = await fetch(`/api/fault-injection/task/${params.taskId}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'load failed')
    setTask(data.task)
  }, [params.taskId])

  useEffect(() => {
    setLoading(true)
    void refresh()
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    void loadFaultLabelsMap()
      .then((map) => setFaultLabels(map))
      .catch(() => setFaultLabels({}))
  }, [])

  useEffect(() => {
    if (task?.status !== 'running') return
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [task?.status, refresh])

  const progress = task?.progress || {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }

  const stopTask = async () => {
    if (!task) return
    if (!window.confirm('确认停止该任务？停止后对应 run 将记为失败。')) return
    setBusy(true)
    try {
      const res = await fetch('/api/fault-injection/tasks/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: [task.task_id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'stop failed')
      await refresh()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteTask = async () => {
    if (!task) return
    if (!window.confirm('确认删除该任务？任务记录将一并移除。')) return
    setBusy(true)
    try {
      const res = await fetch('/api/fault-injection/tasks/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: [task.task_id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'delete failed')
      router.push('/agent-ras/fault-injection/tasks')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FiPageShell>
      <div className="text-sm text-foreground-muted">
        <Link href="/agent-ras/fault-injection/tasks" className="text-primary hover:underline">
          注入任务
        </Link>
        <span className="mx-1.5">/</span>
        <span>{task?.name || params.taskId}</span>
      </div>

      {loading && <p className="text-sm text-foreground-muted">加载中…</p>}
      {error && <p className="text-sm text-[var(--error)]">{error}</p>}

      {task && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{task.name}</h2>
                <TaskStatusBadge status={task.status} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-muted">
                <PlatformChip platform={task.platform} />
                <span>agent: {task.agent}</span>
                <span>model: {task.model || '默认'}</span>
                <span className="font-mono">{task.task_id}</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {task.status === 'running' ? (
                <StopIconButton disabled={busy} onClick={() => void stopTask()} />
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
                onClick={() => void deleteTask()}
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between text-[13px] font-semibold">
              <span>执行进度</span>
              <span className="font-mono text-xs font-normal text-foreground-muted">
                {(progress.completed || 0) + (progress.failed || 0)} / {progress.total || 0}
              </span>
            </div>
            <TaskProgressBar progress={progress} />
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-foreground-muted">
              <span>
                完成 <strong className="text-foreground">{progress.completed || 0}</strong>
              </span>
              <span>
                失败 <strong className="text-foreground">{progress.failed || 0}</strong>
              </span>
              <span>
                运行中 <strong className="text-foreground">{progress.running || 0}</strong>
              </span>
              <span>
                排队 <strong className="text-foreground">{progress.queued || 0}</strong>
              </span>
            </div>
          </div>

          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-background-secondary text-left text-[11px] text-foreground-muted">
                <tr>
                  <th className="px-3 py-2.5">故障</th>
                  <th className="px-3 py-2.5">子模式</th>
                  <th className="px-3 py-2.5">阶段</th>
                  <th className="px-3 py-2.5">状态</th>
                  <th className="px-3 py-2.5">Outcome</th>
                  <th className="px-3 py-2.5">Containment</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(task.runs || []).map((run) => (
                  <tr key={run.run_id} className="border-t border-border">
                    <td className="px-3 py-2.5">
                      <div className="font-medium">
                        {faultLabels == null
                          ? '…'
                          : faultLabels[run.fault] || '—'}
                      </div>
                      <div className="font-mono text-[11px] text-foreground-muted">{run.fault}</div>
                    </td>
                    <td className="px-3 py-2.5 text-foreground-muted">{run.submode || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-foreground-muted">
                      {run.phase || run.status}
                    </td>
                    <td className="px-3 py-2.5">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2.5">{labelMap(OUTCOME_LABELS, run.outcome)}</td>
                    <td className="px-3 py-2.5">
                      {labelMap(CONTAINMENT_LABELS, run.fault_containment_status)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        className="rounded border border-border px-2 py-1 text-xs text-primary hover:bg-[var(--primary-subtle)]"
                        href={`/agent-ras/fault-injection/runs/${run.run_id}`}
                      >
                        查看轨迹
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="rounded-md border border-border bg-card p-3 text-sm">
            <summary className="cursor-pointer font-medium">任务配置</summary>
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-foreground-muted">Prompt</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{task.prompt}</dd>
              </div>
              <div>
                <dt className="text-foreground-muted">Workspace</dt>
                <dd className="mt-0.5 break-all font-mono">{task.workspace}</dd>
              </div>
              <div>
                <dt className="text-foreground-muted">Agent / Model</dt>
                <dd className="mt-0.5">
                  {task.agent} / {task.model || '默认'}
                </dd>
              </div>
            </dl>
          </details>
        </>
      )}
    </FiPageShell>
  )
}
