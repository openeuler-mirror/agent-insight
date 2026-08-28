'use client';

import type { ReactNode } from 'react';
import { Check, ChevronRight, CircleAlert, Loader2, Sparkles, SquareTerminal } from 'lucide-react';

import type { ProcessState } from '@/lib/chat/process-block-state';
export { resolveProcessState as processState } from '@/lib/chat/process-block-state';

export function ConversationProcessDisclosure({
  kind,
  state,
  name,
  children,
}: {
  kind: 'thinking' | 'tool';
  state: ProcessState;
  name?: string;
  children: ReactNode;
}) {
  const thinking = kind === 'thinking';
  const label = thinking
    ? state === 'running' ? '正在思考' : state === 'error' ? '思考已中断' : '已完成思考'
    : state === 'running' ? '正在执行命令' : state === 'error' ? '命令执行失败' : '已执行命令';
  const stateClass = state === 'error'
    ? 'text-error'
    : state === 'complete' && !thinking
      ? 'text-success'
      : 'text-primary';

  return (
    <details className="group my-1 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-card text-[11px]">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-foreground-secondary transition-colors hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className={`flex size-4 shrink-0 items-center justify-center ${stateClass}`} aria-hidden="true">
          {state === 'running'
            ? <Loader2 className="size-3.5 animate-spin" />
            : state === 'error'
              ? <CircleAlert className="size-3.5" />
              : thinking
                ? <Sparkles className="size-3.5" />
                : <Check className="size-3.5" />}
        </span>
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {name && (
          <span className="min-w-0 truncate rounded bg-background-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted" title={name}>
            {name}
          </span>
        )}
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-foreground-muted transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="min-w-0 border-t border-border bg-background-secondary px-3 py-2.5 text-foreground-secondary">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-foreground-muted">
          {thinking ? <Sparkles className="size-3" /> : <SquareTerminal className="size-3" />}
          {thinking ? '思考过程' : '执行详情'}
        </div>
        {children}
      </div>
    </details>
  );
}
