'use client'

import type { ProgressCounts } from '@/components/fault-injection/types'
import { cn } from '@/lib/utils'

const TASK_STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  completed: '运行完成',
  failed: '运行失败',
  dry_run: '模拟运行',
  stopped: '已停止',
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  collecting: '采集中',
  judging: '评判中',
  judge_skipped: '评判跳过',
  dry_run: '模拟运行',
  stopping: '停止中',
  completed: '运行完成',
  succeeded: '运行完成',
  failed: '运行失败',
  stopped: '已停止',
}

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status
}

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status
}

function toneClass(status: string): string {
  if (status === 'completed' || status === 'succeeded') {
    return 'bg-[var(--success-subtle)] text-[var(--success)]'
  }
  if (status === 'failed') {
    return 'bg-[var(--error-subtle)] text-[var(--error)]'
  }
  if (status === 'stopped') {
    return 'bg-background-secondary text-foreground-muted'
  }
  if (status === 'judge_skipped' || status === 'dry_run') {
    return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
  }
  if (status === 'queued') {
    return 'bg-background-secondary text-foreground-muted'
  }
  return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
}

export function TaskStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', toneClass(status))}>
      {taskStatusLabel(status)}
    </span>
  )
}

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', toneClass(status))}>
      {runStatusLabel(status)}
    </span>
  )
}

export function TaskProgressBar({
  progress,
  showCount = false,
}: {
  progress: ProgressCounts
  showCount?: boolean
}) {
  const done =
    (progress.completed || 0) +
    (progress.failed || 0) +
    (progress.judge_skipped || 0) +
    (progress.dry_run || 0) +
    (progress.stopped || 0)
  const total = progress.total || 0
  const parts = [
    { key: 'ok', n: progress.completed || 0, className: 'bg-[var(--success)]' },
    { key: 'skip', n: (progress.judge_skipped || 0) + (progress.dry_run || 0), className: 'bg-[var(--warning)]' },
    { key: 'bad', n: progress.failed || 0, className: 'bg-[var(--error)]' },
    { key: 'stop', n: progress.stopped || 0, className: 'bg-[var(--foreground-muted)]/55' },
    { key: 'run', n: progress.running || 0, className: 'bg-[var(--primary)]' },
    { key: 'queue', n: progress.queued || 0, className: 'bg-[var(--foreground-muted)]/35' },
  ].filter((part) => part.n > 0)

  return (
    <div className="flex min-w-[8rem] items-center gap-2">
      <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-background-secondary">
        {parts.length === 0 ? (
          <div className="h-full flex-1 bg-[var(--foreground-muted)]/25" />
        ) : null}
        {parts.map((part) => (
          <div key={part.key} className={`h-full ${part.className}`} style={{ flex: part.n }} />
        ))}
      </div>
      {showCount ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground-muted">
          {done}/{total}
        </span>
      ) : null}
    </div>
  )
}

export function PlatformChip({ platform }: { platform: string }) {
  return (
    <span className="inline-flex rounded bg-background-secondary px-2 py-0.5 text-[11px] font-medium text-foreground-secondary">
      {platform}
    </span>
  )
}
