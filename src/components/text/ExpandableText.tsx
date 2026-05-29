'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';

interface ExpandableTextProps {
  children: React.ReactNode;
  maxLines?: number;
  className?: string;
  buttonClassName?: string;
  expandLabel?: string;
  collapseLabel?: string;
}

export function ExpandableText({
  children,
  maxLines = 6,
  className,
  buttonClassName,
  expandLabel = 'Expand',
  collapseLabel = 'Collapse',
}: ExpandableTextProps) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const expandedRef = React.useRef(false);
  const [expanded, setExpanded] = React.useState(false);
  const [canExpand, setCanExpand] = React.useState(false);

  React.useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      if (expandedRef.current) return;
      setCanExpand(el.scrollHeight > el.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, maxLines]);

  return (
    <div className="min-w-0">
      <div
        ref={contentRef}
        className={cn('min-w-0 whitespace-pre-wrap break-words', className)}
        style={expanded
          ? undefined
          : {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: maxLines,
              overflow: 'hidden',
            }}
      >
        {children}
      </div>
      {canExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(
            'mt-1 inline-flex items-center gap-1 rounded-sm text-[11.5px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            buttonClassName,
          )}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? collapseLabel : expandLabel}
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      )}
    </div>
  );
}
