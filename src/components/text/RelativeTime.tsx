// docs/design/patterns.md §2 — list uses relative time, tooltip shows absolute (UTC+local).
'use client';

import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { useLocale } from '@/lib/client/locale-context';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface RelativeTimeProps {
  value: string | number | Date | undefined | null;
  className?: string;
}

export function RelativeTime({ value, className }: RelativeTimeProps) {
  const { locale } = useLocale();
  if (value == null || value === '') return <span className="text-foreground-muted">—</span>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-foreground-muted">—</span>;

  const distance = formatDistanceToNow(date, {
    addSuffix: true,
    locale: locale === 'zh' ? zhCN : enUS,
  });
  const abs = date.toLocaleString();

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={className}>{distance}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-xs">{abs}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
