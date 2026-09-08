import type { ReactNode } from 'react';

export default function EvaluatorComparisonGroups({ groups, description }: {
  groups: Array<{ key: 'A' | 'B'; selectedCount: number; content: ReactNode }>;
  description?: string;
}) {
  return <section aria-label="评估器对比配置" className="space-y-3">
    <p className="text-sm text-foreground-muted">{description || 'A/B 两组对同一份 Trace 独立评分。每组至少选择一个评估器，两组组合需要不同。'}</p>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {groups.map(group => <section key={group.key} aria-label={`${group.key} 组评估器`} className="min-w-0 rounded-lg border border-border p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">{group.key} 组评估器</h4>
          <span className="text-xs text-foreground-muted">已选 {group.selectedCount} 个</span>
        </div>
        <div className="space-y-3">{group.content}</div>
      </section>)}
    </div>
  </section>;
}
