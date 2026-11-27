/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, Circle, CircleAlert, ExternalLink, LoaderCircle, Minus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { benchmarkExecutionProgress, progressDuration, type BenchmarkProgressInput, type ProgressStepState } from '@/lib/benchmark/execution-progress';

const STATE_LABEL: Record<ProgressStepState, string> = {
  done: '已完成', running: '进行中', pending: '待开始', failed: '失败', cancelled: '已取消', skipped: '无需执行', unreached: '未执行',
};

function StepIcon({ state, paused = false }: { state: ProgressStepState; paused?: boolean }) {
  const Icon = state === 'done' ? Check : state === 'running' ? paused ? CircleAlert : LoaderCircle : state === 'failed' ? CircleAlert : ['cancelled', 'skipped', 'unreached'].includes(state) ? Minus : Circle;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${state === 'running' && !paused ? 'motion-safe:animate-spin' : ''}`} />;
}

export function BenchmarkExecutionProgress({ benchmark, caseTitle, refreshFailed }: {
  benchmark: BenchmarkProgressInput & { traceId?: string | null; traceTaskId?: string | null; executionId?: string | null };
  caseTitle: string;
  refreshFailed: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const progress = benchmarkExecutionProgress(benchmark, now);
  useEffect(() => {
    if (!progress.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.active]);
  const paused = refreshFailed || progress.delayed;
  const state: ProgressStepState = progress.failed ? 'failed' : progress.completed ? 'done' : progress.cancelled ? 'cancelled' : progress.active ? 'running' : 'pending';
  const tone = progress.failed ? 'var(--error)' : paused ? 'var(--warning)' : 'var(--foreground)';
  const elapsedText = progress.elapsed === null ? null : `${progress.active ? '总用时' : '总耗时'} ${progressDuration(progress.elapsed)}`;
  const label = refreshFailed ? '状态刷新失败' : progress.delayed ? '进度更新延迟' : progress.label;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" aria-label={`查看执行进度：${caseTitle}`} className="min-w-40 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring" style={{ color: tone }}>
          <span className="flex items-center gap-2"><StepIcon state={state} paused={paused} /><span>{label}</span><ChevronRight aria-hidden="true" className="size-3" /></span>
          {elapsedText && <span className="mt-1 block text-xs text-foreground-muted">{elapsedText}</span>}
          {paused && <span className="mt-1 block text-xs text-foreground-muted">上次状态：{progress.label}</span>}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto">
        <DialogTitle className="pr-6 text-base">执行进度</DialogTitle>
        <DialogDescription className="break-words">{caseTitle}</DialogDescription>
        <div className="space-y-2 border-b border-border pb-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2" style={{ color: tone }}><StepIcon state={state} paused={paused} />{progress.label}</span>
            {elapsedText && <span className="text-foreground-secondary">{elapsedText}</span>}
          </div>
          <p className="text-xs text-foreground-muted">{progress.reportAge === null ? '暂无当前流程的进度上报记录' : `最近收到进度上报：${progressDuration(progress.reportAge)}前`}</p>
          {refreshFailed && <p role="alert" style={{ color: 'var(--warning)' }}>状态刷新失败，当前显示上次结果；正在尝试重新获取。</p>}
          {!refreshFailed && progress.delayed && <p role="status" style={{ color: 'var(--warning)' }}>较长时间未收到新进度，任务可能仍在执行，请留意后续更新。</p>}
          {progress.failureMessage && <p role="alert" className="break-words" style={{ color: 'var(--error)' }}>{progress.failureMessage}</p>}
        </div>
        <ol className="divide-y divide-border">
          {progress.steps.map((step) => (
            <li key={step.title} className="flex items-start gap-3 py-3 text-sm" style={{ color: step.state === 'failed' ? 'var(--error)' : ['pending', 'skipped', 'unreached', 'cancelled'].includes(step.state) ? 'var(--foreground-muted)' : 'var(--foreground)' }}>
              <span className="pt-0.5" style={{ color: step.state === 'done' ? 'var(--success)' : undefined }}><StepIcon state={step.state} paused={paused} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3"><span className="font-medium">{step.title}</span><span className="shrink-0 text-xs text-foreground-muted">{step.state === 'running' && paused ? '待确认' : step.state === 'running' && progress.waiting ? '等待中' : STATE_LABEL[step.state]}</span></div>
                {step.title === 'Agent 执行' && step.state !== 'skipped' && (
                  benchmark.executionId && benchmark.traceId ? <Link
                    href={`/trace?executionId=${encodeURIComponent(benchmark.executionId)}&taskId=${encodeURIComponent(benchmark.traceTaskId || benchmark.traceId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label="查看主 Agent 链路（新标签页打开）"
                  >
                    查看主 Agent 链路<ExternalLink aria-hidden="true" className="size-3" />
                  </Link> : <p className="mt-1 text-xs text-foreground-muted">{benchmark.traceId ? '主 Agent 链路上传中' : '等待本次主 Agent 链路关联'}</p>
                )}
                {step.detail && <p className="mt-1 text-xs text-foreground-secondary">{step.detail}</p>}
                {step.state === 'running' && progress.stageElapsed !== null && <p className="mt-1 text-xs text-foreground-muted">当前阶段已用时 {progressDuration(progress.stageElapsed)}</p>}
              </div>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
