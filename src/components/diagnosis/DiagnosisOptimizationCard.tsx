'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, LockKeyhole, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/client/api';
import type { DiagnosisSkill } from '@/lib/diagnosis/contracts';

export function DiagnosisOptimizationCard({ runId, skills, findingIds, zh }: {
  runId: string; skills: DiagnosisSkill[]; findingIds: string[]; zh: boolean;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const target = skills.find(skill => skill.name === name) || (skills.length === 1 ? skills[0] : undefined);
  return <section className="overflow-hidden rounded-lg border border-border bg-card text-sm">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
      <h2 className="flex items-center gap-2 font-medium"><WandSparkles className="size-4 text-foreground-secondary" />{zh ? '生成 Skill 优化计划' : 'Create Skill optimization plan'}</h2>
      <span className="rounded-md bg-background-secondary px-2 py-1 text-xs text-foreground-secondary">{zh ? `已选 ${findingIds.length} 项发现` : `${findingIds.length} findings selected`}</span>
    </header>
    {!skills.length ? <p className="p-5 text-foreground-secondary">{zh ? '本次执行未记录调用 Skill，没有可直接优化的对象。' : 'No Skill invocation was recorded for this execution.'}</p> : <>
      <div className="grid gap-4 px-5 pt-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0"><p className="mb-2 text-xs text-foreground-secondary">{zh ? '目标 Skill' : 'Target Skill'}</p>
          {skills.length === 1 ? <p className="break-all rounded-md border border-border bg-background px-3 py-2.5">{target?.name}</p> : <fieldset disabled={busy}>
            <Select value={target?.name || ''} onChange={setName} aria-label={zh ? '目标 Skill' : 'Target Skill'} className="w-full" options={[{ value: '', label: zh ? '选择本次执行调用的 Skill' : 'Choose an invoked Skill' }, ...skills.map(skill => ({ value: skill.name, label: skill.name }))]} />
          </fieldset>}
        </div>
        <div><p className="mb-2 text-xs text-foreground-secondary">{zh ? '执行版本' : 'Execution version'}</p><div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-border bg-background-secondary px-3 py-2.5">
          <LockKeyhole className="size-4 text-foreground-muted" /><span>{!target ? '—' : target.version == null ? (zh ? '执行版本未记录' : 'Version not recorded') : `v${target.version}`}</span>
          {target?.version != null && <span className="text-xs text-foreground-muted">{zh ? '执行时固定' : 'Fixed at execution'}</span>}
        </div></div>
      </div>
      {target ? <OptimizationForm key={`${runId}:${target.name}`} runId={runId} target={target} findingIds={findingIds} zh={zh} onBusyChange={setBusy} /> : <p className="p-5 text-xs text-foreground-muted">{zh ? '选择 Skill 后查看对应的执行快照。' : 'Select a Skill to inspect its execution snapshot.'}</p>}
    </>}
  </section>;
}

function OptimizationForm({ runId, target, findingIds, zh, onBusyChange }: {
  runId: string; target: DiagnosisSkill; findingIds: string[]; zh: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<Record<string, string> | null>(target.files);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [constraints, setConstraints] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const missing = target.version == null
    ? (zh ? '执行版本未记录，无法确定优化基线。请使用记录了 Skill 版本的新执行进行诊断。' : 'Execution version is missing. Diagnose a new execution that records its Skill version.')
    : !target.contentHash
      ? (zh ? '执行快照缺少内容校验信息，无法可靠核验该历史版本。暂不能生成优化计划。' : 'The execution snapshot has no content hash. Its historical baseline cannot be verified.') : '';

  useEffect(() => {
    if (target.files || target.version == null || !target.contentHash) return;
    let active = true;
    async function load() {
      setLoading(true); setLoadError('');
      try {
        const response = await apiFetch(`/api/skills/by-name/${encodeURIComponent(target.name)}/diagnosis-inputs?version=${target.version}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (data.version !== target.version || data.contentHash !== target.contentHash) throw new Error(zh ? '历史版本内容与执行记录不一致，无法作为优化基线。' : 'Historical content differs from the execution snapshot.');
        if (active) setFiles(data.files);
      } catch (e) { if (active) setLoadError(e instanceof Error ? e.message : (zh ? '快照读取失败' : 'Snapshot unavailable')); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [target.name, target.version, target.contentHash, target.files, retry, zh]);

  const reason = missing || loadError || (loading || !files ? (zh ? '正在读取并核验执行快照…' : 'Loading and verifying the execution snapshot…') : !findingIds.length ? (zh ? '请至少选择一项可优化的发现' : 'Select at least one eligible finding') : !confirmed ? (zh ? '请确认所选问题与此 Skill 相关' : 'Confirm that the findings relate to this Skill') : '');
  async function submit() {
    if (reason || submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const response = await apiFetch(`/api/skills/by-name/${encodeURIComponent(target.name)}/diagnosis-inputs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, findingIds, baseVersion: target.version, expectedContentHash: target.contentHash, skillRelevanceConfirmed: confirmed, constraints }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/skill-workbench?sessionId=${encodeURIComponent(data.sessionId)}`);
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '生成失败' : 'Could not create plan')); }
    finally { submitting.current = false; setBusy(false); onBusyChange(false); }
  }
  return <>
    <div className="space-y-4 p-5">
      {missing && <p className="rounded-md bg-warning-subtle p-3 text-xs text-warning" role="status">{missing}</p>}
      {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-error">{loadError}<Button size="sm" variant="outline" onClick={() => setRetry(n => n + 1)}>{zh ? '重新读取' : 'Retry'}</Button></div>}
      {loading && <p className="text-xs text-foreground-muted" role="status">{zh ? '正在读取并核验执行快照…' : 'Loading and verifying execution snapshot…'}</p>}
      {files && <details className="rounded-md border border-border bg-background">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{zh ? '查看执行快照' : 'View execution snapshot'}{target.version != null ? ` · v${target.version}` : ''}</summary>
        <div className="space-y-2 border-t border-border p-3">{Object.entries(files).map(([file, text]) => <details key={file}>
          <summary className="cursor-pointer break-all text-xs"><FileText className="mr-1 inline size-3.5" />{file}</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background-secondary p-3 text-xs">{text}</pre>
        </details>)}</div>
      </details>}
      <label className="block"><span className="flex justify-between gap-2 text-xs font-medium">{zh ? '修改范围与保留约束' : 'Scope and constraints'}<span className="font-normal text-foreground-muted">{zh ? '选填' : 'Optional'}</span></span>
        <Textarea className="mt-2 min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm" value={constraints} disabled={busy} onChange={e => setConstraints(e.target.value)} maxLength={8000} placeholder={zh ? '例如：补充证据校验，保留现有报告结构和故障规则。' : 'For example: add evidence checks while preserving report structure and fault rules.'} />
      </label>
      <label className="flex items-start gap-2 text-xs text-foreground-secondary"><input type="checkbox" className="mt-0.5 accent-primary" checked={confirmed} disabled={busy || !!missing || !files} onChange={e => setConfirmed(e.target.checked)} />{zh ? '我已确认所选问题可以通过修改此 Skill 解决。' : 'I confirm these findings can be addressed by modifying this Skill.'}</label>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background-secondary px-5 py-4">
      <div className="min-w-0 flex-1"><p className="text-xs">{zh ? `${findingIds.length} 项发现` : `${findingIds.length} findings`}{target.version != null && ` · ${zh ? '基于执行版本' : 'Execution version'} v${target.version}`}</p><p className="mt-1 text-xs text-foreground-muted" aria-live="polite">{reason || (zh ? '生成草案后进入工作台审阅' : 'Review the draft in the workbench')}</p></div>
      <Button size="sm" disabled={busy || !!reason} onClick={() => void submit()}>{busy ? (zh ? '正在生成…' : 'Creating…') : (zh ? '生成优化计划' : 'Create optimization plan')}<ArrowRight className="size-4" /></Button>
    </footer>
  </>;
}
