'use client';

import { CheckCircle2, CircleX, Clock3, GitCompareArrows, Loader2, RotateCcw, Upload, WandSparkles } from 'lucide-react';

import { getOptimizationTargetVersion, getOptimizationTransitionLabel } from '@/lib/skill-workbench/optimization-display';
import { cn } from '@/lib/utils';
import { OptimizationRecordDiff } from './OptimizationRecordDiff';

export interface OptimizationRecordView {
  id: string;
  sessionId: string;
  skillName: string;
  status: string;
  summary: string;
  baseVersion: number;
  candidateVersionLabel: string;
  candidateContentHash: string | null;
  sourceKind: string;
  sourceExperimentId: string | null;
  staticEvaluationId?: string | null;
  retestExperimentId?: string | null;
  diff?: Array<{ path?: string; before?: string | null; after?: string | null; changeType?: string }>;
  sourceRefs?: Array<Record<string, unknown>>;
  candidateFiles?: Record<string, string>;
  blockingIssues?: Array<{
    id: string;
    severity: 'high';
    dimension: string;
    summary: string;
    evidence: string | null;
    reasoning: string | null;
    suggestedFix: string | null;
  }>;
  hasRetestableSource: boolean;
  createdAt: string;
  publishedVersion: number | null;
  errorMessage: string | null;
  sourceSession?: { id: string; title: string } | null;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  optimizing: { label: '优化中', tone: 'text-primary bg-primary-subtle' },
  pending_retest: { label: '质量规则已通过', tone: 'text-success bg-success-subtle' },
  retesting: { label: '质量规则已通过', tone: 'text-success bg-success-subtle' },
  retest_passed: { label: '质量规则已通过', tone: 'text-success bg-success-subtle' },
  retest_failed: { label: '质量规则已通过', tone: 'text-success bg-success-subtle' },
  retest_cancelled: { label: '质量规则已通过', tone: 'text-success bg-success-subtle' },
  published: { label: '已发布', tone: 'text-success bg-success-subtle' },
  abandoned: { label: '已放弃', tone: 'text-foreground-muted bg-background-secondary' },
  optimization_failed: { label: '优化失败', tone: 'text-error bg-error-subtle' },
  optimization_cancelled: { label: '优化已取消', tone: 'text-foreground-muted bg-background-secondary' },
};

const ABANDONABLE = new Set(['pending_retest', 'retest_passed', 'retest_failed', 'retest_cancelled']);

function displayOptimizationError(message: string) {
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i.test(message)) {
    return '模型服务连接失败，当前候选未生成，请稍后重新优化。';
  }
  return message;
}

export function OptimizationRecordsPanel({
  records,
  selectedRecordId,
  abandoningId,
  publishingId,
  onAbandon,
  onPublish,
  onOpenSourceSession,
  onContinue,
  onSelectRecordId,
}: {
  records: OptimizationRecordView[];
  selectedRecordId: string | null;
  abandoningId: string | null;
  publishingId: string | null;
  onAbandon: (record: OptimizationRecordView) => void;
  onPublish: (record: OptimizationRecordView) => void;
  onOpenSourceSession: (record: OptimizationRecordView) => void;
  onContinue: (record: OptimizationRecordView) => void;
  onSelectRecordId: (recordId: string) => void;
}) {
  const selected = records.find((record) => record.id === selectedRecordId) || records[0];
  if (!selected) return null;
  const selectedStatus = STATUS_COPY[selected.status] || { label: selected.status, tone: 'text-foreground-muted bg-background-secondary' };
  const publishable = ['pending_retest', 'retesting', 'retest_passed', 'retest_failed', 'retest_cancelled'].includes(selected.status);
  const executionFailed = selected.status === 'optimization_failed' && !selected.staticEvaluationId;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center gap-2">
          <GitCompareArrows className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">优化记录</h2>
          <span className="text-xs text-foreground-muted">展示顶部所选 Skill 版本的优化尝试；候选确认发布前不会写入正式版本</span>
        </div>
        <div className="grid min-h-[560px] grid-cols-[280px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-r border-border bg-background-secondary p-2">
            <p className="px-2 py-2 text-[10px] font-medium text-foreground-muted">全部记录 · {records.length}</p>
            <div className="space-y-1">
              {records.map((record) => {
            const status = STATUS_COPY[record.status] || { label: record.status, tone: 'text-foreground-muted bg-background-secondary' };
            return (
              <button type="button" key={record.id} onClick={() => onSelectRecordId(record.id)} className={cn('w-full rounded-md border p-3 text-left', selected.id === record.id ? 'border-primary bg-card' : 'border-transparent hover:bg-card')}>
                <div className="flex items-center gap-2"><b className="text-xs text-foreground">{getOptimizationTransitionLabel(record)}</b><span className={cn('ml-auto rounded px-1.5 py-0.5 text-[9px]', status.tone)}>{status.label}</span></div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-foreground-muted">{record.summary || '暂无优化摘要'}</p>
                <span className="mt-2 block text-[9px] text-foreground-muted">{new Date(record.createdAt).toLocaleString()}</span>
              </button>
            );
          })}
            </div>
          </div>
          <article className="min-w-0 p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-primary-subtle text-primary">
                {selected.status === 'published' || publishable ? <CheckCircle2 className="size-4" /> : selected.status.includes('failed') ? <CircleX className="size-4" /> : <Clock3 className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-foreground">优化报告 · {getOptimizationTransitionLabel(selected)}</h3><span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', selectedStatus.tone)}>{selectedStatus.label}</span></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                    {publishable && (
                      <button
                        type="button"
                        disabled={publishingId !== null}
                        onClick={() => onPublish(selected)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {publishingId === selected.id ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                        发布为 {getOptimizationTargetVersion(selected)}
                      </button>
                    )}
                    {selected.status === 'optimization_failed' && <button type="button" onClick={() => onContinue(selected)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-background-secondary"><WandSparkles className="size-3.5" />{executionFailed ? '重新优化' : '修复阻断问题'}</button>}
                    {ABANDONABLE.has(selected.status) && (
                      <button
                        type="button"
                        disabled={abandoningId !== null || publishingId !== null}
                        onClick={() => onAbandon(selected)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-background-secondary disabled:opacity-50"
                      >
                        {abandoningId === selected.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                        放弃候选
                      </button>
                    )}
              </div>
            </div>
            <section className="mt-4 w-full overflow-hidden rounded-md border border-border bg-background">
              <div className="border-b border-border bg-background-secondary px-3 py-1.5 text-[10px] font-medium text-foreground-muted">
                优化摘要
              </div>
              <div
                className="max-h-64 min-h-28 overflow-y-auto whitespace-pre-wrap break-words px-3 py-3 text-xs leading-5 text-foreground-secondary"
                style={{ scrollbarGutter: 'stable' }}
              >
                {selected.summary || '暂无优化摘要'}
              </div>
            </section>
            <div className="grid grid-cols-3 gap-3 py-4">
              <Metric label="基线版本" value={`v${selected.baseVersion}`} />
              <Metric label="候选版本" value={getOptimizationTargetVersion(selected)} />
              <Metric label="质量校验" value={executionFailed ? '未执行' : selected.status === 'optimization_failed' ? '未通过' : selected.staticEvaluationId ? '已通过' : '待完成'} />
            </div>
            <section className="rounded-md border border-border">
              <div className="flex items-center border-b border-border px-3 py-2"><b className="text-xs text-foreground">版本差异</b><span className="ml-auto text-[10px] text-foreground-muted">{selected.diff?.length || 0} 个文件变更</span></div>
              {selected.diff?.length
                ? <OptimizationRecordDiff files={selected.diff} />
                : <p className="py-8 text-center text-xs text-foreground-muted">优化完成后将在这里展示真实文件差异</p>}
            </section>
            {selected.status === 'optimization_failed' && Boolean(selected.blockingIssues?.length) && (
              <section className="mt-3 rounded-md border border-error bg-error-subtle p-3">
                <div className="flex items-center gap-2"><CircleX className="size-4 text-error" /><b className="text-xs text-foreground">仍有 {selected.blockingIssues!.length} 个阻断问题</b></div>
                <div className="mt-2 space-y-2">
                  {selected.blockingIssues!.map((issue) => (
                    <div key={issue.id} className="rounded border border-border bg-card p-2 text-[10px] leading-4 text-foreground-secondary">
                      <b className="text-foreground">{issue.summary}</b>
                      {(issue.evidence || issue.reasoning) && <p className="mt-1">依据：{issue.evidence || issue.reasoning}</p>}
                      {issue.suggestedFix && <p className="mt-1">建议：{issue.suggestedFix}</p>}
                    </div>
                  ))}
                </div>
              </section>
            )}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-foreground-muted"><span>依据：{selected.sourceKind}</span><button type="button" onClick={() => onOpenSourceSession(selected)} className="text-primary hover:underline disabled:text-foreground-muted" disabled={!selected.sourceSession}>来源会话：{selected.sourceSession?.title || selected.sessionId}</button><span>快照：{selected.candidateContentHash || '计算中'}</span>{selected.publishedVersion !== null && <span>正式版本：v{selected.publishedVersion}</span>}</div>
            {selected.errorMessage && <p className="mt-2 text-xs text-error">{displayOptimizationError(selected.errorMessage)}</p>}
          </article>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-background p-3"><span className="text-[10px] text-foreground-muted">{label}</span><b className="mt-1 block text-lg text-foreground">{value}</b></div>;
}
