'use client';

import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { useLocale } from '@/lib/client/locale-context';
import { formatAbsoluteLocalTime } from '@/lib/time-format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface RelativeTimeProps {
  value: string | number | Date | undefined | null;
  className?: string;
  display?: 'relative' | 'absolute';
}

export function RelativeTime({ value, className, display = 'relative' }: RelativeTimeProps) {
  const { locale } = useLocale();
  if (value == null || value === '') return <span className="text-foreground-muted">—</span>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-foreground-muted">—</span>;

  const distance = formatDistanceToNow(date, {
    addSuffix: true,
    locale: locale === 'zh' ? zhCN : enUS,
  });
  const absolute = formatAbsoluteLocalTime(date) ?? '—';
  const label = display === 'absolute' ? absolute : distance;
  const tooltip = display === 'absolute' ? distance : absolute;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span suppressHydrationWarning className={className}>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
