'use client';

import { CheckCircle2, CircleX, Clock3, GitCompareArrows, Loader2, Play, RotateCcw, TestTube2, Upload } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface OptimizationRecordView {
  id: string;
  status: string;
  summary: string;
  baseVersion: number;
  candidateVersionLabel: string;
  candidateContentHash: string | null;
  sourceKind: string;
  sourceExperimentId: string | null;
  hasRetestableSource: boolean;
  createdAt: string;
  publishedVersion: number | null;
  errorMessage: string | null;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  optimizing: { label: '优化中', tone: 'text-primary bg-primary-subtle' },
  pending_retest: { label: '待复测', tone: 'text-warning bg-warning-subtle' },
  retesting: { label: '复测中', tone: 'text-primary bg-primary-subtle' },
  retest_passed: { label: '复测通过', tone: 'text-success bg-success-subtle' },
  retest_failed: { label: '复测未通过', tone: 'text-error bg-error-subtle' },
  retest_cancelled: { label: '复测已取消', tone: 'text-foreground-muted bg-background-secondary' },
  published: { label: '已发布', tone: 'text-success bg-success-subtle' },
  abandoned: { label: '已放弃', tone: 'text-foreground-muted bg-background-secondary' },
  optimization_failed: { label: '优化失败', tone: 'text-error bg-error-subtle' },
  optimization_cancelled: { label: '优化已取消', tone: 'text-foreground-muted bg-background-secondary' },
};

const ABANDONABLE = new Set(['pending_retest', 'retest_passed', 'retest_failed', 'retest_cancelled']);

export function OptimizationRecordsPanel({
  records,
  abandoningId,
  retestingId,
  publishingId,
  onAbandon,
  onRetest,
  onPublish,
  onCreateRetest,
}: {
  records: OptimizationRecordView[];
  abandoningId: string | null;
  retestingId: string | null;
  publishingId: string | null;
  onAbandon: (record: OptimizationRecordView) => void;
  onRetest: (record: OptimizationRecordView) => void;
  onPublish: (record: OptimizationRecordView) => void;
  onCreateRetest: (record: OptimizationRecordView) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-2">
          <GitCompareArrows className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">优化记录</h2>
          <span className="text-xs text-foreground-muted">候选在复测通过并确认发布前不会写入正式版本</span>
        </div>
        <div className="space-y-3">
          {records.map((record) => {
            const status = STATUS_COPY[record.status] || { label: record.status, tone: 'text-foreground-muted bg-background-secondary' };
            return (
              <article key={record.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="flex size-8 items-center justify-center rounded-md bg-primary-subtle text-primary">
                    {record.status === 'published' ? <CheckCircle2 className="size-4" />
                      : record.status.includes('failed') ? <CircleX className="size-4" />
                        : record.status === 'retesting' ? <TestTube2 className="size-4" />
                          : <Clock3 className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{record.candidateVersionLabel}</h3>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', status.tone)}>{status.label}</span>
                      <span className="text-[11px] text-foreground-muted">基于 v{record.baseVersion}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-foreground-secondary">{record.summary || '暂无优化摘要'}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-foreground-muted">
                      <span>依据：{record.sourceKind}</span>
                      <span>快照：{record.candidateContentHash || '计算中'}</span>
                      <span>{new Date(record.createdAt).toLocaleString()}</span>
                      {record.publishedVersion !== null && <span>正式版本：v{record.publishedVersion}</span>}
                    </div>
                    {record.errorMessage && <p className="mt-2 text-xs text-error">{record.errorMessage}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {['pending_retest', 'retest_failed', 'retest_cancelled'].includes(record.status) && (
                      <button
                        type="button"
                        disabled={retestingId !== null || publishingId !== null}
                        onClick={() => record.hasRetestableSource ? onRetest(record) : onCreateRetest(record)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {retestingId === record.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                        {record.hasRetestableSource ? '同配置复测' : '新建复测实验'}
                      </button>
                    )}
                    {record.status === 'retest_passed' && (
                      <button
                        type="button"
                        disabled={publishingId !== null || retestingId !== null}
                        onClick={() => onPublish(record)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {publishingId === record.id ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                        发布新版本
                      </button>
                    )}
                    {ABANDONABLE.has(record.status) && (
                      <button
                        type="button"
                        disabled={abandoningId !== null || retestingId !== null || publishingId !== null}
                        onClick={() => onAbandon(record)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-background-secondary disabled:opacity-50"
                      >
                        {abandoningId === record.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                        放弃候选
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
