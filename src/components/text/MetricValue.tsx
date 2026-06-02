// docs/design/foundations.md §0.2 anchor ③ + §C.3 — tabular-nums + 单位下标 + Intl.NumberFormat。
// 极简首版：满足 KPI 卡 / 表格数值列的对位需求；compact 用 Intl 缩写（1.23M）。
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface MetricValueProps {
  value: number | string | null | undefined;
  unit?: string;
  format?: 'plain' | 'compact' | 'percent';
  precision?: number;
  /** 主数字字号档：sm 12 / md 14 / lg 18 / xl 24 */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'default' | 'success' | 'warning' | 'error' | 'muted';
  className?: string;
  /** 空值占位（默认 —）— foundations 不允许显示 null / undefined / N/A */
  fallback?: string;
}

const SIZE_CLASSES: Record<NonNullable<MetricValueProps['size']>, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
  xl: 'text-2xl',
};

const TONE_CLASSES: Record<NonNullable<MetricValueProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--error)]',
  muted: 'text-foreground-muted',
};

function formatNumber(value: number, format: NonNullable<MetricValueProps['format']>, precision = 1): string {
  if (format === 'compact') {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: precision }).format(value);
  }
  if (format === 'percent') {
    return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: precision }).format(value);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: precision }).format(value);
}

export function MetricValue({
  value,
  unit,
  format = 'plain',
  precision,
  size = 'md',
  tone = 'default',
  className,
  fallback = '—',
}: MetricValueProps) {
  let main: string;
  if (value == null || value === '') {
    main = fallback;
  } else if (typeof value === 'number') {
    main = Number.isFinite(value) ? formatNumber(value, format, precision) : fallback;
  } else {
    main = String(value);
  }
  return (
    <span className={cn('inline-flex items-baseline gap-1 font-mono tabular-nums font-semibold', SIZE_CLASSES[size], TONE_CLASSES[tone], className)}>
      <span>{main}</span>
      {unit && main !== fallback && (
        <span className="text-[0.65em] font-medium text-foreground-muted">{unit}</span>
      )}
    </span>
  );
}

export default MetricValue;
