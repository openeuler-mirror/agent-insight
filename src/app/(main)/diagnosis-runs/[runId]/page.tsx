'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/client/api';
import { safeUUID } from '@/lib/safe-uuid';
import { useLocale } from '@/lib/client/locale-context';
import type { DiagnosisSnapshot } from '@/lib/diagnosis/contracts';
import type { AgentDebugReportPayload } from '@/lib/engine/agent-debug/types';

type Run = { id: string; status: string; errorMessage: string | null; inputHash: string; snapshot: DiagnosisSnapshot; report: AgentDebugReportPayload | null; eligibility: Record<string, string | null>; progress?: { events: Array<{ seq: number; title: string; summary: string }> } };
export default function DiagnosisRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [verified, setVerified] = useState(false);
  const [constraints, setConstraints] = useState('');
  const [base, setBase] = useState<{ contentHash: string; files: Record<string, string> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setRun(null); setIds([]); setBase(null);
    async function poll() {
      try {
        const response = await apiFetch(`/api/diagnosis-runs/${encodeURIComponent(runId)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (cancelled) return;
        setRun(data); setError('');
        if (['pending', 'running'].includes(data.status)) timer = setTimeout(poll, 3000);
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed'); timer = setTimeout(poll, 5000); } }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId]);
  async function action(kind: 'baseline' | 'import' | 'retry') {
    if (!run) return;
    setBusy(true); setError('');
    try {
      let response: Response;
      if (kind === 'baseline') {
        response = await apiFetch(`/api/skills/by-name/${encodeURIComponent(name)}/diagnosis-inputs?version=${encodeURIComponent(version)}`);
      } else if (kind === 'import') {
        response = await apiFetch(`/api/skills/by-name/${encodeURIComponent(name)}/diagnosis-inputs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, findingIds: ids, baseVersion: Number(version), expectedContentHash: base?.contentHash, skillRelevanceConfirmed: confirmed, baselineVerified: verified, constraints }) });
      } else {
        const url = `/api/experiments/${run.snapshot.experiment.id}/cases/${run.snapshot.case.id}/diagnoses`;
        const resultIds = run.snapshot.results.map(r => r.id);
        const check = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultIds, preview: true }) });
        const preview = await check.json();
        if (!check.ok) throw new Error(preview.error);
        if (preview.inputHash !== run.inputHash) throw new Error(zh ? '输入已变化，请返回评测 Case 重新确认。' : 'Inputs changed. Return to the Case and confirm again.');
        response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultIds, requestKey: safeUUID(), expectedInputHash: preview.inputHash, retryOfRunId: runId, force: true }) });
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (kind === 'baseline') setBase(data);
      else router.push(kind === 'import' ? `/skill-workbench?sessionId=${encodeURIComponent(data.sessionId)}` : `/diagnosis-runs/${data.runId}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  const target = run?.snapshot.skills.find(s => s.name === name);
  return <><AppTopBar title={zh ? '评测智能诊断' : 'Evaluation diagnosis'} /><main className="mx-auto w-full max-w-5xl space-y-4 overflow-y-auto p-6">
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    {!run ? <p>{zh ? '正在读取诊断记录…' : 'Loading diagnosis…'}</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">{run.snapshot.source === 'trace-report' ? <Link className="text-primary" href={`/trace?taskId=${encodeURIComponent(run.snapshot.execution.taskId || run.snapshot.execution.id)}`}>{zh ? '来源 Trace 诊断' : 'Source Trace report'}</Link> : <Link className="text-sm text-primary" href={`/experiments/${run.snapshot.experiment.id}/cases/${run.snapshot.case.id}`}>{run.snapshot.experiment.name} → Case</Link>}<span className="text-sm">{run.status}</span></div>
      <section className="rounded-lg border border-border bg-card p-4 text-sm"><h2 className="font-medium">{zh ? '输入来源' : 'Input sources'}</h2><p className="mt-2 break-all">Trace: {run.snapshot.execution.id} · attempt {run.snapshot.attempt?.attemptNo ?? '—'}</p><p>{run.snapshot.results.length} {zh ? '项评测结果 · 输入快照已冻结' : 'evaluation results · immutable snapshot'}</p><details className="mt-2"><summary>{zh ? '查看评测证据' : 'View evaluation evidence'}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify({ case: run.snapshot.case, results: run.snapshot.results }, null, 2)}</pre></details></section>
      {run.progress?.events?.length ? <details className="text-xs"><summary>{zh ? '诊断过程' : 'Diagnosis progress'}</summary>{run.progress.events.map(e => <p className="mt-2" key={e.seq}>{e.title} · {e.summary}</p>)}</details> : null}
      {run.errorMessage && <p className="text-error">{run.errorMessage}</p>}
      {run.snapshot.source !== 'trace-report' && ['done', 'failed'].includes(run.status) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void action('retry')}>{zh ? '重新诊断' : 'Rerun diagnosis'}</Button>}
      {run.report && <section className="space-y-3"><h2 className="font-medium">{zh ? '诊断发现' : 'Findings'}</h2>{run.report.skippedReason && <p>{run.report.skippedReason}</p>}{!run.report.findings?.length && <p className="text-sm text-foreground-secondary">{zh ? '未形成可转入优化的诊断发现。' : 'No findings available for optimization.'}</p>}{run.report.findings?.map(f => <article key={f.id} className="rounded-lg border border-border bg-card p-4 text-sm"><label className="flex items-start gap-2"><input type="checkbox" disabled={!!run.eligibility[f.id] || !run.snapshot.skills.length || busy} checked={ids.includes(f.id)} onChange={e => setIds(e.target.checked ? [...ids, f.id] : ids.filter(id => id !== f.id))} /><strong>{f.summary}</strong></label><p className="mt-2 whitespace-pre-wrap">{f.evidence}</p><p className="mt-2 text-foreground-secondary">{f.correctionGuidance}</p><p className="mt-2 text-xs">{f.issueRefs.map(ref => { const issue = run.report?.issues.find(i => i.id === ref.issueId); return `${ref.role}: ${issue?.module || 'unknown'} / Trace #${issue?.traceStepIndex ?? '—'}`; }).join(' · ')}</p>{run.eligibility[f.id] && <p className="mt-2 text-warning">{run.eligibility[f.id]}</p>}</article>)}</section>}
      {run.status === 'done' && <section className="space-y-3 rounded-lg border border-border p-4 text-sm"><h2 className="font-medium">{zh ? '用于 Skill 优化' : 'Use for Skill optimization'}</h2>{!run.snapshot.skills.length ? <p>{zh ? '本次 Trace 未记录调用 Skill，没有可直接优化的对象。' : 'No recorded Skill invocation; no direct optimization target.'}</p> : <>
        <label className="block">Skill<select className="ml-2 rounded border border-border bg-card p-2" value={name} onChange={e => { const skill = run.snapshot.skills.find(s => s.name === e.target.value); setName(e.target.value); setVersion(skill?.version == null ? '' : String(skill.version)); setBase(null); setVerified(false); setConfirmed(false); }}><option value="">{zh ? '选择执行中使用的 Skill' : 'Choose an invoked Skill'}</option>{run.snapshot.skills.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
        <label className="block">{zh ? '基线版本' : 'Baseline version'}<input type="number" min="0" className="ml-2 w-24 rounded border border-border bg-card p-2" value={version} readOnly={target?.version != null} onChange={e => { setVersion(e.target.value); setBase(null); setVerified(false); }} /></label>
        <Button size="sm" variant="outline" disabled={busy || !name || version === ''} onClick={() => void action('baseline')}>{zh ? '读取并核验基线' : 'Inspect baseline'}</Button>
        {base && <details open><summary>{zh ? '基线文件' : 'Baseline files'}</summary>{Object.entries(base.files).map(([file, content]) => <details key={file}><summary>{file}</summary><pre className="whitespace-pre-wrap break-words text-xs">{content}</pre></details>)}</details>}
        {target && (target.version === null || !target.contentHash) && <label className="flex items-start gap-2 text-warning"><input type="checkbox" checked={verified} disabled={!base} onChange={e => setVerified(e.target.checked)} />{zh ? '历史版本或快照未记录。我已核验所选文件适用于这些诊断证据（保留人工核验记录）。' : 'Historical version/snapshot missing. I verified this baseline against the evidence.'}</label>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{zh ? '我已确认所选发现可以通过修改此 Skill 解决。' : 'I confirm these findings can be addressed in this Skill.'}</label>
        <label className="block">{zh ? '修改范围与保留约束' : 'Scope and constraints'}<textarea className="mt-1 w-full rounded border border-border bg-card p-2" value={constraints} onChange={e => setConstraints(e.target.value)} maxLength={8000} /></label>
        <Button disabled={busy || !ids.length || !base || !confirmed || ((target?.version === null || !target?.contentHash) && !verified)} onClick={() => void action('import')}>{zh ? '生成优化计划' : 'Create optimization plan'}</Button>
      </>}</section>}
    </>}
  </main></>;
}
