'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import TraceDrawer, { type TraceDrawerExecutionMeta } from '@/components/observe/TraceDrawer';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';

type Execution = TraceDrawerExecutionMeta & { id: string; agentName?: string; subagentName?: string };
type LinkRecord = { role: string; linkMethod: string; linkState: string; priority: number; execution: Execution };
type Iteration = { id: string; iteration: number; score?: number | null; processPassed?: boolean | null; disposition?: string | null; failureClass?: string | null; selectedModel?: string | null; changedFiles?: string[]; summary?: string | null; hypothesis?: string | null };
type Candidate = { id: string; candidateId: string; status: string; selectedModel?: string | null; bestIteration?: number | null; bestScore?: number | null; iterations: Iteration[]; links: LinkRecord[] };
type Run = { id: string; runId: string; state: string; strategy?: string | null; metricName?: string | null; metricDirection?: string | null; selectedCandidateId?: string | null; selectedIteration?: number | null; selectedScore?: number | null; bestScore?: number | null; candidates: Candidate[]; agentSessions: Array<{ id: string; agentSessionId: string; role: string; host: string; taskName?: string | null; nativeSessionId?: string | null; links: LinkRecord[] }>; links: LinkRecord[] };
type GoalDetail = { goalPlusId: string; boundedGoal?: string | null; status: string; phase: string; currentRevision: number; observedAt: string; workItems: Array<Record<string, unknown>>; finalChecks: Array<Record<string, unknown>>; runs: Run[]; links: LinkRecord[]; completeness: { status: string; expectedNativeExecutions: number; linkedNativeExecutions: number; expectedIterations: number; observedIterations: number; semanticCheckpointCaughtUp: boolean; missingCategories: string[]; timingFidelity: string; contentFidelity: string } };

type Tab = 'overview' | 'candidates' | 'trace' | 'quality';

const GOAL_PLUS_REFRESH_MS = 5_000;

function GoalPlusDetailInner() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const params = useParams<{ goalId: string }>();
  const searchParams = useSearchParams();
  const sourceId = searchParams.get('sourceId') || '';
  const [goal, setGoal] = useState<GoalDetail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [drawer, setDrawer] = useState<TraceDrawerExecutionMeta | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !sourceId || !params.goalId) return;
    let cancelled = false;
    let inFlight = false;
    const query = `sourceId=${encodeURIComponent(sourceId)}&user=${encodeURIComponent(user)}`;
    const load = async (silent = false) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await apiFetch(`/api/observe/goal-plus/goals/${encodeURIComponent(params.goalId)}?${query}`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Request failed');
        if (cancelled) return;
        setGoal(body.goal);
        setError('');
      } catch (reason) {
        if (!cancelled && !silent) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        inFlight = false;
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
  }, [params.goalId, sourceId, user]);

  const traceLinks = useMemo(() => {
    if (!goal) return [];
    const all = [...goal.links, ...goal.runs.flatMap(run => [
      ...run.links,
      ...run.candidates.flatMap(candidate => candidate.links),
      ...run.agentSessions.flatMap(session => session.links),
    ])];
    return [...new Map(all.filter(link => link.linkState !== 'superseded').map(link => [`${link.execution.id}:${link.role}`, link])).values()];
  }, [goal]);

  const title = locale === 'zh' ? 'Goal Plus 运行详情' : 'Goal Plus run detail';
  if (error) return <><AppTopBar title={title} showDefaultActions={false} /><div style={{ padding: 30, color: 'var(--color-danger)' }}>{error}</div></>;
  if (!goal) return <><AppTopBar title={title} showDefaultActions={false} /><div style={{ padding: 30, color: 'var(--foreground-muted)' }}>{locale === 'zh' ? '加载中…' : 'Loading…'}</div></>;

  return <>
    <AppTopBar title={title} showDefaultActions={false} />
    <main style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
      <div style={{ marginBottom: 12 }}><Link href="/goal-plus" style={{ fontSize: 11, color: 'var(--foreground-muted)', textDecoration: 'none' }}>← {locale === 'zh' ? '返回总览' : 'Back'}</Link></div>
      <section className="ai-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          <div><h1 style={{ margin: 0, fontSize: 17, color: 'var(--foreground)' }}>{goal.boundedGoal || goal.goalPlusId}</h1><div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground-muted)' }}>{goal.goalPlusId} · r{goal.currentRevision}</div></div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><span className="ai-badge ai-badge-b">{goal.phase}</span><span className="ai-badge ai-badge-gr">{goal.status}</span><span className={`ai-badge ${goal.completeness.status === 'complete' ? 'ai-badge-g' : goal.completeness.status === 'partial' || goal.completeness.status === 'unsupported' ? 'ai-badge-r' : 'ai-badge-b'}`}>{goal.completeness.status}</span></div>
        </div>
      </section>
      <nav className="ai-card" style={{ display: 'flex', padding: 4, gap: 3, marginBottom: 12 }}>
        {(['overview', 'candidates', 'trace', 'quality'] as Tab[]).map(item => <button key={item} className="ai-btn-s" onClick={() => setTab(item)} style={{ borderColor: tab === item ? 'var(--primary)' : 'transparent', color: tab === item ? 'var(--primary)' : 'var(--foreground-secondary)' }}>{({ overview: locale === 'zh' ? '总览' : 'Overview', candidates: locale === 'zh' ? '候选通道' : 'Candidates', trace: locale === 'zh' ? '原生 Trace' : 'Native trace', quality: locale === 'zh' ? '数据质量' : 'Data quality' })[item]}</button>)}
      </nav>
      {tab === 'overview' && <Overview goal={goal} locale={locale} />}
      {tab === 'candidates' && <Candidates runs={goal.runs} locale={locale} />}
      {tab === 'trace' && <NativeTrace links={traceLinks} locale={locale} onOpen={setDrawer} />}
      {tab === 'quality' && <Quality goal={goal} locale={locale} />}
    </main>
    <TraceDrawer open={Boolean(drawer)} execution={drawer} onClose={() => setDrawer(null)} />
  </>;
}

export default function GoalPlusDetailPage() { return <Suspense fallback={null}><GoalPlusDetailInner /></Suspense>; }

function Overview({ goal, locale }: { goal: GoalDetail; locale: string }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 12 }}>
    <div style={{ display: 'grid', gap: 12 }}>
      <section className="ai-card" style={{ padding: 15 }}><h2 style={heading}>{locale === 'zh' ? '工作项 DAG' : 'Work-item DAG'}</h2>{goal.workItems.length ? goal.workItems.map((item, index) => { const id = String(item.workItemId || item.id || `work-${index + 1}`); const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn.join(', ') : '-'; return <div key={id} style={row}><div><strong>{id}</strong><div style={muted}>{String(item.title || item.objective || item.route || '-')}</div></div><div style={{ textAlign: 'right' }}><span className="ai-badge ai-badge-gr">{String(item.status || 'pending')}</span><div style={muted}>{locale === 'zh' ? '依赖' : 'depends on'}: {dependencies}</div></div></div>; }) : <div style={muted}>{locale === 'zh' ? '暂无工作项' : 'No work items'}</div>}</section>
      <section className="ai-card" style={{ padding: 15 }}><h2 style={heading}>{locale === 'zh' ? 'Search 运行' : 'Search runs'}</h2>{goal.runs.length ? goal.runs.map(run => <div key={run.runId} style={row}><div><strong>{run.runId}</strong><div style={muted}>{run.strategy || '-'} · {run.metricName || '-'} {run.metricDirection || ''}</div></div><div style={{ textAlign: 'right' }}><span className="ai-badge ai-badge-gr">{run.state}</span><div style={muted}>best {run.bestScore ?? '-'}</div></div></div>) : <div style={muted}>No search runs</div>}</section>
    </div>
    <section className="ai-card" style={{ padding: 15 }}><h2 style={heading}>{locale === 'zh' ? '关联摘要' : 'Link summary'}</h2><Metric label={locale === 'zh' ? '原生执行' : 'Native executions'} value={`${goal.completeness.linkedNativeExecutions} / ${goal.completeness.expectedNativeExecutions}`} /><Metric label={locale === 'zh' ? '迭代结算' : 'Settled iterations'} value={`${goal.completeness.observedIterations} / ${goal.completeness.expectedIterations}`} /><Metric label={locale === 'zh' ? '工作项' : 'Work items'} value={String(goal.workItems.length)} /><Metric label={locale === 'zh' ? '最终检查' : 'Final checks'} value={String(goal.finalChecks.length)} /></section>
  </div>;
}

function Candidates({ runs, locale }: { runs: Run[]; locale: string }) {
  return <div style={{ display: 'grid', gap: 12 }}>{runs.map(run => <section className="ai-card" key={run.runId} style={{ padding: 15 }}><h2 style={heading}>{run.runId} · {run.state}</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 9 }}>{run.candidates.map(candidate => <article key={candidate.candidateId} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-m)', padding: 12 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{candidate.candidateId}</strong><span className="ai-badge ai-badge-gr">{candidate.status}</span></div><div style={{ ...muted, margin: '5px 0 9px' }}>{candidate.selectedModel || '-'} · best {candidate.bestScore ?? '-'}</div>{candidate.iterations.map(iteration => <div key={iteration.id} style={row}><span>#{iteration.iteration} · {iteration.disposition || (locale === 'zh' ? '未结算' : 'unsettled')}</span><span style={{ fontFamily: 'var(--font-mono)' }}>{iteration.score ?? '-'}</span></div>)}</article>)}</div></section>)}</div>;
}

function NativeTrace({ links, locale, onOpen }: { links: LinkRecord[]; locale: string; onOpen: (execution: Execution) => void }) {
  return <section className="ai-card" style={{ overflow: 'hidden' }}>{links.length ? links.map(link => <button key={`${link.execution.id}:${link.role}`} disabled={!link.execution.taskId} onClick={() => link.execution.taskId && onOpen(link.execution)} style={{ ...row, width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--table-row-border)', cursor: link.execution.taskId ? 'pointer' : 'default', textAlign: 'left', color: 'var(--foreground)', opacity: link.execution.taskId ? 1 : 0.7 }}><div><strong>{link.role}</strong><div style={muted}>{link.execution.agentName || link.execution.subagentName || link.execution.framework || '-'} · {link.execution.taskId || '-'}</div></div><div style={{ textAlign: 'right' }}><span className={`ai-badge ${link.linkState === 'linked' ? 'ai-badge-g' : 'ai-badge-r'}`}>{link.linkState}</span><div style={muted}>{link.linkMethod}</div></div></button>) : <div style={{ padding: 36, textAlign: 'center', ...muted }}>{locale === 'zh' ? '尚未关联到原生 Trace' : 'No native traces linked yet'}</div>}</section>;
}

function Quality({ goal, locale }: { goal: GoalDetail; locale: string }) {
  const quality = goal.completeness;
  return <section className="ai-card" style={{ padding: 15 }}><h2 style={heading}>{locale === 'zh' ? '完整度与保真度' : 'Completeness and fidelity'}</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}><Metric label={locale === 'zh' ? '状态' : 'Status'} value={quality.status} /><Metric label={locale === 'zh' ? '时间保真度' : 'Timing fidelity'} value={quality.timingFidelity} /><Metric label={locale === 'zh' ? '内容保真度' : 'Content fidelity'} value={quality.contentFidelity} /></div><h3 style={{ ...heading, marginTop: 18 }}>{locale === 'zh' ? '缺失项' : 'Missing categories'}</h3>{quality.missingCategories.length ? <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--color-danger)', fontSize: 12 }}>{quality.missingCategories.map(item => <li key={item}>{item}</li>)}</ul> : <div style={{ color: 'var(--color-success)', fontSize: 12 }}>{locale === 'zh' ? '未发现缺失项' : 'No missing categories detected'}</div>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-m)' }}><div style={muted}>{label}</div><div style={{ marginTop: 4, color: 'var(--foreground)', fontSize: 15, fontWeight: 650 }}>{value}</div></div>; }
const heading: React.CSSProperties = { margin: '0 0 12px', fontSize: 13, color: 'var(--foreground)' };
const muted: React.CSSProperties = { fontSize: 10.5, color: 'var(--foreground-muted)', marginTop: 3 };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '9px 0', fontSize: 11.5, borderBottom: '1px solid var(--table-row-border)' };
