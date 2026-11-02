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

import { Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import type { EvaluatorExecutionCapabilities } from '@/lib/evaluators/evaluator-execution-config';
import {
  effectiveAttemptDraft, parseAttemptDraft, restoreEvaluatorDraft,
  type AttemptDraft, type ExecutionDraft,
} from '@/lib/evaluators/evaluator-execution-draft';

const compactInputStyle = { fontSize: 'inherit', lineHeight: 'inherit', padding: '0 8px' };

function Help({ label, children }: { label: string; children: React.ReactNode }) {
  return <Popover><PopoverTrigger asChild><button type="button" aria-label={label}
    className="shrink-0" style={{ color: 'var(--foreground-muted)', verticalAlign: 'middle' }}><Info size={12} /></button></PopoverTrigger>
    <PopoverContent className="text-xs">{children}</PopoverContent></Popover>;
}

function Fields({ value, onChange, name }: { value: AttemptDraft; onChange: (value: AttemptDraft) => void; name: string }) {
  let error = '';
  try { parseAttemptDraft(value); } catch (e) { error = (e as Error).message; }
  return <>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <label className="flex items-center gap-1.5">评估超时
        <Help label={`${name}评估超时说明`}>单次尝试的超时上限；每次重试重新计时，具体作用阶段见评估器说明。</Help>
        <Input type="number" min={30} max={3600} step={1} value={value.attemptTimeoutSeconds}
          className="h-7 w-20 shadow-none" style={compactInputStyle} aria-label={`${name}超时（秒）`} aria-invalid={Boolean(error)}
          onChange={(e) => onChange({ ...value, attemptTimeoutSeconds: e.target.value })} />秒
      </label>
      <label className="flex items-center gap-1.5">重试次数
        <Help label={`${name}重试次数说明`}>失败后最多重试的次数，不包含首次执行；0 表示不重试。</Help>
        <Input type="number" min={0} max={3} step={1} value={value.maxRetries}
          className="h-7 w-14 shadow-none" style={compactInputStyle} aria-label={`${name}重试次数`} aria-invalid={Boolean(error)}
          onChange={(e) => onChange({ ...value, maxRetries: e.target.value })} />次
      </label>
    </div>
    {error && <div role="alert" className="mt-1 text-sm" style={{ color: 'var(--error)' }}>{error}</div>}
  </>;
}

export function EvaluatorExecutionSettings({ cards, capabilities, value, onChange }: {
  cards: EvaluatorCard[]; capabilities: EvaluatorExecutionCapabilities;
  value: ExecutionDraft; onChange: (value: ExecutionDraft) => void;
}) {
  const supported = cards.filter((card) => Object.hasOwn(capabilities, card.id));
  const code = cards.filter((card) => card.evaluatorType === 'Code' && !card.id.startsWith('benchmark:'));
  const benchmark = cards.filter((card) => card.id.startsWith('benchmark:'));
  const overrides = supported.filter((card) => Object.hasOwn(value.overrides, card.id)).length;
  return <section className="mt-5 border-t pt-4 text-sm" style={{ borderColor: 'var(--border)' }} aria-label="评估运行设置">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">评估运行设置</h3>
    </div>
    <p className="mt-1" style={{ color: 'var(--foreground-muted)' }}>仅对本次实验生效。</p>
    {!supported.length ? <p className="mt-2" style={{ color: 'var(--foreground-muted)' }}>
      当前未选择支持运行配置的 LLM 评估器。
    </p> : <>
      <div className="mt-2 space-y-2" role="radiogroup" aria-label="评估运行策略">
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="evaluation-policy" checked={value.mode === 'system'}
          onChange={() => onChange({ ...value, mode: 'system' })} />使用系统默认</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="evaluation-policy" checked={value.mode === 'uniform'}
          onChange={() => onChange({ ...value, mode: 'uniform' })} />统一配置</label>
        {value.mode === 'uniform' && <div className="ml-6"><Fields name="统一配置" value={value.uniform}
          onChange={(uniform) => onChange({ ...value, uniform })} />
          <p className="mt-1" style={{ color: 'var(--foreground-muted)' }}>统一配置适用于未单独配置且支持运行配置的 LLM 评估器。</p></div>}
      </div>
      <details className="mt-3 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
        <summary>评估器单独配置（可选）{overrides > 0 && <span className="ml-3" style={{ color: 'var(--foreground-muted)' }}>已单独配置 {overrides} 个</span>}</summary>
        <div className="mt-1">
          {supported.map((card) => <div key={card.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-1.5 last:border-b-0"
            style={{ borderColor: 'var(--border)' }}>
            <div className="min-w-40 flex-1 break-all text-sm">{card.name}
              {capabilities[card.id].scopeNote && <p className="mt-0.5 max-w-72" style={{ color: 'var(--foreground-muted)' }}>
                {capabilities[card.id].scopeNote}
              </p>}
            </div>
            <div><Fields name={card.name} value={effectiveAttemptDraft(value, card.id, capabilities[card.id])}
              onChange={(config) => onChange({ ...value, overrides: { ...value.overrides, [card.id]: config } })} /></div>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 font-normal" onClick={() => onChange(restoreEvaluatorDraft(value, card.id))}>
              {value.mode === 'uniform' ? '恢复统一配置' : '恢复系统默认'}
            </Button>
          </div>)}
        </div>
      </details>
    </>}
    {code.length > 0 && <p className="mt-2" style={{ color: 'var(--foreground-muted)' }}>
      {code.map((card) => card.name).join('、')}：代码评估器，不调用模型，不支持超时和重试配置。
    </p>}
    {benchmark.length > 0 && <p className="mt-2" style={{ color: 'var(--foreground-muted)' }}>
      {benchmark.map((card) => card.name).join('、')}：独立评测服务，不支持在实验中配置超时和重试。
    </p>}
  </section>;
}
