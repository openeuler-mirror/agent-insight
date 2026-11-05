'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, ChevronDown, Sparkles, Workflow } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { safeUUID } from '@/lib/safe-uuid';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/lib/client/locale-context';
import type { DiagnosisSnapshot } from '@/lib/diagnosis/contracts';
import type { EvalVerdict } from '@/lib/evaluators/eval-output';

export interface DiagnosisResultOption {
  id: string;
  evaluatorId: string;
  name: string;
  status: string;
  verdict: EvalVerdict | null;
  score: number | null;
  summary: string | null;
}

export function defaultDiagnosisResultIds(results: DiagnosisResultOption[]): string[] {
  return results
    .filter((result) => result.status === 'done' && (result.verdict === 'warn' || result.verdict === 'fail'))
    .map((result) => result.id);
}

function runStatus(status: string, zh: boolean): { label: string; className: string } {
  if (status === 'done') return { label: zh ? '已完成' : 'Done', className: 'bg-success-subtle text-success' };
  if (status === 'failed') return { label: zh ? '失败' : 'Failed', className: 'bg-error-subtle text-error' };
  return {
    label: status === 'running' ? (zh ? '诊断中' : 'Running') : (zh ? '等待中' : 'Pending'),
    className: 'bg-warning-subtle text-warning',
  };
}

function formatTime(value: string, zh: boolean): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(zh ? 'zh-CN' : 'en-US', { hour12: false })
    : '';
}

export function CaseDiagnosisInput({
  experimentId,
  caseId,
  results,
  selectedResultIds,
  traceAvailable,
  onBusyChange,
}: {
  experimentId: string;
  caseId: string;
  results: DiagnosisResultOption[];
  selectedResultIds: string[];
  traceAvailable: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [preview, setPreview] = useState<{
    inputHash: string;
    snapshot: DiagnosisSnapshot;
    selectionKey: string;
    requestKey: string;
  } | null>(null);
  const [error, setError] = useState<{ selectionKey: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [runs, setRuns] = useState<Array<{ id: string; status: string; createdAt: string }>>([]);
  const url = `/api/experiments/${encodeURIComponent(experimentId)}/cases/${encodeURIComponent(caseId)}/diagnoses`;
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const selectionKey = JSON.stringify({ url, ids: selectedResultIds, traceAvailable, refresh, results: results.filter(result => selectedResultIds.includes(result.id)) });
  const activePreview = preview?.selectionKey === selectionKey ? preview : null;
  const visibleError = error?.selectionKey === selectionKey ? error.message : '';
  const selectedResults = selectedResultIds
    .map((id) => results.find((result) => result.id === id))
    .filter((result): result is DiagnosisResultOption => Boolean(result));
  const completedCount = results.filter((result) => result.status === 'done').length;

  useEffect(() => {
    let active = true;
    apiFetch(url)
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (active) setRuns(data.runs || []);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [url]);

  useEffect(() => {
    let active = true;
    const { ids, traceAvailable: available } = JSON.parse(selectionKey) as { ids: string[]; traceAvailable: boolean };
    async function loadPreview() {
      setPreview(null);
      setError(null);
      if (!available || !ids.length) { setLoading(false); return; }
      setLoading(true);
      try {
        const response = await apiFetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resultIds: ids, preview: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (active) setPreview({ ...data, selectionKey, requestKey: safeUUID() });
      } catch (caught) {
        if (active) setError({ selectionKey, message: caught instanceof Error ? caught.message : (zh ? '读取失败' : 'Loading failed') });
      } finally { if (active) setLoading(false); }
    }
    void loadPreview();
    return () => { active = false; };
  }, [selectionKey, url, zh]);

  async function submit() {
    if (submitting.current || !activePreview || loading) return;
    submitting.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const response = await apiFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultIds: selectedResultIds, requestKey: activePreview.requestKey, expectedInputHash: activePreview.inputHash }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setPreview(null);
      router.push(`/fault?runId=${encodeURIComponent(data.runId)}`);
    } catch (caught) {
      setError({ selectionKey, message: caught instanceof Error ? caught.message : (zh ? '操作失败' : 'Request failed') });
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  const actionLabel = loading
    ? (zh ? '正在读取诊断输入…' : 'Loading diagnosis input…')
    : (zh ? '刷新诊断输入' : 'Refresh diagnosis input');

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-medium">{zh ? '智能诊断' : 'Diagnosis'}</h3>
            <span className="text-xs text-foreground-muted">
              {zh ? `已选 ${selectedResults.length} 项评测结果` : `${selectedResults.length} results selected`}
            </span>
          </div>
          {selectedResults.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2" aria-live="polite">
              {selectedResults.map((result) => (
                <span key={result.id} className="inline-flex items-center gap-2 rounded-md bg-primary-subtle px-2 py-1 text-xs text-primary">
                  {result.name}
                  <span className="tabular-nums text-foreground-secondary">{result.score ?? '—'}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-foreground-muted">
              {completedCount > 0
                ? (zh ? '从上方评测卡片选择至少一项诊断依据。' : 'Select at least one evaluation result above.')
                : (zh ? '评测完成后，可以选择结果发起诊断。' : 'Diagnosis becomes available after evaluation completes.')}
            </p>
          )}
          <div className={`mt-2 flex items-center gap-2 text-xs ${traceAvailable ? 'text-foreground-secondary' : 'text-error'}`}>
            <Workflow className="size-3.5" aria-hidden="true" />
            <span>{traceAvailable
              ? (zh ? '本次执行 Trace 将自动关联' : 'The evaluated execution Trace will be linked automatically')
              : (zh ? '缺少被测执行 Trace，暂时无法发起诊断' : 'The evaluated execution Trace is missing')}</span>
          </div>
        </div>
        <Button
          size="sm"
          className="w-full shrink-0 lg:w-auto"
          disabled={busy || loading || selectedResults.length === 0 || !traceAvailable}
          onClick={() => setRefresh(value => value + 1)}
        >
          {actionLabel}
          {!busy && <ArrowRight className="size-4" aria-hidden="true" />}
        </Button>
      </div>

      {visibleError && (
        <p role="alert" className="border-t border-error-border bg-error-subtle px-4 py-3 text-xs text-error">
          {visibleError}
        </p>
      )}

        <div className="border-t border-border bg-background-secondary p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-medium">{zh ? '诊断输入' : 'Diagnosis input'}</h4>
              <p className="mt-1 text-xs text-foreground-secondary">
                {zh ? '开始后将创建新的诊断任务；查看已有结果请从历史诊断中选择。' : 'Starting diagnosis creates a new run. Choose a history entry to view an existing result.'}
              </p>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${activePreview && !loading ? 'bg-success-subtle text-success' : 'bg-background text-foreground-muted'}`} role="status">
              {activePreview && !loading && <CheckCircle2 className="size-3.5" aria-hidden="true" />}
              {activePreview && !loading ? (zh ? '输入已就绪' : 'Input ready') : loading ? (zh ? '正在读取输入…' : 'Loading input…') : (zh ? '输入未就绪' : 'Input not ready')}
            </span>
          </div>

          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-md border border-border bg-card p-3">
              <dt className="text-foreground-muted">Trace</dt>
              <dd className="mt-1 break-all font-medium text-foreground">{activePreview?.snapshot.execution.id || '—'}</dd>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <dt className="text-foreground-muted">Attempt</dt>
              <dd className="mt-1 font-medium text-foreground">{activePreview?.snapshot.attempt?.attemptNo ?? '—'}</dd>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <dt className="text-foreground-muted">Skill</dt>
              <dd className="mt-1 break-words font-medium text-foreground">
                {activePreview?.snapshot.skills.map((skill) => `${skill.name}${skill.version === null ? '' : ` v${skill.version}`}`).join('、')
                  || (activePreview ? (zh ? '未记录调用 Skill' : 'No recorded Skill invocation') : '—')}
              </dd>
            </div>
          </dl>

          {activePreview && <details className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-foreground">
              <span>{zh ? '查看任务、输出与评测证据' : 'View task, output, and evaluation evidence'}</span>
              <ChevronDown className="size-4 text-foreground-muted" aria-hidden="true" />
            </summary>
            <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-3">
              <section className="min-w-0 rounded-md border border-border bg-background p-3">
                <h5 className="font-medium text-foreground">{zh ? '任务输入' : 'Task input'}</h5>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground-secondary">
                  {activePreview.snapshot.case.input || '—'}
                </p>
              </section>
              <section className="min-w-0 rounded-md border border-border bg-background p-3">
                <h5 className="font-medium text-foreground">{zh ? '预期输出' : 'Expected output'}</h5>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground-secondary">
                  {activePreview.snapshot.case.referenceOutput || (zh ? '未标注预期输出' : 'No expected output')}
                </p>
              </section>
              <section className="min-w-0 rounded-md border border-border bg-background p-3">
                <h5 className="font-medium text-foreground">{zh ? '实际输出' : 'Actual output'}</h5>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground-secondary">
                  {activePreview.snapshot.case.actualOutput || '—'}
                </p>
              </section>
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <h5 className="font-medium">{zh ? '所选评测依据' : 'Selected evaluation evidence'}</h5>
              <div className="mt-2 space-y-2">
                {activePreview.snapshot.results.map((result) => {
                  const option = results.find((item) => item.id === result.id);
                  return (
                    <div key={result.id} className="flex flex-col gap-1 rounded-md bg-background-secondary px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">{option?.name || result.evaluatorId}</p>
                        <p className="mt-0.5 break-words text-foreground-secondary">{result.summary || (zh ? '无评测摘要' : 'No evaluation summary')}</p>
                      </div>
                      <span className="shrink-0 tabular-nums font-medium text-foreground">{result.humanScore ?? result.score ?? '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </details>}

          <div className="mt-4 flex justify-end">
            <Button size="sm" disabled={busy || loading || !activePreview} onClick={() => void submit()}>
              {busy ? (zh ? '正在创建诊断…' : 'Starting diagnosis…') : (zh ? '开始诊断' : 'Start diagnosis')}
              {!busy && <ArrowRight className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>

      {runs.length > 0 && (
        <details className="border-t border-border px-4 py-3 text-xs">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-foreground-secondary">
            <span>{zh ? `历史诊断 · ${runs.length}` : `Diagnosis history · ${runs.length}`}</span>
            <span className={`rounded-md px-2 py-1 ${runStatus(runs[0].status, zh).className}`}>
              {zh ? '最近一次：' : 'Latest: '}{runStatus(runs[0].status, zh).label}
            </span>
          </summary>
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {runs.map((run) => {
              const status = runStatus(run.status, zh);
              return (
                <Link
                  key={run.id}
                  href={`/fault?runId=${encodeURIComponent(run.id)}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-foreground hover:bg-background-secondary"
                >
                  <span>{zh ? '诊断记录' : 'Diagnosis'} · {formatTime(run.createdAt, zh)}</span>
                  <span className={`rounded-md px-2 py-1 ${status.className}`}>{status.label}</span>
                </Link>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}
