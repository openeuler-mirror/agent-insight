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

import { useState } from 'react';
import { CaseExecutionProgress } from '@/components/eval/CaseExecutionProgress';
import type { SkillRunProgress } from '@/lib/skill-workbench/execution-progress';

export function SkillCaseExecutionProgress({ runs, title, versionLabel, refreshingFailed, retrying, evaluatorName, onRefresh, evaluationTitle }: {
  runs?: SkillRunProgress[]; title: string; versionLabel?: string; refreshingFailed: boolean; retrying: boolean;
  evaluatorName: (id: string) => string; onRefresh: () => void; evaluationTitle?: string;
}) {
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  if (!runs?.length) return <span className="text-xs text-foreground-muted">等待进度数据</span>;
  const active = runs.find(run => !['done', 'failed', 'cancelled'].includes(run.status)) || runs[runs.length - 1];
  const selected = runs.find(run => run.roundIndex === selectedRound) || active;
  return <div className="space-y-1">
    {versionLabel && <p className="text-xs font-medium text-foreground-secondary">{versionLabel}</p>}
    {runs.length > 1 && <select aria-label={`${title}执行轮次`} value={selected.roundIndex} onChange={event => setSelectedRound(Number(event.target.value))} className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground">
      {runs.map(run => <option key={run.runIndex} value={run.roundIndex}>第 {run.roundIndex} 轮</option>)}
    </select>}
    <CaseExecutionProgress progress={selected} title={`${title}${versionLabel ? ` · ${versionLabel}` : ''}${runs.length > 1 ? ` · 第 ${selected.roundIndex} 轮` : ''}`}
      refreshingFailed={refreshingFailed} retrying={retrying} evaluatorName={evaluatorName} onRefresh={onRefresh} evaluationTitle={evaluationTitle} />
  </div>;
}
