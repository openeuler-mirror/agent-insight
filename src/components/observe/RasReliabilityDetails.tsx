'use client'

import { Check, X as XIcon, AlertTriangle as AlertIcon } from 'lucide-react'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'
import { interleaveRasActions } from '@/lib/ingest/ras/delivery-link'
import type { RasTraceMarker } from '@/lib/ingest/ras/trace-markers'
import { findRasMarkersForEvent } from '@/lib/ingest/ras/trace-markers'
import type { AgentEvent } from '@/lib/engine/observability/agent-trace'
import {
  rasActionChannelLabel,
  rasActionLabel,
  rasMarkerBadgeLabel,
  rasSeverityLabel,
  rasSummaryLabel,
} from '@/lib/ingest/ras/normalize'

function rasSeverityClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') {
    return 'border-error-border bg-error-subtle text-error'
  }
  if (severity === 'medium') {
    return 'border-warning-border bg-warning-subtle text-warning'
  }
  return 'border-border bg-background-secondary text-foreground-secondary'
}

function isFiMarker(marker: RasTraceMarker): boolean {
  return marker.source === 'fi'
}

export function rasOnlyMarkers(markers: RasTraceMarker[]): RasTraceMarker[] {
  return markers.filter((marker) => !isFiMarker(marker))
}

export function fiOnlyMarkers(markers: RasTraceMarker[]): RasTraceMarker[] {
  return markers.filter(isFiMarker)
}

export function RasNodeBadge({
  markers,
  compact = false,
  className,
}: {
  markers: RasTraceMarker[]
  compact?: boolean
  className?: string
}) {
  const { locale } = useLocale()
  if (!markers.length) return null
  const fi = fiOnlyMarkers(markers)
  const ras = rasOnlyMarkers(markers)
  if (fi.length && ras.length) {
    return (
      <span className={cn('inline-flex max-w-full flex-wrap items-center gap-1', className)}>
        <RasNodeBadge markers={fi} compact={compact} />
        <RasNodeBadge markers={ras} compact={compact} />
      </span>
    )
  }
  const first = markers[0]
  const isFi = fi.length > 0
  const title = markers
    .map((marker) => {
      const summary = rasSummaryLabel(marker, locale)
      return `${marker.label} (${rasSeverityLabel(marker.severity, locale)})${summary ? `: ${summary}` : ''}`
    })
    .join('\n')
  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex max-w-44 items-center gap-1 rounded-sm border px-1.5 py-0.5 align-middle text-[10px] font-semibold leading-none',
        rasSeverityClass(first.severity),
        className,
      )}
    >
      <AlertIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {rasMarkerBadgeLabel({ label: first.label, source: isFi ? 'fi' : 'ras' }, locale, compact)}
      </span>
      {markers.length > 1 && <span className="shrink-0 tabular-nums">+{markers.length - 1}</span>}
    </span>
  )
}

function MarkerSourceSection({
  markers,
  heading,
}: {
  markers: RasTraceMarker[]
  heading: string
}) {
  const { locale, t: tt } = useLocale()
  if (!markers.length) return null
  return (
    <section
      className="rounded-md border border-error-border bg-error-subtle p-3"
      aria-label={heading}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-error">
        <AlertIcon className="size-4" aria-hidden />
        {heading}
        <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-foreground-secondary">
          {markers.length}
        </span>
      </div>
      <div className="space-y-2.5">
        {markers.map((marker) => {
          const steps = interleaveRasActions(marker.actions, marker.actionResults)
          const summary = rasSummaryLabel(marker, locale)
          return (
            <article key={marker.id} className="rounded-md border border-error-border bg-card p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <RasNodeBadge markers={[marker]} />
                <span className="text-[11px] text-foreground-muted">
                  {new Date(marker.ts).toLocaleString()}
                </span>
              </div>
              {summary && (
                <p className="mt-2 text-xs leading-relaxed text-foreground-secondary">
                  {summary}
                </p>
              )}
              {steps.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                    {tt('traceTree.rasRequestedActions')}
                  </div>
                  {steps.map((step, index) => (
                    step.kind === 'action' ? (
                      <div
                        key={`action-${step.action.type}-${index}`}
                        className="rounded-md border border-border bg-background-secondary p-2"
                      >
                        <span title={step.action.type} className="text-[11px] font-semibold text-foreground">
                          {rasActionLabel(step.action.type, locale)}
                        </span>
                        {step.action.message && (
                          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground-secondary">
                            {step.action.message}
                          </pre>
                        )}
                      </div>
                    ) : (
                      <div
                        key={`result-${step.result.action}-${step.result.ts}-${index}`}
                        className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-secondary pl-1"
                      >
                        {step.result.ok
                          ? <Check className="size-3.5 text-success" aria-hidden />
                          : <XIcon className="size-3.5 text-error" aria-hidden />}
                        <span title={step.result.action}>{rasActionLabel(step.result.action, locale)}</span>
                        <span>
                          {step.result.ok
                            ? tt('traceTree.rasActionSucceeded')
                            : tt('traceTree.rasActionFailed')}
                        </span>
                        {step.result.channel && (
                          <span title={step.result.channel} className="text-foreground-muted">· {rasActionChannelLabel(step.result.channel, locale)}</span>
                        )}
                        {step.result.error && (
                          <span className="basis-full pl-5 text-error">{step.result.error}</span>
                        )}
                      </div>
                    )
                  ))}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export function RasReliabilityDetails({ markers }: { markers: RasTraceMarker[] }) {
  const { t: tt } = useLocale()
  if (!markers.length) return null
  const fi = fiOnlyMarkers(markers)
  const ras = rasOnlyMarkers(markers)
  if (fi.length && ras.length) {
    return (
      <div className="space-y-3">
        <MarkerSourceSection markers={fi} heading="FI Events" />
        <MarkerSourceSection markers={ras} heading={tt('traceTree.rasEvents')} />
      </div>
    )
  }
  if (fi.length) {
    return <MarkerSourceSection markers={fi} heading="FI Events" />
  }
  return <MarkerSourceSection markers={ras} heading={tt('traceTree.rasEvents')} />
}

/** Resolve FI+RAS markers for a tree event (dev_agent_ras parity). */
export function findEventAnomaliesForMarkers(
  event: AgentEvent,
  markers: RasTraceMarker[],
): RasTraceMarker[] {
  if (!markers.length) return []
  const fiHits = findRasMarkersForEvent(event, fiOnlyMarkers(markers))
  if (event.kind !== 'ras') return fiHits
  const rasMarkers = rasOnlyMarkers(markers)
  const markerId = (event.args as { rasMarkerId?: string } | undefined)?.rasMarkerId
  const rasHits = markerId
    ? rasMarkers.filter((marker) => marker.id === markerId)
    : findRasMarkersForEvent(event, rasMarkers)
  if (!fiHits.length) return rasHits
  if (!rasHits.length) return fiHits
  const merged = new Map<string, RasTraceMarker>()
  for (const marker of [...fiHits, ...rasHits]) merged.set(marker.id, marker)
  return [...merged.values()]
}
