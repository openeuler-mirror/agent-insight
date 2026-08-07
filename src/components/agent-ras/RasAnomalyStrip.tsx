'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/lib/client/locale-context';
import {
  rasKindLabel,
  rasSeverityLabel,
  severityToStatusKind,
} from '@/lib/ingest/ras/normalize';
import {
  buildRasFaultOpTags,
  rasFaultRowOutcome,
  type RasFaultRowOutcome,
} from '@/lib/ingest/ras/fault-row';
import type { RasTraceMarker } from '@/lib/ingest/ras/trace-markers';
import { cn } from '@/lib/utils';

const SEV_ORDER = ['critical', 'high', 'medium', 'low'] as const;

type SeverityFilter = 'all' | (typeof SEV_ORDER)[number];

function outcomeLabel(outcome: RasFaultRowOutcome, zh: boolean): string {
  if (outcome === 'success') return zh ? '恢复成功' : 'Recovered';
  if (outcome === 'failed') return zh ? '恢复失败' : 'Failed';
  if (outcome === 'unknown') return zh ? '结果未知' : 'Unknown';
  return zh ? '未恢复' : 'No recovery';
}

function outcomeStatus(outcome: RasFaultRowOutcome): 'success' | 'error' | 'pending' | 'warning' {
  if (outcome === 'success') return 'success';
  if (outcome === 'failed') return 'error';
  if (outcome === 'unknown') return 'warning';
  return 'pending';
}

export function RasAnomalyStrip({
  markers,
  selectedMarkerId,
  onSelect,
  loading = false,
}: {
  markers: RasTraceMarker[];
  selectedMarkerId?: string | null;
  onSelect?: (markerId: string) => void;
  loading?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [open, setOpen] = useState(false);
  const [filterSev, setFilterSev] = useState<SeverityFilter>('all');

  const severityCounts = useMemo(() => {
    const counts: Record<(typeof SEV_ORDER)[number], number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const marker of markers) {
      const key = String(marker.severity || '').toLowerCase();
      if (key === 'critical' || key === 'high' || key === 'medium' || key === 'low') {
        counts[key] += 1;
      }
    }
    return counts;
  }, [markers]);

  const visible = useMemo(() => {
    if (filterSev === 'all') return markers;
    return markers.filter(
      (marker) => String(marker.severity || '').toLowerCase() === filterSev,
    );
  }, [filterSev, markers]);

  if (loading) {
    return <Skeleton className="h-10 w-full rounded-md" />;
  }

  return (
    <div className="overflow-hidden rounded-md border border-card-border bg-card">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="flex min-h-10 cursor-pointer select-none items-center gap-2.5 px-3 py-2 hover:bg-background-secondary"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <AlertTriangle className="size-3.5 text-error" aria-hidden />
          {zh ? 'RAS 异常' : 'RAS anomalies'}
          <span className="text-xs font-normal tabular-nums text-foreground-muted">
            {markers.length}
          </span>
        </div>

        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <SeverityChip
            active={filterSev === 'all'}
            label={zh ? '全部' : 'All'}
            count={markers.length}
            onClick={() => setFilterSev('all')}
          />
          {SEV_ORDER.filter((key) => severityCounts[key] > 0).map((key) => (
            <SeverityChip
              key={key}
              active={filterSev === key}
              label={key === 'critical' ? 'Critical' : key === 'high' ? 'High' : key === 'medium' ? 'Medium' : 'Low'}
              count={severityCounts[key]}
              severity={key}
              onClick={() => setFilterSev(key)}
            />
          ))}
        </div>

        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-foreground-muted transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </div>

      {open ? (
        <div className="max-h-[280px] overflow-auto border-t border-border bg-background-secondary p-1.5">
          <div className="mb-1 hidden grid-cols-[minmax(96px,auto)_auto_minmax(0,1fr)_auto_auto_auto] gap-x-2.5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted md:grid">
            <span>{zh ? '故障类型' : 'Kind'}</span>
            <span>{zh ? '严重度' : 'Severity'}</span>
            <span>{zh ? '摘要' : 'Summary'}</span>
            <span>{zh ? '操作' : 'Actions'}</span>
            <span>{zh ? '结果' : 'Result'}</span>
            <span>{zh ? '时间' : 'Time'}</span>
          </div>
          {visible.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-xs text-foreground-muted">
              {zh ? '无匹配的严重度' : 'No matching severity'}
            </p>
          ) : (
            visible.map((marker) => {
              const tags = buildRasFaultOpTags(marker);
              const outcome = rasFaultRowOutcome(marker);
              const selected = selectedMarkerId === marker.id;
              return (
                <button
                  key={marker.id}
                  type="button"
                  onClick={() => onSelect?.(marker.id)}
                  className={cn(
                    'mb-1 grid w-full grid-cols-1 items-center gap-2 rounded-sm border border-card-border bg-card px-2.5 py-2 text-left last:mb-0 md:grid-cols-[minmax(96px,auto)_auto_minmax(0,1fr)_auto_auto_auto] md:gap-x-2.5',
                    selected && 'border-primary-border bg-primary-subtle',
                  )}
                >
                  <div>
                    <Badge variant="outline" className="text-[11px]">
                      {rasKindLabel(marker.kind, zh ? 'zh' : 'en')}
                    </Badge>
                  </div>
                  <div>
                    <StatusBadge
                      status={severityToStatusKind(marker.severity)}
                      label={rasSeverityLabel(marker.severity, zh ? 'zh' : 'en')}
                    />
                  </div>
                  <div
                    className="min-w-0 truncate text-xs text-foreground-secondary"
                    title={marker.summary || undefined}
                  >
                    {marker.summary || '—'}
                  </div>
                  <div className="flex flex-wrap items-center justify-start gap-1 md:justify-end">
                    {tags.length === 0 ? (
                      <span className="rounded-sm border border-border bg-background-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted opacity-70">
                        {zh ? '无操作' : 'none'}
                      </span>
                    ) : (
                      tags.map((tag) => (
                        <span
                          key={tag.type}
                          className={cn(
                            'inline-flex h-[18px] items-center rounded-sm border px-1.5 font-mono text-[10px]',
                            tag.role === 'abort'
                              ? 'border-warning-border bg-warning-subtle text-warning'
                              : 'border-primary-border bg-primary-subtle text-primary',
                          )}
                        >
                          {tag.type}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="md:justify-self-end">
                    <StatusBadge
                      status={outcomeStatus(outcome)}
                      label={outcomeLabel(outcome, zh)}
                    />
                  </div>
                  <div className="text-[11px] tabular-nums text-foreground-muted md:justify-self-end">
                    {new Date(marker.ts).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                    })}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function SeverityChip({
  active,
  label,
  count,
  severity,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  severity?: (typeof SEV_ORDER)[number];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px]',
        active
          ? 'border-primary-border bg-primary-subtle font-medium text-primary'
          : 'border-border bg-background-secondary text-foreground-secondary hover:border-border-dark',
      )}
    >
      {severity ? (
        <span
          className={cn(
            'size-1.5 rounded-full',
            severity === 'critical' || severity === 'high'
              ? 'bg-error'
              : severity === 'medium'
                ? 'bg-warning'
                : 'bg-foreground-muted',
          )}
        />
      ) : null}
      {label}
      <span className="font-semibold tabular-nums">{count}</span>
    </button>
  );
}
