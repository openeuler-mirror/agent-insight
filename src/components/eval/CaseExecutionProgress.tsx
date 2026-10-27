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
import { caseExecutionTraceHref, type CaseExecutionProgress as Progress } from '@/lib/engine/experiment/execution-progress';
import { progressDuration } from '@/lib/benchmark/execution-progress';

const STAGES = ['等待调度', 'Agent 执行', '等待 Trace 入库', '执行评测', '结果就绪'];

export function CaseExecutionProgress({ progress, title, refreshingFailed, retrying, evaluatorName, onRefresh }: {
  progress: Progress; title: string; refreshingFailed: boolean; retrying: boolean;
  evaluatorName: (id: string) => string; onRefresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const terminal = ['done', 'failed', 'cancelled'].includes(progress.status);
  useEffect(() => {
    if (terminal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal]);
  const href = retrying ? null : caseExecutionTraceHref(progress);
  const label = retrying ? '正在提交重试' : refreshingFailed ? '状态刷新失败' : progress.label;
  const Icon = terminal ? progress.status === 'done' ? Check : CircleAlert : refreshingFailed ? CircleAlert : LoaderCircle;
  const elapsed = Math.max(0, (progress.finishedAt ? Date.parse(progress.finishedAt) : now) - Date.parse(progress.startedAt));
  const attemptLabel = progress.attemptNo ? `第 ${progress.attemptNo} 次执行` : progress.source === 'existing' ? '已有 Trace' : '当前执行';
  return <Dialog onOpenChange={open => { if (open) onRefresh(); }}>
    <DialogTrigger asChild>
      <button type="button" aria-label={`查看执行进度：${title}`} className="min-w-40 rounded-md text-left text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex items-center gap-2"><Icon aria-hidden className={`size-4 ${!terminal && !refreshingFailed ? 'motion-safe:animate-spin' : ''}`} />{label}<ChevronRight aria-hidden className="size-3" /></span>
        <span className="mt-1 block text-xs text-foreground-muted">{attemptLabel} · {progress.source === 'existing' ? '已关联' : progressDuration(elapsed)}</span>
      </button>
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto">
      <DialogTitle className="pr-6 text-base">执行进度</DialogTitle>
      <DialogDescription className="break-words">{title}</DialogDescription>
      <div className="space-y-2 border-b border-border pb-4 text-sm">
        <div className="flex justify-between gap-2"><span>{attemptLabel}{progress.attemptNo > 1 ? '（重试）' : ''}</span>{progress.source !== 'existing' && <span>{terminal ? '本次耗时' : '本次用时'} {progressDuration(elapsed)}</span>}</div>
        <p>{label}</p>
        <p className="text-xs text-foreground-muted">最近状态更新：{new Date(progress.updatedAt).toLocaleString()}</p>
        {refreshingFailed && <p role="alert" style={{ color: 'var(--warning)' }}>状态刷新失败，保留上次结果并继续刷新。</p>}
        {progress.error && !retrying && <p role="alert" className="break-words" style={{ color: 'var(--error)' }}>{progress.error}</p>}
      </div>
      <ol className="divide-y divide-border">
        {STAGES.map((name, index) => {
          const skipped = progress.source === 'existing' && index < 3;
          const done = index < progress.stage || progress.status === 'done';
          const current = index === progress.stage;
          const StepIcon = skipped ? Minus : done ? Check : current ? terminal || refreshingFailed ? CircleAlert : LoaderCircle : Circle;
          const state = skipped ? '无需执行' : done ? '已完成' : current ? retrying ? '提交重试中' : progress.status === 'failed' ? '失败' : progress.status === 'cancelled' ? '已取消' : progress.status === 'retry_wait' ? '等待重试' : progress.status === 'waiting' ? '等待中' : '进行中' : terminal ? '未执行' : '待开始';
          return <li key={name} className="flex items-start gap-3 py-3 text-sm">
            <StepIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${current && !terminal && !refreshingFailed && !skipped ? 'motion-safe:animate-spin' : ''}`} style={{ color: skipped || index > progress.stage ? 'var(--foreground-muted)' : done ? 'var(--success)' : 'var(--foreground)' }} />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-3"><span>{name}</span><span className="text-xs text-foreground-muted">{state}</span></div>
              {(index === 1 && !skipped || index === 2 && skipped) && (href
                ? <Link href={href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">查看本次主 Agent 链路<ExternalLink aria-label="新标签页打开" className="size-3" /></Link>
                : <p className="mt-1 text-xs text-foreground-muted">{retrying ? '等待新执行确认' : progress.traceId ? '主 Agent 链路上传中' : '等待本次主 Agent 链路关联'}</p>)}
              {index === 3 && progress.stage >= 3 && <details className="mt-2 text-xs text-foreground-secondary">
                <summary className="cursor-pointer">已完成 {progress.evaluators.filter(e => ['done', 'skipped'].includes(e.status)).length}/{progress.evaluators.length} 项</summary>
                <ul className="mt-2 space-y-2">{progress.evaluators.map(e => <li key={e.id} className="break-words">{evaluatorName(e.id)} · {({ done: '已完成', failed: '失败', running: '评测中', pending: '待评测', cancelled: '已取消', skipped: '已跳过' } as Record<string, string>)[e.status] || e.status}{e.error && <p style={{ color: 'var(--error)' }}>{e.error}</p>}</li>)}</ul>
              </details>}
            </div>
          </li>;
        })}
      </ol>
    </DialogContent>
  </Dialog>;
}
