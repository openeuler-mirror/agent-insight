'use client'

import type { ProgressCounts } from '@/components/fault-injection/types'

export function WizardSummary({
  platform,
  agent,
  model,
  faultLabels,
  workspace,
  checklist,
}: {
  platform?: string
  agent?: string
  model?: string
  faultLabels: string[]
  workspace?: string
  checklist: Array<{ ok: boolean; label: string }>
}) {
  return (
    <aside className="space-y-4 rounded-md border border-border bg-card p-4 lg:sticky lg:top-4">
      <h3 className="text-[13px] font-semibold">任务摘要</h3>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-foreground-muted">平台</dt>
          <dd className="font-medium">{platform || '—'}</dd>
        </div>
        <div>
          <dt className="text-foreground-muted">Agent</dt>
          <dd className="font-medium">{agent || '—'}</dd>
        </div>
        <div>
          <dt className="text-foreground-muted">Model</dt>
          <dd className="font-medium">{model || '平台默认'}</dd>
        </div>
        <div>
          <dt className="text-foreground-muted">故障</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {faultLabels.length
              ? faultLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded bg-[var(--primary-subtle)] px-1.5 py-0.5 text-[11px] text-primary"
                  >
                    {label}
                  </span>
                ))
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-foreground-muted">Workspace</dt>
          <dd className="break-all font-mono text-[11px]">{workspace || '—'}</dd>
        </div>
      </dl>
      <div>
        <p className="mb-2 text-[13px] font-semibold">启动前检查</p>
        <ul className="space-y-1.5 text-xs">
          {checklist.map((item) => (
            <li key={item.label} className="flex items-center gap-2">
              <span className={item.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}>
                {item.ok ? '✓' : '✗'}
              </span>
              <span className={item.ok ? 'text-foreground' : 'text-foreground-muted'}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

export function emptyProgress(total = 0): ProgressCounts {
  return {
    total,
    queued: total,
    running: 0,
    completed: 0,
    failed: 0,
    judge_skipped: 0,
    dry_run: 0,
  }
}
