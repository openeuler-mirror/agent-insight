'use client';

import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import {
  rasKindLabel,
  rasSeverityLabel,
  severityToStatusKind,
  type RasEventRow,
} from '@/lib/ingest/ras/normalize';

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eventTypeLabel(type: string, locale: 'zh' | 'en'): string {
  if (type === 'anomaly') return locale === 'zh' ? '异常检测' : 'Anomaly';
  if (type === 'actions') return locale === 'zh' ? '处置下发' : 'Actions';
  if (type === 'action_result') return locale === 'zh' ? '处置结果' : 'Action result';
  return type;
}

export function RasOnlyEventTimeline({
  events,
  locale,
}: {
  events: RasEventRow[];
  locale: 'zh' | 'en';
}) {
  const ordered = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  return (
    <div className="rounded-md border border-card-border bg-card p-4 space-y-3">
      <p className="text-xs text-foreground-muted leading-relaxed">
        {locale === 'zh'
          ? '该任务仅有 RAS 环内事件，未关联平台 Execution / OTel，因此没有 Agent 对话链路。下方按时间展示 RAS 检测与恢复处置。'
          : 'This task only has in-loop RAS events (no Execution / OTel), so there is no agent conversation trace. Timeline below shows detection and recovery.'}
      </p>
      <ol className="space-y-2">
        {ordered.map((ev) => {
          const payload = parsePayload(ev.payloadJson);
          const action = typeof payload.action === 'string' ? payload.action : null;
          const ok = typeof payload.ok === 'boolean' ? payload.ok : null;
          const channel = typeof payload.channel === 'string' ? payload.channel : null;
          const message =
            typeof payload.message === 'string'
              ? payload.message
              : typeof ev.summary === 'string'
                ? ev.summary
                : null;

          return (
            <li
              key={ev.id}
              className="rounded-md border border-border bg-background-secondary px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px]">
                  {eventTypeLabel(ev.type, locale)}
                </Badge>
                {ev.type === 'anomaly' && ev.anomalyKind ? (
                  <Badge variant="outline" className="text-[10px]">
                    {rasKindLabel(ev.anomalyKind, locale)}
                  </Badge>
                ) : null}
                {ev.type === 'anomaly' ? (
                  <StatusBadge
                    status={severityToStatusKind(ev.severity)}
                    label={rasSeverityLabel(ev.severity, locale)}
                  />
                ) : null}
                {action ? (
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {action}
                  </Badge>
                ) : null}
                {ok === true ? (
                  <StatusBadge status="success" label={locale === 'zh' ? '成功' : 'OK'} />
                ) : null}
                {ok === false ? (
                  <StatusBadge status="error" label={locale === 'zh' ? '失败' : 'Failed'} />
                ) : null}
                <span className="text-[11px] text-foreground-muted tabular-nums">
                  {new Date(ev.ts).toLocaleString()}
                </span>
              </div>
              {channel ? (
                <p className="text-[11px] text-foreground-muted font-mono">{channel}</p>
              ) : null}
              {message ? (
                <pre className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground-secondary">
                  {message}
                </pre>
              ) : null}
              {ev.type === 'anomaly' && ev.actionTypes ? (
                <p className="mt-1 text-[11px] text-foreground-muted">
                  {locale === 'zh' ? '计划动作：' : 'Planned actions: '}
                  <span className="font-mono">{ev.actionTypes}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
