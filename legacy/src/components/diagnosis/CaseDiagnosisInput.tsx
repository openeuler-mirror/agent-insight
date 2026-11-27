'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Sparkles, Workflow } from 'lucide-react';

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
  revision?: string;
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
  const [retry, setRetry] = useState(0);
  const selectedResults = selectedResultIds
    .map((id) => results.find((result) => result.id === id))
    .filter((result): result is DiagnosisResultOption => Boolean(result));
  const selectionKey = JSON.stringify({
    url,
    traceAvailable,
    retry,
    results: selectedResults
      .map(result => ({ id: result.id, revision: result.revision ?? JSON.stringify(result) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  const activePreview = preview?.selectionKey === selectionKey ? preview : null;
  const visibleError = error?.selectionKey === selectionKey ? error.message : '';
  const preparing = traceAvailable && selectedResults.length > 0 && !activePreview && !visibleError;
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
    const controller = new AbortController();
    const selected = JSON.parse(selectionKey) as { results: Array<{ id: string }> };
    const ids = selected.results.map(result => result.id);
    async function loadPreview() {
      try {
        const response = await apiFetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resultIds: ids, preview: true }),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (active) setPreview({ ...data, selectionKey, requestKey: safeUUID() });
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (active) setError({ selectionKey, message: caught instanceof Error ? caught.message : (zh ? '读取失败' : 'Loading failed') });
      }
    }
    if (!traceAvailable || !ids.length) return () => { active = false; controller.abort(); };
    const timer = window.setTimeout(() => void loadPreview(), 250);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [selectionKey, traceAvailable, url, zh]);

  async function submit() {
    if (submitting.current || !activePreview) return;
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
          <div className={`mt-2 flex items-center gap-2 text-xs ${traceAvailable ? 'text-foreground-secondary' : 'text-error'}`} aria-live="polite">
            {activePreview ? <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" /> : <Workflow className="size-3.5" aria-hidden="true" />}
            <span>{!traceAvailable
              ? (zh ? '缺少被测执行 Trace，暂时无法发起诊断' : 'The evaluated execution Trace is missing')
              : selectedResults.length === 0
                ? (zh ? '选择评测结果后将自动准备诊断输入' : 'Select evaluation results to prepare diagnosis input automatically')
                : preparing
                  ? (zh ? '正在根据所选评测准备诊断输入…' : 'Preparing diagnosis input from the selected results…')
                  : activePreview
                    ? (zh ? '诊断输入已根据当前选择自动更新' : 'Diagnosis input is ready for the current selection')
                    : (zh ? '诊断输入暂未就绪' : 'Diagnosis input is not ready')}</span>
          </div>
        </div>
        <Button
          size="sm"
          className="w-full shrink-0 lg:w-auto"
          disabled={busy || preparing || !activePreview}
          onClick={() => void submit()}
        >
          {busy
            ? (zh ? '正在创建诊断…' : 'Starting diagnosis…')
            : preparing
              ? (zh ? '正在准备…' : 'Preparing…')
              : (zh ? '开始诊断' : 'Start diagnosis')}
          {!busy && !preparing && <ArrowRight className="size-4" aria-hidden="true" />}
        </Button>
      </div>

      {visibleError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-error-border bg-error-subtle px-4 py-3 text-xs text-error">
          <span>{visibleError}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRetry(value => value + 1)}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}

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
