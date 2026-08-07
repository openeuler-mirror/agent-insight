'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'
import {
  buildMarkerPipeline,
  type PipelineStep,
} from '@/lib/fault-injection/marker-pipeline'
import { useLocale } from '@/lib/client/locale-context'

export { buildMarkerPipeline } from '@/lib/fault-injection/marker-pipeline'

function CheckDot({
  done,
  skipped,
  severity,
}: {
  done: boolean
  skipped?: boolean
  severity: string
}) {
  if (!done) {
    return (
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-border bg-card text-transparent shadow-[0_0_0_3px_var(--card)]"
        aria-hidden
      />
    )
  }
  const tone = skipped
    ? 'border-[var(--foreground-muted)] bg-[var(--foreground-muted)] text-white'
    : severity === 'critical'
      ? 'border-[var(--error)] bg-[var(--error)] text-white'
      : severity === 'warning'
        ? 'border-[var(--warning)] bg-[var(--warning)] text-white'
        : 'border-[var(--success)] bg-[var(--success)] text-white'

  return (
    <span
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 shadow-[0_0_0_3px_var(--card)]',
        tone,
      )}
      aria-hidden
    >
      {skipped ? (
        <span className="text-[10px] font-bold leading-none">–</span>
      ) : (
        <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2.5 6.2 4.8 8.5 9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )
}

function PipelineView({ steps, zh }: { steps: PipelineStep[]; zh: boolean }) {
  const firstDoneWithDetail = steps.find((step) => step.done && (step.detail || step.summary))
  const [selectedKey, setSelectedKey] = useState(firstDoneWithDetail?.key ?? steps[0]?.key ?? '')
  const selected = steps.find((step) => step.key === selectedKey) ?? firstDoneWithDetail ?? steps[0]

  return (
    <div className="space-y-3 rounded-md border border-border bg-card px-4 py-3">
      <ol className="flex min-w-max items-start justify-center overflow-x-auto">
        {steps.map((step, index) => {
          const active = selected?.key === step.key
          const labelClass = !step.done
            ? 'text-foreground-muted'
            : step.skipped
              ? 'text-foreground-muted'
              : step.severity === 'critical'
                ? 'text-[var(--error)]'
                : step.severity === 'warning'
                  ? 'text-[var(--warning)]'
                  : 'text-foreground'
          const lineClass = step.done
            ? step.severity === 'critical'
              ? 'bg-[var(--error)]/35'
              : step.severity === 'warning'
                ? 'bg-[var(--warning)]/35'
                : 'bg-[var(--success)]/40'
            : 'bg-border'
          return (
            <li key={step.key} className="flex items-start">
              <button
                type="button"
                onClick={() => setSelectedKey(step.key)}
                className={cn(
                  'flex w-[7.5rem] flex-col items-center rounded-md px-1 py-1 text-center transition-colors',
                  active ? 'bg-[var(--primary-subtle)]/60' : 'hover:bg-background-secondary',
                )}
                title={step.summary || step.label}
              >
                <span
                  className={cn(
                    'mb-2 line-clamp-2 min-h-[2rem] text-[11px] font-medium leading-tight',
                    labelClass,
                  )}
                >
                  {step.label}
                </span>
                <CheckDot done={step.done} skipped={step.skipped} severity={step.severity} />
              </button>
              {index < steps.length - 1 ? (
                <div className="flex flex-col items-stretch" aria-hidden>
                  <div className="mb-2 min-h-[2rem]" />
                  <div className="flex h-5 items-center">
                    <span className={cn('h-0.5 w-10', lineClass)} />
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>

      {selected ? (
        <div className="rounded-md border border-border bg-background-secondary p-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-foreground-muted">
            <span className="font-semibold tracking-wide text-foreground">{selected.label}</span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                selected.done
                  ? selected.skipped
                    ? 'bg-background-secondary text-foreground-muted'
                    : 'bg-[var(--success-subtle)] text-[var(--success)]'
                  : 'bg-background-secondary text-foreground-muted',
              )}
            >
              {selected.done
                ? selected.skipped
                  ? zh
                    ? '已跳过'
                    : 'Skipped'
                  : zh
                    ? '已执行'
                    : 'Done'
                : zh
                  ? '未执行'
                  : 'Pending'}
            </span>
            {selected.meta ? (
              <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground-secondary">
                skill: {selected.meta}
              </span>
            ) : null}
          </div>
          {selected.summary ? (
            <p className="mb-2 text-xs text-foreground-secondary">{selected.summary}</p>
          ) : null}
          {selected.detail ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground-secondary">
              {selected.detail}
            </pre>
          ) : !selected.done ? (
            <p className="text-xs text-foreground-muted">
              {zh
                ? '该节点尚未发生，因此没有可展示的内容。'
                : 'This step has not occurred yet, so there is nothing to show.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function MarkerPipeline({ markers }: { markers: FiPipelineMarker[] }) {
  const { locale } = useLocale()
  const steps = useMemo(() => buildMarkerPipeline(markers, locale), [markers, locale])
  return <PipelineView steps={steps} zh={locale === 'zh'} />
}
