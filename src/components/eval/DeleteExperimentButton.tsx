'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';

type CaseProcessingState = {
  traceStatus?: string | null;
  traceAttemptStatus?: string | null;
  evaluatorIds?: string[];
  results?: Array<{ evaluatorId: string; status: string }>;
};

export function isCompletedExperimentCase(experimentStatus: string, benchmarkRunStatus?: string | null, state?: CaseProcessingState): boolean {
  if (benchmarkRunStatus) {
    return ['evaluated', 'evaluation_failed', 'submission_invalid', 'execution_failed', 'dispatch_failed', 'blocked', 'cancelled'].includes(benchmarkRunStatus);
  }
  if (state) {
    if (['queued', 'dispatching', 'running', 'retry_wait'].includes(state.traceAttemptStatus || '')
      || state.results?.some((row) => ['pending', 'running'].includes(row.status))) return false;
    if (state.traceStatus === 'failed') return true;
    if (state.traceStatus === 'pending') return ['failed', 'cancelled'].includes(experimentStatus);
    if (state.evaluatorIds?.length && state.evaluatorIds.every((id) => state.results?.some(
      (row) => row.evaluatorId === id && ['done', 'failed'].includes(row.status),
    ))) return true;
  }
  return ['done', 'partial', 'failed', 'cancelled'].includes(experimentStatus);
}

export function emptyCaseEvaluationMessage(experimentStatus: string, state: CaseProcessingState): string {
  if (state.traceStatus === 'failed') return '执行失败，未进入评测。请查看上方失败原因后重试。';
  if (['failed', 'cancelled', 'done', 'partial'].includes(experimentStatus)) return '实验已结束，本项未产生评测结果。';
  if (state.traceStatus === 'ready') return '执行已完成，等待评测。';
  if (['dispatching', 'running'].includes(state.traceAttemptStatus || '')) return '正在执行，尚未进入评测。';
  return '等待执行，尚未进入评测。';
}

export function DeleteExperimentButton({ user, experimentId, caseId, completed = false, className = 'text-xs', onDeleted }: {
  user: string; experimentId: string; caseId?: string; completed?: boolean; className?: string; onDeleted: (experimentDeleted: boolean) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <span onClick={(event) => event.stopPropagation()}>
    <button type="button" disabled={busy} className={`${className} text-foreground-muted hover:text-foreground disabled:opacity-50`}
      onClick={async () => {
        if (!window.confirm(caseId
          ? `${completed ? '删除' : '停止并删除'}本次实验中的这个 Case？其他 Case 和源数据集不受影响。`
          : completed
            ? '删除这个实验？源数据集、共享 Trace 和缓存镜像保留。'
            : '停止并删除这个实验及其未结束任务？源数据集、共享 Trace 和缓存镜像保留。')) return;
        setBusy(true); setError('');
        try {
          const target = `/api/experiments/${encodeURIComponent(experimentId)}${caseId ? `/cases/${encodeURIComponent(caseId)}` : ''}`;
          const response = await apiFetch(`${target}?stop=true&user=${encodeURIComponent(user)}`, { method: 'DELETE' });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '删除失败');
          window.dispatchEvent(new Event('experiment-cancellation-updated'));
          await onDeleted(Boolean(result.experimentDeleted));
        } catch (error) { setError(error instanceof Error ? error.message : '删除失败'); }
        finally { setBusy(false); }
      }}>{busy ? '处理中…' : completed ? '删除' : '停止并删除'}</button>
    {error && <span role="alert" className="ml-2 text-xs text-foreground-secondary">{error}</span>}
  </span>;
}

export function PendingExperimentCancellations({ user }: { user: string }) {
  const [rows, setRows] = useState<Array<{ id: string; experimentId: string; caseKey: string; error?: string }>>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await apiFetch(`/api/experiments/cancellations?user=${encodeURIComponent(user)}`);
        if (!response.ok) return;
        const data = await response.json();
        if (!disposed) setRows(data.cancellations || []);
      } catch { /* Keep the last confirmed pending state while offline. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('experiment-cancellation-updated', refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('experiment-cancellation-updated', refresh); };
  }, [user]);
  if (!rows.length) return null;
  const requiresAttention = rows.some((row) => row.error);
  return <details className="my-3 rounded border border-border p-3 text-xs text-foreground-secondary">
    <summary>停止待确认：{rows.length} 项（{requiresAttention ? '存在需要处理的问题，展开查看' : '后台继续确认退出'}）</summary>
    <ul className="mt-2 space-y-1">{rows.map((row) => <li key={row.id}>{row.experimentId}{row.caseKey ? ` / ${row.caseKey}` : ''}：{row.error || '等待执行器确认退出'}</li>)}</ul>
  </details>;
}
