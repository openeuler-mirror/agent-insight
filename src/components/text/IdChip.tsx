// docs/design/patterns.md §2 — long ID display: head 6 + ... + tail 4, hover tooltip + copy.
'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface IdChipProps {
  value: string;
  head?: number;
  tail?: number;
  copy?: boolean;
  className?: string;
  onClick?: () => void;
}

export function IdChip({ value, head = 6, tail = 4, copy = true, className, onClick }: IdChipProps) {
  const [copied, setCopied] = React.useState(false);
  if (!value) return <span className="text-foreground-muted">—</span>;
  const truncated = value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;

  const doCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={onClick}
            className={cn(
              'inline-flex items-center gap-1 font-mono text-xs text-foreground tabular-nums',
              onClick && 'cursor-pointer hover:text-primary',
              className,
            )}
          >
            <span>{truncated}</span>
            {copy && (
              <button
                type="button"
                onClick={doCopy}
                aria-label="Copy ID"
                className="text-foreground-muted hover:text-foreground p-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <code className="text-xs">{value}</code>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
