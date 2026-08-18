'use client';

import { ArrowRight, Ban, Database, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDurationMs } from '@/lib/latency-format';

export type TraceThreadEventView = {
  id: string;
  kind: string;
  status?: string;
  sourceTurnId?: string;
  phaseId?: string;
  startedAt: string;
  completedAt?: string;
  executionId?: string;
  relatedExecutionId?: string;
  payload?: Record<string, unknown>;
};

export type TraceThreadView = {
  id: string;
  sourceKind?: string;
  previousExecutionId?: string;
  nextExecutionId?: string;
  events: TraceThreadEventView[];
};

function eventLabel(event: TraceThreadEventView, locale: string): string {
  if (event.kind === 'context_compaction') {
    const duration = Number(event.payload?.durationMs);
    const suffix = Number.isFinite(duration) && duration > 0 ? ` (${formatDurationMs(duration)})` : '';
    return `${locale === 'zh' ? '上下文已压缩' : 'Context compacted'}${suffix}`;
  }
  if (event.kind === 'input_steer') {
    return locale === 'zh' ? '同一任务已接受引导输入' : 'Steer input accepted in the same task';
  }
  if (event.kind === 'interrupt') {
    return locale === 'zh' ? '任务已中断' : 'Task interrupted';
  }
  const transitionKind = String(event.payload?.transitionKind || '');
  if (transitionKind === 'steered_to_new_execution') {
    return locale === 'zh' ? '引导后转入新任务' : 'Steered to a new task';
  }
  return locale === 'zh' ? '前一任务中断后继续' : 'Continued after the previous task was interrupted';
}

function EventIcon({ kind }: { kind: string }) {
  if (kind === 'context_compaction') return <Database className="size-3.5" aria-hidden />;
  if (kind === 'input_steer') return <MessageSquare className="size-3.5" aria-hidden />;
  return <Ban className="size-3.5" aria-hidden />;
}

export function CodexThreadTimeline({
  thread,
  locale,
  onNavigate,
}: {
  thread?: TraceThreadView;
  locale: string;
  onNavigate: (taskId: string) => void;
}) {
  if (!thread || (!thread.previousExecutionId && !thread.nextExecutionId && thread.events.length === 0)) return null;

  return (
    <section className="mb-3 shrink-0 border-y border-border bg-background-secondary/40 px-3 py-2" aria-label={locale === 'zh' ? '会话时间线' : 'Thread timeline'}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-foreground">
          {locale === 'zh' ? '会话时间线' : 'Thread timeline'}
        </h3>
        {thread.previousExecutionId && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onNavigate(thread.previousExecutionId!)}>
            {locale === 'zh' ? '前一任务' : 'Previous task'}
          </Button>
        )}
        {thread.previousExecutionId && thread.nextExecutionId && <ArrowRight className="size-3 text-foreground-muted" aria-hidden />}
        {thread.nextExecutionId && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onNavigate(thread.nextExecutionId!)}>
            {locale === 'zh' ? '后一任务' : 'Next task'}
          </Button>
        )}
      </div>
      {thread.events.length > 0 && (
        <ol className="mt-2 grid gap-1">
          {thread.events.map((event) => {
            const target = event.relatedExecutionId || event.executionId;
            const content = (
              <>
                <EventIcon kind={event.kind} />
                <span className="min-w-0 flex-1">{eventLabel(event, locale)}</span>
                <time className="shrink-0 tabular-nums text-foreground-muted" dateTime={event.startedAt}>
                  {new Date(event.startedAt).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </time>
              </>
            );
            return (
              <li key={event.id}>
                {target ? (
                  <button type="button" onClick={() => onNavigate(target)} className="flex min-h-7 w-full items-center gap-2 py-1 text-left text-xs text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {content}
                  </button>
                ) : (
                  <div className="flex min-h-7 items-center gap-2 py-1 text-xs text-foreground">{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
