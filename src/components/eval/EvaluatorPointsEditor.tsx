'use client';

import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';

type Points = NonNullable<EvaluatorCard['pointsDef']>;

export default function EvaluatorPointsEditor({ value, onChange }: { value: Points; onChange: (points: Points) => void }) {
  const patch = (index: number, partial: Partial<Points[number]>) => {
    onChange(value.map((point, i) => i === index ? { ...point, ...partial } : point));
  };

  return (
    <section aria-label="评分点配置" className="mt-4 flex flex-col gap-2">
      <span className="text-xs font-semibold text-foreground">评分点（可选）</span>
      {value.map((point, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            value={point.label}
            maxLength={50}
            onChange={event => patch(index, { label: event.target.value })}
            aria-label={`评分点名称 ${index + 1}`}
            placeholder="评分点名称"
            className="h-8 w-full rounded-lg border border-input-border bg-input px-2.5 text-xs text-foreground sm:w-50 sm:shrink-0"
          />
          <input
            value={point.note ?? ''}
            maxLength={200}
            onChange={event => patch(index, { note: event.target.value })}
            aria-label={`判定说明 ${index + 1}`}
            placeholder="判定说明（可选）"
            className="h-8 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2.5 text-xs text-foreground"
          />
          <button type="button" className="ai-btn-s" style={{ color: 'var(--error)' }} aria-label="删除评分点" onClick={() => onChange(value.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
      <button type="button" className="ai-btn-s self-start" onClick={() => onChange([...value, { label: '', note: '' }])}>＋ 添加评分点</button>
    </section>
  );
}
