// docs/design/patterns.md §2 — single-line truncate + tooltip with full content.
'use client';

import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface TruncateTextProps {
  children: string | undefined | null;
  className?: string;
  /** Max content shown inside the tooltip (default 200). */
  tooltipMax?: number;
  /** Render this when value is empty/null. Default "—". */
  empty?: React.ReactNode;
}

export function TruncateText({ children, className, tooltipMax = 200, empty = <span className="text-foreground-muted">—</span> }: TruncateTextProps) {
  const text = (children ?? '').toString();
  if (!text) return <>{empty}</>;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('block truncate', className)}>{text}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap text-xs">
          {text.length > tooltipMax ? `${text.slice(0, tooltipMax)}…` : text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
