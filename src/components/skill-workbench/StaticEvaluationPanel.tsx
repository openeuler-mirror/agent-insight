'use client';

import { AlertTriangle, CheckCircle2, Loader2, Play, ShieldCheck, WandSparkles } from 'lucide-react';

interface StaticIssue {
  id: string;
  severity: string;
  summary: string;
  dimension: string;
  evidence?: string | null;
  reasoning?: string | null;
  suggestedFix: string | null;
}

export interface StaticQualityGate {
  state: 'not_started' | 'running' | 'failed' | 'stale' | 'blocked' | 'passed';
  highIssueCount: number;
  message: string;
}

export interface StaticEvaluationOverview {
  skillName: string;
  version: number;
  contentHash?: string;
  gate: StaticQualityGate;
  evaluation: null | {
    id: string;
    status: string;
    ranAt: string;
    durationMs: number | null;
    errorMessage: string | null;
    scores: {
      scores?: Record<string, number>;
      comments?: Record<string, string>;
    };
    issues: StaticIssue[];
  };
}

export function StaticEvaluationPanel({
  source,
  overview,
  loading,
  running,
  optimizing,
  onRun,
  onOptimize,
}: {
  source: string | null;
  overview: StaticEvaluationOverview | null;
  loading: boolean;
  running: boolean;
  optimizing: boolean;
  onRun: () => void;
  onOptimize: () => void;
}) {
  if (loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载评估结果</div>;
  }

  const evaluation = overview?.evaluation;
  const gate = overview?.gate;
  const scores = evaluation?.scores.scores || {};
  const gateLabel = gate?.state === 'passed' ? '质量门禁通过'
    : gate?.state === 'blocked' ? '质量门禁未通过'
      : gate?.state === 'running' ? '评估中'
        : gate?.state === 'failed' ? '评估失败'
          : gate?.state === 'stale' ? '需要重新评估'
            : '尚未评估';
  const gateTone = gate?.state === 'passed'
    ? 'border-success-border bg-success-subtle text-success'
    : gate?.state === 'blocked' || gate?.state === 'failed'
      ? 'border-error-border bg-error-subtle text-error'
      : 'border-warning-border bg-warning-subtle text-warning';
  const gateRunning = running || gate?.state === 'running';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary-subtle text-primary"><ShieldCheck className="size-4.5" /></span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">静态质量评估</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">结构、描述、流程、安全与工程健壮性 · {source === 'management' ? '正式版本' : '未发布快照'}</p>
          </div>
          <span className="flex-1" />
          <span className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium ${gateTone}`}>
            {gateRunning ? <Loader2 className="size-3.5 animate-spin" />
              : gate?.state === 'passed' ? <CheckCircle2 className="size-3.5" />
                : <AlertTriangle className="size-3.5" />}
            {gateLabel}
          </span>
          <button
            type="button"
            disabled={gateRunning}
            onClick={onRun}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {gateRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {evaluation ? '重新评估' : '开始评估'}
          </button>
          {gate?.message && <p className="w-full text-xs text-foreground-secondary">{gate.message}</p>}
          {gate?.state === 'blocked' && gate.highIssueCount > 0 && (
            <div className="flex w-full flex-wrap items-center gap-3 rounded-md border border-error-border bg-error-subtle px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-error">这些问题可以交给优化 Agent 直接处理</p>
                <p className="mt-0.5 text-[11px] leading-4 text-foreground-secondary">将基于本次评估修改当前工作快照并自动复验；修改结果不会自动发布。</p>
              </div>
              <button
                type="button"
                disabled={optimizing || gateRunning}
                onClick={onOptimize}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {optimizing ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
                {optimizing ? '正在启动修复…' : `AI 修复 ${gate.highIssueCount} 个高风险问题`}
              </button>
            </div>
          )}
        </section>

        {gateRunning && (
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-foreground"><Loader2 className="size-4 animate-spin text-primary" />正在评估当前固定快照</div>
            <div className="grid gap-2 md:grid-cols-4">
              {['读取并校验文件', '检查结构与边界', '检查流程与安全', '汇总证据与建议'].map((step, index) => (
                <div key={step} className="rounded-md bg-background-secondary px-2 py-2 text-[10px] text-foreground-secondary">
                  <span className="mr-1 text-primary">{index + 1}.</span>{step}
                </div>
              ))}
            </div>
          </section>
        )}

        {!evaluation ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-xs text-foreground-muted">
            {gate?.message || (source === 'generated'
              ? '生成质量规则尚未形成可查看结果，请继续完成生成或重试。'
              : '该版本还没有静态评估结果。评估只在你显式启动后运行。')}
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {Object.entries(scores).map(([dimension, score]) => (
                <div key={dimension} className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[11px] text-foreground-muted">{dimension}</div>
                  <div className="mt-1 text-xl font-semibold text-foreground">{score}<span className="ml-1 text-xs font-normal text-foreground-muted">/ 5</span></div>
                </div>
              ))}
              {Object.keys(scores).length === 0 && (
                <div className="col-span-full rounded-lg border border-border bg-card p-4 text-xs text-foreground-muted">
                  本次评估没有完整维度分数。{evaluation.errorMessage || '请查看问题列表。'}
                </div>
              )}
            </section>
            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                {gate?.state === 'passed' ? <CheckCircle2 className="size-4 text-success" /> : <AlertTriangle className="size-4 text-warning" />}
                <h3 className="text-xs font-semibold text-foreground">发现 {evaluation.issues.length} 个问题</h3>
                <span className="ml-auto text-[10px] text-foreground-muted">{new Date(evaluation.ranAt).toLocaleString()}</span>
              </div>
              <div className="divide-y divide-border">
                {evaluation.issues.map((issue) => (
                  <div key={issue.id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">{issue.severity}</span>
                      <span className="text-[10px] text-foreground-muted">{issue.dimension}</span>
                    </div>
                    <p className="mt-1 text-xs font-medium text-foreground">{issue.summary}</p>
                    {issue.suggestedFix && <p className="mt-1 text-xs leading-5 text-foreground-secondary">{issue.suggestedFix}</p>}
                  </div>
                ))}
                {evaluation.issues.length === 0 && <div className="px-4 py-6 text-center text-xs text-foreground-muted">没有发现问题</div>}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
