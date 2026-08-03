'use client';

import { useLocale } from '@/lib/client/locale-context';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Term } from '@/components/text/Term';

interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  none: number;
}

interface Props {
  total: number;
  severityCounts: SeverityCounts;
  selectedSeverity: string | null;
  onSeverityClick: (severity: string) => void;
  loading: boolean;
}

interface StatItem {
  key: string;
  labelZh: string;
  labelEn: string;
  value: number;
  accent?: 'error' | 'warn' | 'good' | 'count';
  termId: string;
}

function buildStats(total: number, counts: SeverityCounts): StatItem[] {
  return [
    { key: 'total', labelZh: 'Traces', labelEn: 'Traces', value: total, accent: 'count', termId: 'trace' },
    { key: 'critical', labelZh: '严重 (critical)', labelEn: 'Critical', value: counts.critical, accent: 'error', termId: 'ras-severity' },
    { key: 'high', labelZh: '高危 (high)', labelEn: 'High', value: counts.high, accent: 'error', termId: 'ras-severity' },
    { key: 'medium', labelZh: '中危 (medium)', labelEn: 'Medium', value: counts.medium, accent: 'warn', termId: 'ras-severity' },
    { key: 'low', labelZh: '低危 (low)', labelEn: 'Low', value: counts.low, accent: 'warn', termId: 'ras-severity' },
    { key: 'none', labelZh: '无故障', labelEn: 'No Fault', value: counts.none, accent: 'good', termId: 'ras-no-fault' },
  ];
}

export function FaultStatsPanel({ total, severityCounts, selectedSeverity, onSeverityClick, loading }: Props) {
  const { locale } = useLocale();
  const stats = buildStats(total, severityCounts);

  if (loading) {
    return (
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <Skeleton key={i} className="h-[72px] rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-foreground-muted">
          {locale === 'zh'
            ? `共 ${total} 次记录`
            : `${total} records total`}
        </span>
        {selectedSeverity && (
          <button
            onClick={() => onSeverityClick(selectedSeverity)}
            className="px-2 py-0.5 rounded-full text-[11px] bg-primary-subtle text-primary border-none cursor-pointer"
          >
            {locale === 'zh' ? '清除筛选' : 'Clear filter'}
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {stats.map(stat => {
          const active = selectedSeverity === stat.key;
          const label = locale === 'zh' ? stat.labelZh : stat.labelEn;

          return (
            <div
              key={stat.key}
              role={stat.key === 'total' ? undefined : 'button'}
              tabIndex={stat.key === 'total' ? undefined : 0}
              onClick={() => { if (stat.key !== 'total') onSeverityClick(stat.key); }}
              onKeyDown={(event) => {
                if (stat.key !== 'total' && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSeverityClick(stat.key);
                }
              }}
              className={cn(
                'rounded-md border bg-card p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-primary bg-primary-subtle'
                  : 'border-card-border',
                stat.key === 'total' ? 'cursor-default' : 'cursor-pointer',
              )}
            >
              <div className="text-xs text-foreground-muted">
                <Term id={stat.termId} label={label} align={stat.key === 'none' ? 'end' : undefined} />
              </div>
              <div className={cn(
                'mt-1 text-xl font-semibold tabular-nums',
                stat.accent === 'error' && 'text-error',
                stat.accent === 'warn' && 'text-warning',
                stat.accent === 'good' && 'text-success',
                stat.accent === 'count' && 'text-foreground',
              )}>
                {stat.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
