'use client'

import type { ProgressCounts } from '@/components/fault-injection/types'
import {
  containmentLabel,
  outcomeLabel,
  type FiLocale,
} from '@/components/fault-injection/types'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

type Locale = 'zh' | 'en'

const TASK_STATUS_I18N: Record<string, { zh: string; en: string }> = {
  running: { zh: '运行中', en: 'Running' },
  completed: { zh: '运行完成', en: 'Completed' },
  failed: { zh: '运行失败', en: 'Failed' },
  stopped: { zh: '已停止', en: 'Stopped' },
}

const RUN_STATUS_I18N: Record<string, { zh: string; en: string }> = {
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  collecting: { zh: '采集中', en: 'Collecting' },
  judging: { zh: '评判中', en: 'Judging' },
  judge_skipped: { zh: '评判跳过', en: 'Judge skipped' },
  stopping: { zh: '停止中', en: 'Stopping' },
  completed: { zh: '运行完成', en: 'Completed' },
  succeeded: { zh: '运行完成', en: 'Completed' },
  failed: { zh: '运行失败', en: 'Failed' },
  stopped: { zh: '已停止', en: 'Stopped' },
}

export function taskStatusLabel(status: string, locale: Locale = 'zh'): string {
  return TASK_STATUS_I18N[status]?.[locale] ?? status
}

export function runStatusLabel(status: string, locale: Locale = 'zh'): string {
  return RUN_STATUS_I18N[status]?.[locale] ?? status
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
  if (status === 'judge_skipped') {
    return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
  }
  if (status === 'queued') {
    return 'bg-background-secondary text-foreground-muted'
  }
  return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
}

function outcomeTone(value: string): string {
  if (value === 'occurred') return 'bg-[var(--success-subtle)] text-[var(--success)]'
  if (value === 'not_occurred') return 'bg-[var(--error-subtle)] text-[var(--error)]'
  if (value === 'skipped') return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
  return 'bg-background-secondary text-foreground-muted'
}

function containmentTone(value: string): string {
  if (value === 'recovered' || value === 'prevented') {
    return 'bg-[var(--success-subtle)] text-[var(--success)]'
  }
  if (value === 'unresolved') return 'bg-[var(--error-subtle)] text-[var(--error)]'
  if (value === 'inconclusive' || value === 'no_trace') {
    return 'bg-[var(--warning-subtle)] text-[var(--warning)]'
  }
  return 'bg-background-secondary text-foreground-muted'
}

export function TaskStatusBadge({ status }: { status: string }) {
  const { locale } = useLocale()
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', toneClass(status))}>
      {taskStatusLabel(status, locale)}
    </span>
  )
}

export function RunStatusBadge({ status }: { status: string }) {
  const { locale } = useLocale()
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', toneClass(status))}>
      {runStatusLabel(status, locale)}
    </span>
  )
}

export function OutcomeBadge({
  value,
  locale,
}: {
  value?: string | null
  locale?: FiLocale
}) {
  const { locale: ctxLocale } = useLocale()
  const loc = locale || ctxLocale
  if (!value) {
    return <span className="text-foreground-muted">—</span>
  }
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', outcomeTone(value))}>
      {outcomeLabel(value, loc)}
    </span>
  )
}

export function ContainmentBadge({
  value,
  locale,
}: {
  value?: string | null
  locale?: FiLocale
}) {
  const { locale: ctxLocale } = useLocale()
  const loc = locale || ctxLocale
  if (!value) {
    return <span className="text-foreground-muted">—</span>
  }
  return (
    <span
      className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium', containmentTone(value))}
    >
      {containmentLabel(value, loc)}
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
    (progress.stopped || 0)
  const total = progress.total || 0
  const parts = [
    { key: 'ok', n: progress.completed || 0, className: 'bg-[var(--success)]' },
    { key: 'skip', n: progress.judge_skipped || 0, className: 'bg-[var(--warning)]' },
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
