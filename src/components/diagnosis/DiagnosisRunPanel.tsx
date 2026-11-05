'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DiagnosisTaskSummary, DiagnosisModuleCards, ReportView } from '@/components/observe/AgentDebugCard';
import { preserveDiagnosisProgress } from '@/components/observe/agent-debug-presentation';
import type { DiagnosisProgressSnapshot } from '@/lib/engine/agent-debug/progress-types';
import { DiagnosisOptimizationCard } from './DiagnosisOptimizationCard';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/client/api';
import { safeUUID } from '@/lib/safe-uuid';
import { useLocale } from '@/lib/client/locale-context';
import type { DiagnosisSnapshot } from '@/lib/diagnosis/contracts';
import type { AgentDebugReportPayload } from '@/lib/engine/agent-debug/types';

type Run = { id: string; status: string; errorMessage: string | null; inputHash: string; snapshot: DiagnosisSnapshot; report: AgentDebugReportPayload | null; eligibility: Record<string, string | null>; createdAt: string; progress?: DiagnosisProgressSnapshot | null };
export function DiagnosisRunPanel({ runId, children }: {
  runId: string;
  children: (snapshot: DiagnosisSnapshot, createdAt: string, content: (onNodeRefClick: (nodeId: string) => void) => ReactNode) => ReactNode;
}) {
  const router = useRouter();
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [requestError, setRequestError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await apiFetch(`/api/diagnosis-runs/${encodeURIComponent(runId)}`);
        const data = await response.json();
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            if (!cancelled) setRequestError(data.error || (zh ? '无法读取诊断记录' : 'Diagnosis unavailable'));
            return;
          }
          throw new Error(data.error);
        }
        if (cancelled) return;
        setRun(previous => ({ ...data, progress: preserveDiagnosisProgress(previous?.progress || null, data.progress || null, data.id) })); setRequestError(''); setLastSyncedAt(Date.now());
        if (['pending', 'running'].includes(data.status)) timer = setTimeout(poll, 3000);
      } catch (e) { if (!cancelled) { setRequestError(e instanceof Error ? e.message : 'Failed'); timer = setTimeout(poll, 5000); } }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, zh]);
  async function retryDiagnosis() {
    if (!run || busy || run.snapshot.source === 'trace-report') return;
    setBusy(true); setError('');
    try {
      const url = `/api/experiments/${run.snapshot.experiment.id}/cases/${run.snapshot.case.id}/diagnoses`;
      const resultIds = run.snapshot.results.map(r => r.id);
      const check = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultIds, preview: true }) });
      const preview = await check.json();
      if (!check.ok) throw new Error(preview.error);
      if (preview.inputHash !== run.inputHash) throw new Error(zh ? '输入已变化，请返回评测 Case 重新确认。' : 'Inputs changed. Return to the Case and confirm again.');
      const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultIds, requestKey: safeUUID(), expectedInputHash: preview.inputHash, retryOfRunId: runId, force: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/fault?runId=${encodeURIComponent(data.runId)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  const content = (onNodeRefClick: (nodeId: string) => void) => <div className="mb-6 space-y-4">
    {requestError && <p role="alert" className="text-sm text-error">{requestError}</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    {!run ? (!requestError && <p>{zh ? '正在读取诊断记录…' : 'Loading diagnosis…'}</p>) : <>
      <div className="flex flex-wrap items-center justify-between gap-3">{run.snapshot.source === 'trace-report' ? <Link className="text-primary" href={`/trace?taskId=${encodeURIComponent(run.snapshot.execution.taskId || run.snapshot.execution.id)}`}>{zh ? '来源 Trace 诊断' : 'Source Trace report'}</Link> : <Link className="text-sm text-primary" href={`/experiments/${run.snapshot.experiment.id}/cases/${run.snapshot.case.id}`}>{run.snapshot.experiment.name} → Case</Link>}<span className="text-sm">{run.status}</span></div>
      <section className="rounded-lg border border-border bg-card p-4 text-sm"><h2 className="font-medium">{zh ? '输入来源' : 'Input sources'}</h2><p className="mt-2 break-all">Trace: {run.snapshot.execution.id} · attempt {run.snapshot.attempt?.attemptNo ?? '—'}</p><p>{run.snapshot.results.length} {zh ? '项评测结果 · 输入快照已冻结' : 'evaluation results · immutable snapshot'}</p><details className="mt-2"><summary>{zh ? '查看评测证据' : 'View evaluation evidence'}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify({ case: run.snapshot.case, results: run.snapshot.results }, null, 2)}</pre></details></section>
      <DiagnosisTaskSummary loading={['pending', 'running'].includes(run.status)} status={run.status}
        requestError={!!requestError} error={run.errorMessage || ''} report={run.report}
        startedAt={Date.parse(run.createdAt)} lastSyncedAt={lastSyncedAt} progress={run.progress} zh={zh}
        onRetry={() => { if (!busy) void retryDiagnosis(); }} />
      {run.snapshot.source !== 'trace-report' && run.status === 'done' && (!run.report || run.report.skippedReason) &&
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryDiagnosis()}>{zh ? '重新诊断' : 'Rerun diagnosis'}</Button>}
      <DiagnosisModuleCards loading={['pending', 'running'].includes(run.status)} failed={run.status === 'failed'}
        requestError={!!requestError} report={run.report} progress={run.progress} zh={zh} onNodeRefClick={onNodeRefClick} />
      {run.report && <ReportView report={run.report} zh={zh} traceExplicitErrors={[]} onNodeRefClick={onNodeRefClick}
        onRerun={run.snapshot.source !== 'trace-report' && !busy ? () => void retryDiagnosis() : undefined} />}
      {run.report && <section className="space-y-3"><h2 className="font-medium">{zh ? '选择诊断发现用于 Skill 优化' : 'Select diagnosis findings for Skill optimization'}</h2>{run.report.skippedReason && <p>{run.report.skippedReason}</p>}{!run.report.findings?.length && <p className="text-sm text-foreground-secondary">{zh ? '未形成可转入优化的诊断发现。' : 'No findings available for optimization.'}</p>}{run.report.findings?.map(f => <article key={f.id} className="rounded-lg border border-border bg-card p-4 text-sm"><label className="flex items-start gap-2"><input type="checkbox" disabled={!!run.eligibility[f.id] || !run.snapshot.skills.length || busy} checked={ids.includes(f.id)} onChange={e => setIds(e.target.checked ? [...ids, f.id] : ids.filter(id => id !== f.id))} /><strong>{f.summary}</strong></label><p className="mt-2 whitespace-pre-wrap">{f.evidence}</p><p className="mt-2 text-foreground-secondary">{f.correctionGuidance}</p><p className="mt-2 text-xs">{f.issueRefs.map(ref => { const issue = run.report?.issues.find(i => i.id === ref.issueId); return `${ref.role}: ${issue?.module || 'unknown'} / Trace #${issue?.traceStepIndex ?? '—'}`; }).join(' · ')}</p>{run.eligibility[f.id] && <p className="mt-2 text-warning">{run.eligibility[f.id]}</p>}</article>)}</section>}
      {run.status === 'done' && <DiagnosisOptimizationCard runId={runId} skills={run.snapshot.skills} findingIds={ids} zh={zh} />}
    </>}
  </div>;
  return run ? children(run.snapshot, run.createdAt, content) : content(() => {});
}
