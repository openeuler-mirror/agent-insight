'use client';

import { useEffect, useState, useCallback, use, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer, PageContent } from '@/components/shell/PageContainer';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { rasKindLabel, rasSeverityLabel, severityToStatusKind, type RasEventRow } from '@/lib/ingest/ras/normalize';
import AgentTraceView from '@/components/observe/AgentTraceView';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { IdChip } from '@/components/text/IdChip';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  buildRasTraceMarkers,
  type RasRecoveryAction,
} from '@/lib/ingest/ras/trace-markers';
import { buildRasDeliveryLinks } from '@/lib/ingest/ras/delivery-link';

export default function RasTraceDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = use(params);
  return <RasTraceDetailContent taskId={decodeURIComponent(taskId)} />;
}

interface ObserveSessionPayload {
  interactions?: RawInteraction[];
  langfuseTraceNodes?: LangfuseTraceNode[];
}

function RasTraceDetailContent({ taskId }: { taskId: string }) {
  const { locale } = useLocale();
  const { user, apiKey } = useAuth();
  const router = useRouter();

  const [rasEvents, setRasEvents] = useState<RasEventRow[] | null>(null);
  const [rasLoading, setRasLoading] = useState(true);
  const [rootExecutionId, setRootExecutionId] = useState<string | undefined>();
  const [session, setSession] = useState<ObserveSessionPayload | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Load RAS events
  useEffect(() => {
    if (!taskId || !user) return;
    if (!apiKey) {
      void Promise.resolve().then(() => {
        setRasEvents([]);
        setRasLoading(false);
      });
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ taskId });

    apiFetch(`/api/ingest/ras-events?${qs.toString()}`, {
      headers: { 'x-witty-api-key': apiKey },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setRasEvents(Array.isArray(data.events) ? data.events : []);
          setRootExecutionId(typeof data.executionId === 'string' ? data.executionId : undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setRasEvents([]);
      })
      .finally(() => {
        if (!cancelled) setRasLoading(false);
      });

    return () => { cancelled = true; };
  }, [taskId, user, apiKey]);

  // Load session (AgentTraceView data)
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=structure`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) { if (!cancelled) { setSession(null); setSessionLoading(false); } return; }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) { setSession(data); setSessionLoading(false); }
      })
      .catch((e: Error) => {
        if (!cancelled) setSessionError(e.message || 'load failed');
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    return () => { cancelled = true; };
  }, [taskId]);

  const loadInteraction = useCallback(async (index: number) => {
    const response = await apiFetch(
      `/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interaction&index=${index}`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return body?.interaction;
  }, [taskId]);

  const loadFullInteractions = useCallback(async () => {
    const response = await apiFetch(
      `/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interactions`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.interactions) ? body.interactions : [];
  }, [taskId]);

  const anomalies = rasEvents?.filter(e => e.type === 'anomaly') ?? [];
  const interactions = session?.interactions || [];
  const langfuseTraceNodes = session?.langfuseTraceNodes || [];
  const anomalyMarkers = useMemo(() => {
    const markers = buildRasTraceMarkers(rasEvents || [], locale === 'zh' ? 'zh' : 'en');
    const links = buildRasDeliveryLinks({ markers, interactions });
    return markers.map((marker) => {
      const extraIds = [...links.values()]
        .filter((link) => link.markerId === marker.id && link.messageId)
        .map((link) => link.messageId as string);
      return {
        ...marker,
        deliveryMessageIds: [...new Set([...marker.deliveryMessageIds, ...extraIds])],
      };
    });
  }, [interactions, locale, rasEvents]);
  const anomalyMarkerById = useMemo(
    () => new Map(anomalyMarkers.map(marker => [marker.id, marker])),
    [anomalyMarkers],
  );

  // Detection + delivery hang on LLM/RAS nodes; do not inject flat 处置成功 rows.
  const reliabilityEvents = useMemo(() => [], []);

  return (
    <>
      <AppTopBar
        title={
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/agent-ras/trace')}
              className="text-foreground-muted h-7 px-2 -ml-2"
            >
              <ArrowLeft className="size-3.5" />
              {locale === 'zh' ? '返回列表' : 'Back to list'}
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <IdChip value={taskId} head={8} tail={6} />
          </div>
        }
      />
      <PageContainer>
        <PageContent className="flex flex-col gap-4">
          {/* RAS Anomaly Events */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">
              {locale === 'zh' ? 'RAS 可靠性异常事件' : 'RAS Reliability Anomaly Events'}
              <span className="ml-2 text-foreground-muted font-normal text-xs tabular-nums">
                {anomalies.length}
              </span>
            </h2>

            {rasLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            ) : anomalies.length === 0 ? (
              <EmptyState
                title={locale === 'zh' ? '无 RAS 异常事件' : 'No RAS anomaly events'}
                description={locale === 'zh' ? '该 Trace 暂未检测到 RAS 异常' : 'No RAS anomalies detected for this trace'}
              />
            ) : (
              <div className="space-y-2">
                {anomalies.map(ev => {
                  const marker = anomalyMarkerById.get(ev.id);
                  return (
                    <div
                      key={ev.id}
                      className="rounded-md border border-card-border bg-card p-3"
                    >
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        {ev.anomalyKind && (
                          <Badge variant="outline" className="text-[11px]">
                            {rasKindLabel(ev.anomalyKind, locale === 'zh' ? 'zh' : 'en')}
                          </Badge>
                        )}
                        <StatusBadge
                          status={severityToStatusKind(ev.severity)}
                          label={rasSeverityLabel(ev.severity, locale === 'zh' ? 'zh' : 'en')}
                        />
                        <span className="text-[11px] text-foreground-muted">
                          {new Date(ev.ts).toLocaleString()}
                        </span>
                      </div>
                      {ev.summary && (
                        <p className="text-xs text-foreground-secondary mt-1 leading-relaxed">
                          {ev.summary}
                        </p>
                      )}
                      {marker?.actions.length ? (
                        <div className="mt-2 space-y-1.5">
                          {marker.actions.map((action, index) => (
                            <RasActionContent
                              key={`${action.type}-${index}`}
                              action={action}
                              locale={locale === 'zh' ? 'zh' : 'en'}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <Separator />

          {/* Full Trace View */}
          <div className="flex-1 min-h-0 flex flex-col">
            <h2 className="text-sm font-semibold text-foreground mb-3">
              {locale === 'zh' ? '完整链路追踪' : 'Full Trace'}
            </h2>

            {sessionLoading ? (
              <div className="rounded-md border border-card-border bg-card p-4 space-y-2">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-6 w-2/3" />
              </div>
            ) : sessionError ? (
              <EmptyState
                title={locale === 'zh' ? '无法加载 Trace' : 'Unable to Load Trace'}
                description={locale === 'zh' ? '该 Trace 可能尚未同步到观测系统' : 'This trace may not be synced to the observability system yet'}
              />
            ) : interactions.length > 0 || langfuseTraceNodes.length > 0 ? (
              <div className="flex-1 min-h-0 rounded-md border border-card-border bg-card overflow-auto">
                <AgentTraceView
                  key={taskId}
                  interactions={interactions}
                  langfuseTraceNodes={langfuseTraceNodes}
                  loadInteraction={loadInteraction}
                  loadAllInteractions={loadFullInteractions}
                  onSubagentNavigate={(subTaskId: string) => {
                    router.push(`/agent-ras/trace/${encodeURIComponent(subTaskId)}`);
                  }}
                  rootExecutionId={rootExecutionId || taskId}
                  traceKey={taskId}
                  anomalies={anomalyMarkers}
                  reliabilityEvents={reliabilityEvents}
                />
              </div>
            ) : (
              <EmptyState
                title={locale === 'zh' ? '无 Trace 数据' : 'No Trace Data'}
                description={locale === 'zh' ? '该 Trace 暂无交互记录' : 'No interaction records for this trace'}
              />
            )}
          </div>
        </PageContent>
      </PageContainer>
    </>
  );
}

function RasActionContent({
  action,
  locale,
}: {
  action: RasRecoveryAction;
  locale: 'zh' | 'en';
}) {
  return (
    <div className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px] font-mono">
          {action.type}
        </Badge>
        <span className="text-[11px] font-medium text-foreground-secondary">
          {locale === 'zh' ? 'RAS恢复操作' : 'RAS recovery action'}
        </span>
      </div>
      {action.message && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground-secondary">
          {action.message}
        </pre>
      )}
    </div>
  );
}
