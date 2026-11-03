'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { safeUUID } from '@/lib/safe-uuid';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/lib/client/locale-context';
import type { DiagnosisSnapshot } from '@/lib/diagnosis/contracts';

export function CaseDiagnosisInput({ experimentId, caseId, results }: { experimentId: string; caseId: string; results: Array<{ id: string; evaluatorId: string; status: string; score: number | null; summary: string | null }> }) {
  const router = useRouter();
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ inputHash: string; snapshot: DiagnosisSnapshot } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState('');
  const [runs, setRuns] = useState<Array<{ id: string; status: string }>>([]);
  const url = `/api/experiments/${encodeURIComponent(experimentId)}/cases/${encodeURIComponent(caseId)}/diagnoses`;
  useEffect(() => {
    let active = true;
    setSelected([]); setPreview(null); setError(''); setRuns([]);
    apiFetch(url).then(async r => { if (!r.ok) return; const data = await r.json(); if (active) setRuns(data.runs || []); }).catch(() => {});
    return () => { active = false; };
  }, [url]);
  async function submit(confirm: boolean) {
    setBusy(true); setError('');
    try {
      const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirm ? { resultIds: selected, requestKey, expectedInputHash: preview?.inputHash } : { resultIds: selected, preview: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (confirm) router.push(`/diagnosis-runs/${encodeURIComponent(data.runId)}`);
      else { setPreview(data); setRequestKey(safeUUID()); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return <section className="mb-4 rounded-lg border border-border bg-card p-4">
    <h3 className="text-sm font-medium">{zh ? '将评测结果用于智能诊断' : 'Diagnose evaluation results'}</h3>
    <p className="mt-1 text-xs text-foreground-secondary">{zh ? '选择评测依据，确认后结合被测执行的 Trace 分析原因。' : 'Select evaluation evidence, then confirm the execution context.'}</p>
    <div className="my-3 space-y-2">{results.filter(r => r.status === 'done').map(r => <label key={r.id} className="flex items-start gap-2 text-xs">
      <input type="checkbox" disabled={busy} checked={selected.includes(r.id)} onChange={e => { setSelected(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id)); setPreview(null); }} />
      <span>{r.evaluatorId} · {r.score ?? '—'}<span className="ml-2 text-foreground-secondary">{r.summary}</span></span>
    </label>)}</div>
    <Button size="sm" variant="outline" disabled={busy || !selected.length} onClick={() => void submit(false)}>{zh ? '用于智能诊断' : 'Use for diagnosis'}</Button>
    {preview && <div className="mt-4 space-y-3 rounded-md bg-background-secondary p-3 text-xs">
      <h4 className="font-medium">{zh ? '确认诊断输入快照' : 'Confirm diagnosis input snapshot'}</h4>
      <p>{preview.snapshot.results.length} {zh ? '项评测结果' : 'results'} · Trace {preview.snapshot.execution.id} · attempt {preview.snapshot.attempt?.attemptNo ?? '—'}</p>
      <p>Skill: {preview.snapshot.skills.map(s => `${s.name} / ${s.version === null ? (zh ? '版本未知' : 'unknown version') : `v${s.version}`}`).join(', ') || (zh ? '未记录调用 Skill' : 'No recorded Skill invocation')}</p>
      <details><summary>{zh ? '查看任务、结果与证据' : 'View task, results and evidence'}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify({ case: preview.snapshot.case, results: preview.snapshot.results }, null, 2)}</pre></details>
      <Button size="sm" disabled={busy} onClick={() => void submit(true)}>{zh ? '确认并开始诊断' : 'Confirm and start diagnosis'}</Button>
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-error">{error}</p>}
    {!!runs.length && <div className="mt-3 flex flex-wrap gap-3 text-xs">{runs.map(run => <Link className="text-primary" key={run.id} href={`/diagnosis-runs/${run.id}`}>{zh ? '历史诊断' : 'Diagnosis'} · {run.status}</Link>)}</div>}
  </section>;
}
