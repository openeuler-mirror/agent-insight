'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, ChevronDown, FileText, LockKeyhole, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/client/api';
import type { DiagnosisSkill } from '@/lib/diagnosis/contracts';
import type { AgentDebugFinding } from '@/lib/engine/agent-debug/types';

export function DiagnosisOptimizationCard({ runId, skills, findings, eligibility, emptyReason, zh }: {
  runId: string;
  skills: DiagnosisSkill[];
  findings: AgentDebugFinding[];
  eligibility: Record<string, string | null>;
  emptyReason: string | null;
  zh: boolean;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [findingIds, setFindingIds] = useState<string[]>([]);
  const target = skills.find(skill => skill.name === name) || (skills.length === 1 ? skills[0] : undefined);
  const selectableIds = useMemo(() => new Set(findings.filter(finding => !eligibility[finding.id] && skills.length > 0).map(finding => finding.id)), [eligibility, findings, skills.length]);
  useEffect(() => {
    setFindingIds(previous => {
      const next = previous.filter(id => selectableIds.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [selectableIds]);
  return <section className="overflow-hidden rounded-lg border border-border bg-card text-sm">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div><h2 className="flex items-center gap-2 font-medium"><WandSparkles className="size-4 text-foreground-secondary" />{zh ? '生成 Skill 优化计划' : 'Create Skill optimization plan'}</h2><p className="mt-1 text-xs text-foreground-muted">{zh ? '选择诊断发现，确认执行基线后生成优化草案' : 'Select findings and verify the execution baseline before creating a draft'}</p></div>
      {target?.version != null && target.contentHash && <span className="inline-flex items-center gap-1.5 rounded-md bg-success-subtle px-2 py-1 text-xs text-success"><CheckCircle2 className="size-3.5" />{zh ? '基线已就绪' : 'Baseline ready'}</span>}
    </header>
    <div className="space-y-4 bg-background-secondary p-5">
      {skills.length ? <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0"><p className="mb-2 text-xs text-foreground-secondary">{zh ? '目标 Skill' : 'Target Skill'}</p>
          {skills.length === 1 ? <p className="break-all rounded-md border border-border bg-background px-3 py-2.5">{target?.name}</p> : <fieldset disabled={busy}>
            <Select value={target?.name || ''} onChange={setName} aria-label={zh ? '目标 Skill' : 'Target Skill'} className="w-full" options={[{ value: '', label: zh ? '选择本次执行调用的 Skill' : 'Choose an invoked Skill' }, ...skills.map(skill => ({ value: skill.name, label: skill.name }))]} />
          </fieldset>}
        </div>
        <div><p className="mb-2 text-xs text-foreground-secondary">{zh ? '执行版本' : 'Execution version'}</p><div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-border bg-background-secondary px-3 py-2.5">
          <LockKeyhole className="size-4 text-foreground-muted" /><span>{!target ? '—' : target.version == null ? (zh ? '执行版本未记录' : 'Version not recorded') : `v${target.version}`}</span>
          {target?.version != null && <span className="text-xs text-foreground-muted">{zh ? '执行时固定' : 'Fixed at execution'}</span>}
        </div></div>
      </div> : <p className="rounded-md border border-border bg-card p-4 text-foreground-secondary">{zh ? '本次执行未记录调用 Skill，没有可直接优化的对象。' : 'No Skill invocation was recorded for this execution.'}</p>}
      <FindingMultiSelect findings={findings} eligibility={eligibility} selectedIds={findingIds} disabled={busy} hasSkills={skills.length > 0} emptyReason={emptyReason} zh={zh} onChange={setFindingIds} />
      {skills.length && (target ? <OptimizationForm key={`${runId}:${target.name}`} runId={runId} target={target} findingIds={findingIds} zh={zh} onBusyChange={setBusy} /> : <p className="p-5 text-xs text-foreground-muted">{zh ? '选择 Skill 后查看对应的执行快照。' : 'Select a Skill to inspect its execution snapshot.'}</p>)}
    </div>
  </section>;
}

function FindingMultiSelect({ findings, eligibility, selectedIds, disabled, hasSkills, emptyReason, zh, onChange }: {
  findings: AgentDebugFinding[];
  eligibility: Record<string, string | null>;
  selectedIds: string[];
  disabled: boolean;
  hasSkills: boolean;
  emptyReason: string | null;
  zh: boolean;
  onChange: (ids: string[]) => void;
}) {
  const selectable = findings.filter(finding => !eligibility[finding.id] && hasSkills);
  const selected = findings.filter(finding => selectedIds.includes(finding.id));
  const toggle = (id: string, checked: boolean) => onChange(checked ? [...selectedIds, id] : selectedIds.filter(selectedId => selectedId !== id));
  const allSelected = selectable.length > 0 && selectable.every(finding => selectedIds.includes(finding.id));
  const preview = selected.map(finding => finding.summary).join(zh ? '；' : '; ');
  return <div>
    <div className="mb-2 flex items-center justify-between gap-3"><label className="text-xs font-medium">{zh ? '诊断发现' : 'Diagnosis findings'}</label><span className="text-xs text-foreground-muted">{zh ? '用于本次 Skill 优化' : 'Used for this Skill optimization'}</span></div>
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled || !findings.length} className="flex min-h-14 w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left outline-none transition-colors hover:border-primary focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{selected.length ? (zh ? `已选择 ${selected.length} 项诊断发现` : `${selected.length} findings selected`) : (zh ? '请选择诊断发现' : 'Select diagnosis findings')}</span><span className="mt-1 block truncate text-xs text-foreground-muted">{selected.length ? preview : findings.length ? (zh ? `${selectable.length} 项可用于优化` : `${selectable.length} available for optimization`) : (emptyReason || (zh ? '未形成可转入优化的诊断发现' : 'No findings available for optimization'))}</span></span>
          <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary">{selected.length}</span><ChevronDown className="size-4 shrink-0 text-foreground-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-background-secondary px-3 py-2"><span className="text-xs text-foreground-secondary">{zh ? '选择要带入优化计划的发现' : 'Choose findings for the optimization plan'}</span><button type="button" disabled={disabled || !selectable.length} onClick={() => onChange(allSelected ? [] : selectable.map(finding => finding.id))} className="text-xs font-medium text-primary disabled:opacity-50">{allSelected ? (zh ? '清空' : 'Clear') : (zh ? '全选' : 'Select all')}</button></div>
        <fieldset disabled={disabled} className="max-h-80 overflow-y-auto">
          {findings.map(finding => {
            const reason = !hasSkills ? (zh ? '本次执行未记录可优化的 Skill' : 'No optimizable Skill was recorded') : eligibility[finding.id];
            return <label key={finding.id} aria-label={reason ? `${finding.summary}：${reason}` : finding.summary} className="flex items-start gap-2.5 border-b border-border px-3 py-3 last:border-b-0 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 hover:bg-background-secondary">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={!!reason} checked={selectedIds.includes(finding.id)} onChange={event => toggle(finding.id, event.target.checked)} />
              <strong className="min-w-0 flex-1 text-xs font-medium leading-5 text-foreground">{finding.summary}</strong>
            </label>;
          })}
          {!findings.length && <p className="p-4 text-xs text-foreground-muted">{emptyReason || (zh ? '未形成可转入优化的诊断发现。' : 'No findings available for optimization.')}</p>}
        </fieldset>
        <div className="flex items-center justify-between border-t border-border bg-background-secondary px-3 py-2 text-xs text-foreground-muted"><span>{zh ? `已选 ${selected.length} / ${findings.length} 项` : `${selected.length} / ${findings.length} selected`}</span><span>{zh ? '可多选' : 'Multiple selection'}</span></div>
      </PopoverContent>
    </Popover>
  </div>;
}

function OptimizationForm({ runId, target, findingIds, zh, onBusyChange }: {
  runId: string; target: DiagnosisSkill; findingIds: string[]; zh: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<Record<string, string> | null>(target.files);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
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

  const reason = missing || loadError || (loading || !files ? (zh ? '正在读取并核验执行快照…' : 'Loading and verifying the execution snapshot…') : !findingIds.length ? (zh ? '请至少选择一项可优化的发现' : 'Select at least one eligible finding') : '');
  async function submit() {
    if (reason || submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const response = await apiFetch(`/api/skills/by-name/${encodeURIComponent(target.name)}/diagnosis-inputs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, findingIds, baseVersion: target.version, expectedContentHash: target.contentHash, skillRelevanceConfirmed: true, constraints }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/skill-workbench?sessionId=${encodeURIComponent(data.sessionId)}`);
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '生成失败' : 'Could not create plan')); }
    finally { submitting.current = false; setBusy(false); onBusyChange(false); }
  }
  return <>
    <div className="space-y-4">
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
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
    </div>
    <footer className="-mx-5 -mb-5 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-5 py-4">
      <div className="min-w-0 flex-1"><p className="text-xs">{zh ? `${findingIds.length} 项发现` : `${findingIds.length} findings`}{target.version != null && ` · ${zh ? '基于执行版本' : 'Execution version'} v${target.version}`}</p><p className="mt-1 text-xs text-foreground-muted" aria-live="polite">{reason || (zh ? '生成草案后进入工作台审阅' : 'Review the draft in the workbench')}</p></div>
      <Button size="sm" disabled={busy || !!reason} onClick={() => void submit()}>{busy ? (zh ? '正在生成…' : 'Creating…') : (zh ? '生成优化计划' : 'Create optimization plan')}<ArrowRight className="size-4" /></Button>
    </footer>
  </>;
}
