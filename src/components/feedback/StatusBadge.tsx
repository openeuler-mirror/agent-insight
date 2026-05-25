// docs/design/foundations.md §2 B.4 — status must be color + icon + text (triple-encoded).
import * as React from 'react';
import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StatusKind = 'running' | 'success' | 'warning' | 'error' | 'cancelled' | 'pending';

interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: StatusKind;
  label: string;
  variant?: 'subtle' | 'outline';
  size?: 'sm' | 'md';
}

const STATUS_CLASSES: Record<StatusKind, { subtle: string; outline: string; iconClass?: string }> = {
  // foundations.md §2 B.4 — Running is Blue-600 (#2563EB), NOT primary Indigo, to avoid clash with primary action button.
  running: {
    subtle:  'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-400/30',
    outline: 'bg-transparent text-blue-700 border-blue-300 dark:text-blue-300 dark:border-blue-400/40',
    iconClass: 'animate-spin',
  },
  success: {
    subtle:  'bg-success-subtle text-success border-success-border',
    outline: 'bg-transparent text-success border-success/40',
  },
  warning: {
    subtle:  'bg-warning-subtle text-warning border-warning-border',
    outline: 'bg-transparent text-warning border-warning/40',
  },
  error: {
    subtle:  'bg-error-subtle text-error border-error-border',
    outline: 'bg-transparent text-error border-error/40',
  },
  cancelled: {
    subtle:  'bg-background-secondary text-foreground-muted border-border',
    outline: 'bg-transparent text-foreground-muted border-border-dark',
  },
  pending: {
    subtle:  'bg-background-secondary text-foreground-muted border-border',
    outline: 'bg-transparent text-foreground-muted border-border',
  },
};

const STATUS_ICONS: Record<StatusKind, React.ComponentType<{ className?: string }>> = {
  running: Loader2,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  cancelled: Ban,
  pending: Clock,
};

export function StatusBadge({
  status,
  label,
  variant = 'subtle',
  size = 'sm',
  className,
  ...rest
}: StatusBadgeProps) {
  const Icon = STATUS_ICONS[status];
  const palette = STATUS_CLASSES[status];
  const sizing = size === 'sm' ? 'h-5 px-1.5 text-xs gap-1' : 'h-6 px-2 text-sm gap-1.5';
  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center rounded-sm border font-medium whitespace-nowrap',
        sizing,
        palette[variant],
        className,
      )}
      {...rest}
    >
      <Icon className={cn('size-3.5 shrink-0', palette.iconClass)} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
