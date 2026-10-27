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

import { evaluatorSkillSourceLabel } from '@/lib/evaluators/evaluator-skills';
import type { CustomEvaluatorRuntime } from '@/lib/engine/evaluation/custom-evaluator-runtime';

export function isCustomEvaluatorRuntime(value: unknown): value is CustomEvaluatorRuntime {
  if (!value || typeof value !== 'object') return false;
  const r = value as CustomEvaluatorRuntime;
  return typeof r.model === 'string' && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
    && (r.error === undefined || typeof r.error === 'string')
    && Array.isArray(r.skills) && r.skills.length <= 8 && r.skills.every(s => s && typeof s.name === 'string'
      && typeof s.snapshotHash === 'string' && s.source && (s.source.kind === 'local'
        || (s.source.kind === 'library' && Number.isInteger(s.source.version))))
    && Array.isArray(r.tools) && r.tools.length <= 64 && r.tools.every(t => t && ['callId', 'name', 'status', 'input', 'output'].every(k => typeof (t as unknown as Record<string, unknown>)[k] === 'string'));
}

export function CustomEvaluatorRuntimeDetails({ runtime }: { runtime: CustomEvaluatorRuntime }) {
  return <details className="my-2 rounded border border-border bg-background-secondary p-3 text-xs">
    <summary className="cursor-pointer font-semibold">评估使用的 Skills · {runtime.skills.length}</summary>
    <div className="mt-3 space-y-2">
      {runtime.skills.map(s => <div key={s.name}><strong>{s.name}</strong><span className="ml-2 text-foreground-muted">{evaluatorSkillSourceLabel(s)} · 已加载</span></div>)}
      <p className="text-foreground-muted">模型：{runtime.model || '未开始模型调用'} · 耗时 {(runtime.durationMs / 1000).toFixed(1)} 秒</p>
      {runtime.error && <p role="alert" className="text-error">{runtime.error}</p>}
      {runtime.tools.length ? runtime.tools.map(t => <details key={t.callId} className="rounded border border-border p-2"><summary className="cursor-pointer">{t.name} · {t.status}</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all">{t.input}{t.output ? `\n${t.output}` : ''}</pre>{t.truncated && <p>工具输入或输出摘要已截断。</p>}</details>) : <p>未记录工具调用。</p>}
      {runtime.toolsTruncated && <p>工具调用较多，仅展示前 64 个调用的摘要。</p>}
    </div>
  </details>;
}
