'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';

type Completeness = {
  status: 'collecting' | 'complete' | 'partial' | 'unsupported';
  expectedNativeExecutions: number;
  linkedNativeExecutions: number;
  timingFidelity: string;
  contentFidelity: string;
};

type GoalRow = {
  goalPlusId: string;
  status: string;
  phase: string;
  boundedGoal?: string | null;
  observedAt: string;
  source: { sourceId: string; label?: string | null };
  runs: Array<{ runId: string; state: string; bestScore?: number | null; _count: { candidates: number; agentSessions: number } }>;
  completeness: Completeness;
};

type SourceRow = {
  sourceId: string;
  label?: string | null;
  lastSeenAt: string;
  lastScanCompletedAt?: string | null;
  _count: { goals: number; runs: number; snapshots: number };
};

function badge(status: string) {
  if (status === 'complete' || status === 'promoted') return 'ai-badge-g';
  if (status === 'partial' || status === 'unsupported') return 'ai-badge-r';
  if (status === 'collecting' || status === 'running') return 'ai-badge-b';
  return 'ai-badge-gr';
}

const GOAL_PLUS_REFRESH_MS = 5_000;

export default function GoalPlusPage() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let inFlight = false;
    const suffix = `user=${encodeURIComponent(user)}`;
    const load = async (silent = false) => {
      if (inFlight) return;
      inFlight = true;
      if (!silent) setLoading(true);
      try {
        const [sourceResult, goalResult] = await Promise.all([
          apiFetch(`/api/observe/goal-plus/sources?${suffix}`, { cache: 'no-store' }).then(response => response.json().then(body => ({ response, body }))),
          apiFetch(`/api/observe/goal-plus/goals?${suffix}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`, { cache: 'no-store' }).then(response => response.json().then(body => ({ response, body }))),
        ]);
        if (!sourceResult.response.ok || !goalResult.response.ok) throw new Error(sourceResult.body.error || goalResult.body.error || 'Request failed');
        if (cancelled) return;
        setSources(Array.isArray(sourceResult.body.sources) ? sourceResult.body.sources : []);
        setGoals(Array.isArray(goalResult.body.goals) ? goalResult.body.goals : []);
        setError('');
      } catch (reason) {
        if (!cancelled && !silent) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        inFlight = false;
        if (!cancelled && !silent) setLoading(false);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    void load(false);
    const timer = window.setInterval(refreshWhenVisible, GOAL_PLUS_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [sourceId, user]);

  const totals = useMemo(() => ({
    goals: goals.length,
    active: goals.filter(goal => !['complete', 'blocked', 'abandoned'].includes(goal.status)).length,
    partial: goals.filter(goal => goal.completeness.status === 'partial' || goal.completeness.status === 'unsupported').length,
    links: goals.reduce((sum, goal) => sum + goal.completeness.linkedNativeExecutions, 0),
  }), [goals]);

  return <>
    <AppTopBar title={locale === 'zh' ? 'Goal Plus 观测' : 'Goal Plus Observability'} showDefaultActions={false} />
    <main style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, color: 'var(--foreground)' }}>{locale === 'zh' ? '编排运行总览' : 'Orchestration runs'}</h1>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--foreground-muted)' }}>
            {locale === 'zh' ? '语义状态与原生 Agent Trace 的只读关联视图' : 'A read-only overlay linking semantic state to native agent traces'}
          </p>
        </div>
        <select className="ai-input" value={sourceId} onChange={event => { setLoading(true); setError(''); setSourceId(event.target.value); }} style={{ width: 220, height: 34 }}>
          <option value="">{locale === 'zh' ? '全部数据源' : 'All sources'}</option>
          {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.label || source.sourceId}</option>)}
        </select>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
        {[
          [locale === 'zh' ? 'Goals' : 'Goals', totals.goals],
          [locale === 'zh' ? '进行中' : 'Active', totals.active],
          [locale === 'zh' ? '需关注' : 'Needs attention', totals.partial],
          [locale === 'zh' ? '已关联 Trace' : 'Linked traces', totals.links],
        ].map(([label, value]) => <div className="ai-card" key={String(label)} style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{label}</div>
          <div style={{ fontSize: 24, marginTop: 5, fontWeight: 650, color: 'var(--foreground)' }}>{value}</div>
        </div>)}
      </section>

      <section className="ai-card" style={{ overflow: 'hidden' }}>
        {loading ? <Empty text={locale === 'zh' ? '加载中…' : 'Loading…'} /> : error ? <Empty text={error} danger /> : goals.length === 0 ? (
          <Empty text={locale === 'zh' ? '暂无 Goal Plus 快照。先安装采集器并 attach 一个 .gp 目录。' : 'No Goal Plus snapshots. Install the collector and attach a .gp directory.'} />
        ) : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr style={{ textAlign: 'left', background: 'var(--background-secondary)' }}>
            <Th>{locale === 'zh' ? 'Goal' : 'Goal'}</Th><Th>{locale === 'zh' ? '阶段' : 'Phase'}</Th><Th>{locale === 'zh' ? '运行' : 'Runs'}</Th><Th>{locale === 'zh' ? '完整度' : 'Completeness'}</Th><Th>{locale === 'zh' ? '原生 Trace' : 'Native traces'}</Th><Th>{locale === 'zh' ? '最近观测' : 'Observed'}</Th>
          </tr></thead>
          <tbody>{goals.map(goal => <tr key={`${goal.source.sourceId}:${goal.goalPlusId}`} style={{ borderTop: '1px solid var(--table-row-border)' }}>
            <Td><Link href={`/goal-plus/${encodeURIComponent(goal.goalPlusId)}?sourceId=${encodeURIComponent(goal.source.sourceId)}`} style={{ color: 'var(--foreground)', fontWeight: 600, textDecoration: 'none' }}>
              <div>{goal.boundedGoal || goal.goalPlusId}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--foreground-muted)', marginTop: 3 }}>{goal.source.label || goal.source.sourceId} · {goal.goalPlusId}</div>
            </Link></Td>
            <Td><span className={`ai-badge ${badge(goal.status)}`}>{goal.phase} · {goal.status}</span></Td>
            <Td>{goal.runs.length}<span style={{ color: 'var(--foreground-muted)' }}> / {goal.runs.reduce((sum, run) => sum + run._count.candidates, 0)} candidates</span></Td>
            <Td><span className={`ai-badge ${badge(goal.completeness.status)}`}>{goal.completeness.status}</span></Td>
            <Td>{goal.completeness.linkedNativeExecutions} / {goal.completeness.expectedNativeExecutions}</Td>
            <Td style={{ color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>{new Date(goal.observedAt).toLocaleString()}</Td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </main>
  </>;
}

function Empty({ text, danger = false }: { text: string; danger?: boolean }) {
  return <div style={{ padding: 44, textAlign: 'center', fontSize: 12, color: danger ? 'var(--color-danger)' : 'var(--foreground-muted)' }}>{text}</div>;
}
function Th({ children }: { children: React.ReactNode }) { return <th style={{ padding: '10px 12px', color: 'var(--foreground-muted)', fontWeight: 600 }}>{children}</th>; }
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { return <td style={{ padding: '12px', verticalAlign: 'top', color: 'var(--foreground-secondary)', ...style }}>{children}</td>; }
