'use client';

import { useEffect, useState, useCallback, use, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer, PageContent } from '@/components/shell/PageContainer';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { type RasEventRow } from '@/lib/ingest/ras/normalize';
import AgentTraceView from '@/components/observe/AgentTraceView';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { IdChip } from '@/components/text/IdChip';
import { EmptyState } from '@/components/feedback/EmptyState';
import { RasAnomalyStrip } from '@/components/agent-ras/RasAnomalyStrip';
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers';
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
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);

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
  const framework = useMemo(() => {
    const fromEvents = (rasEvents || [])
      .map((event) => String(event.framework || '').trim())
      .find(Boolean);
    return fromEvents || undefined;
  }, [rasEvents]);
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
          {/* RAS Anomaly Events — collapsible strip, one row per anomaly */}
          {rasLoading ? (
            <Skeleton className="h-10 w-full rounded-md" />
          ) : anomalies.length === 0 ? (
            <EmptyState
              title={locale === 'zh' ? '无 RAS 异常事件' : 'No RAS anomaly events'}
              description={locale === 'zh' ? '该 Trace 暂未检测到 RAS 异常' : 'No RAS anomalies detected for this trace'}
            />
          ) : (
            <RasAnomalyStrip
              markers={anomalyMarkers}
              selectedMarkerId={selectedMarkerId}
              onSelect={setSelectedMarkerId}
            />
          )}

          <Separator />

          {/* Full Trace View — no RAS-events-only timeline fallback */}
          <div className="flex-1 min-h-0 flex flex-col">
            <h2 className="text-sm font-semibold text-foreground mb-3">
              {locale === 'zh' ? '完整链路追踪' : 'Full Trace'}
            </h2>

            {sessionLoading || rasLoading ? (
              <div className="rounded-md border border-card-border bg-card p-4 space-y-2">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-6 w-2/3" />
              </div>
            ) : interactions.length > 0 || langfuseTraceNodes.length > 0 ? (
              <div className="flex-1 min-h-0 rounded-md border border-card-border bg-card overflow-auto">
                <AgentTraceView
                  key={taskId}
                  interactions={interactions}
                  framework={framework}
                  langfuseTraceNodes={langfuseTraceNodes}
                  loadInteraction={loadInteraction}
                  loadAllInteractions={loadFullInteractions}
                  onSubagentNavigate={(subTaskId: string) => {
                    router.push(`/agent-ras/trace/${encodeURIComponent(subTaskId)}`);
                  }}
                  rootSessionId={taskId}
                  rootExecutionId={rootExecutionId || taskId}
                  traceKey={taskId}
                  anomalies={anomalyMarkers}
                  focusRasMarkerId={selectedMarkerId}
                  reliabilityEvents={reliabilityEvents}
                />
              </div>
            ) : sessionError ? (
              <EmptyState
                title={locale === 'zh' ? '无法加载 Trace' : 'Unable to Load Trace'}
                description={
                  locale === 'zh'
                    ? '该任务尚无平台对话链路（Execution / OTel / Session），请确认观测上报已完成'
                    : 'No platform conversation (Execution / OTel / Session) for this task yet'
                }
              />
            ) : (
              <EmptyState
                title={locale === 'zh' ? '无 Trace 数据' : 'No Trace Data'}
                description={
                  locale === 'zh'
                    ? '该任务无平台对话链路（Execution / OTel / Session）。仅有 RAS 环内事件时不在此展示链路树'
                    : 'No platform conversation (Execution / OTel / Session). RAS-only events are not shown as a trace tree'
                }
              />
            )}
          </div>
        </PageContent>
      </PageContainer>
    </>
  );
}
