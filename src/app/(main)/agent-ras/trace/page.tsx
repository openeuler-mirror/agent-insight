'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { FaultStatsPanel } from '@/components/agent-ras/FaultStatsPanel';
import { RasTraceList } from '@/components/agent-ras/RasTraceList';
import { Button } from '@/components/ui/button';
import {
  sortRasTracesByTime,
  type RasTraceTimeSortDir,
} from '@/lib/ingest/ras/sort-traces';

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  none: number;
}

interface RasTraceItem {
  taskId: string;
  executionId: string;
  latestTs: string;
  anomalyKind: string;
  severity: string | null;
  summary: string | null;
  eventCount: number;
  traceStatus: 'running' | 'success' | 'failed';
  traceStatusReason: string;
  detectionLevel: 'L1' | 'L2' | 'L3' | null;
  completedAt: string | null;
  framework: string | null;
  agentName: string | null;
  hasFault?: boolean;
  recoveryStarted?: boolean;
  recoveryOutcome?: 'none' | 'success' | 'failed' | 'unknown';
  abortedStream?: boolean;
}

function computeSeverityCounts(traces: RasTraceItem[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  for (const t of traces) {
    const s = t.severity?.toLowerCase();
    if (s === 'critical') counts.critical++;
    else if (s === 'high') counts.high++;
    else if (s === 'medium') counts.medium++;
    else if (s === 'low') counts.low++;
    else counts.none++;
  }
  return counts;
}

function filterBySeverity(traces: RasTraceItem[], severity: string | null): RasTraceItem[] {
  if (!severity) return traces;
  if (severity === 'none') return traces.filter(t => !t.severity);
  return traces.filter(t => t.severity?.toLowerCase() === severity);
}

export default function AgentRasTracePage() {
  const { locale } = useLocale();
  const { user, apiKey } = useAuth();
  const router = useRouter();
  const [allTraces, setAllTraces] = useState<RasTraceItem[]>([]);
  const [severityCounts, setSeverityCounts] = useState<SeverityCounts>({ critical: 0, high: 0, medium: 0, low: 0, none: 0 });
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeverity, setSelectedSeverity] = useState<string | null>(null);
  const [timeSortDir, setTimeSortDir] = useState<RasTraceTimeSortDir>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const loadTraces = useCallback(async () => {
    if (!user) return;
    if (!apiKey) {
      setLoading(false);
      setError(locale === 'zh' ? '当前登录缺少 API Key，请退出后使用邮箱重新登录' : 'This login has no API key. Sign out and log in again with your email.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ summary: '1' });
      const res = await apiFetch(`/api/ingest/ras-events?${qs.toString()}`, {
        headers: { 'x-witty-api-key': apiKey },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      }
      const data = await res.json();
      const traces: RasTraceItem[] = Array.isArray(data.traces) ? data.traces : [];
      setAllTraces(traces);
      setSeverityCounts(computeSeverityCounts(traces));
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [user, apiKey, locale]);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  const handleSeverityClick = (severity: string) => {
    setSelectedSeverity(prev => prev === severity ? null : severity);
    setPage(1);
  };

  const handleDeleteSelected = async (taskIds: string[]) => {
    if (!apiKey || !taskIds.length) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/ingest/ras-events', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-witty-api-key': apiKey,
        },
        body: JSON.stringify({ taskIds }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      }
      const removed = new Set(taskIds);
      setAllTraces(prev => {
        const next = prev.filter(item => !removed.has(item.taskId));
        setSeverityCounts(computeSeverityCounts(next));
        return next;
      });
      setPage(1);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const handleTimeSortToggle = () => {
    setTimeSortDir(prev => (prev === 'desc' ? 'asc' : 'desc'));
    setPage(1);
  };

  const filteredTraces = filterBySeverity(allTraces, selectedSeverity);
  const sortedTraces = sortRasTracesByTime(filteredTraces, timeSortDir);
  const pagedTraces = sortedTraces.slice((page - 1) * pageSize, page * pageSize);

  return (
    <>
      <AppTopBar
        title={locale === 'zh' ? '可靠性观测' : 'Reliability Observing'}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.push('/agent-ras/fault-modes')}
          >
            {locale === 'zh' ? '故障模式' : 'Fault Modes'}
          </Button>
        }
      />
      <PageContainer>
        {error && (
          <div style={{
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--color-error)',
            background: 'var(--color-error-subtle)',
            color: 'var(--color-error)',
            fontSize: 13,
            marginBottom: 12,
          }}>
            {locale === 'zh' ? '操作失败' : 'Operation failed'}: {error}
          </div>
        )}
        <FaultStatsPanel
          total={allTraces.length}
          severityCounts={severityCounts}
          selectedSeverity={selectedSeverity}
          onSeverityClick={handleSeverityClick}
          loading={loading}
        />
        <RasTraceList
          traces={pagedTraces}
          total={filteredTraces.length}
          pageSize={pageSize}
          loading={loading}
          page={page}
          onPageChange={setPage}
          onDeleteSelected={handleDeleteSelected}
          deleting={deleting}
          timeSortDir={timeSortDir}
          onTimeSortToggle={handleTimeSortToggle}
        />
      </PageContainer>
    </>
  );
}
