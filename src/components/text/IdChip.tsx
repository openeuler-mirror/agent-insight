/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// docs/design/patterns.md §2 — long ID display: head 6 + ... + tail 4, hover tooltip + copy.
'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/copy-text';

interface IdChipProps {
  value: string;
  head?: number;
  tail?: number;
  copy?: boolean;
  adaptive?: boolean;
  className?: string;
  onClick?: () => void;
}

export function IdChip({ value, head = 6, tail = 4, copy = true, adaptive = false, className, onClick }: IdChipProps) {
  const [copied, setCopied] = React.useState(false);
  if (!value) return <span className="text-foreground-muted">—</span>;
  const truncated = value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;

  const doCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // http 部署下 navigator.clipboard 不可用,copyText 内部带 execCommand fallback
      await copyText(value);
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
              adaptive && 'max-w-full min-w-0',
              onClick && 'cursor-pointer hover:text-primary',
              className,
            )}
          >
            <span className={adaptive ? 'min-w-0 truncate' : undefined}>{adaptive ? value : truncated}</span>
            {copy && (
              <button
                type="button"
                onClick={doCopy}
                aria-label="Copy ID"
                className="shrink-0 text-foreground-muted hover:text-foreground p-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
