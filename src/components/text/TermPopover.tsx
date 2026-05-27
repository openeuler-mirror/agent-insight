// docs/design/components.md §E.14 — 术语提示组件。
// 用于 KPI 卡指标名 / 表头列名 / 卡片标题领域术语 / 长文本叙述首次出现的术语。
// 不允许在列表行、按钮文案、Toast、Dialog Title 内出现。
//
// 触发：hover 即显示（150ms 延迟）+ keyboard focus，与原生 Tooltip 一致；
// 内部支持可交互元素（related 跳转）— Tooltip 默认 hoverable content。
'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

export type TermTag = 'metric' | 'trace' | 'tool' | 'skill' | 'fault' | 'eval';

// 6 类语义 tag → Token 映射（components.md §E.14.4）。
// 95% 灰阶 + 2 个状态 + skill 单独保留 purple token（已对齐 foundations.md §B.5）。
const TAG_STYLES: Record<TermTag, { label: string; cls: string }> = {
  metric: { label: '指标', cls: 'bg-background-secondary text-foreground-muted' },
  trace: { label: '链路', cls: 'bg-background-secondary text-foreground-muted' },
  tool: { label: '工具', cls: 'bg-background-secondary text-foreground-muted' },
  skill: { label: 'Skill', cls: 'bg-[var(--tag-purple-bg)] text-[var(--tag-purple-fg)]' },
  fault: { label: '故障', cls: 'bg-error-subtle text-error border border-error-border' },
  eval: { label: '评测', cls: 'bg-success-subtle text-success border border-success-border' },
};

export interface TermPopoverProps {
  /** 术语显示名，渲染在角标左侧（可被 children 覆盖）。 */
  term: string;
  /** 语义类别，决定 tag 样式。 */
  tag?: TermTag;
  /** 正文解释。1-3 句即可，长度过大请改放到 references。 */
  body: React.ReactNode;
  /** 可选：公式 / 计算口径。等宽渲染。 */
  formula?: string;
  /** 可选：相关术语 ID 列表，作为底部跳转。 */
  related?: { id: string; name: string; onClick?: () => void }[];
  /** 覆盖默认的 term 文本渲染。 */
  children?: React.ReactNode;
  /** 控制 popover 对齐方向（表头最右列建议传 "end"）。 */
  align?: 'start' | 'center' | 'end';
  /** 控制 popover 显示位置。默认 bottom。 */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 角标颜色，默认 muted。 */
  badgeTone?: 'muted' | 'primary';
  className?: string;
}

export function TermPopover({
  term,
  tag,
  body,
  formula,
  related,
  children,
  align = 'start',
  side = 'bottom',
  badgeTone = 'muted',
  className,
}: TermPopoverProps) {
  const tagStyle = tag ? TAG_STYLES[tag] : null;

  return (
    <TooltipPrimitive.Provider delayDuration={150} skipDelayDuration={50}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span
            className={cn(
              'inline-flex items-center gap-1 cursor-help select-none align-baseline',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
              className,
            )}
            tabIndex={0}
            aria-label={`${term} 术语解释`}
          >
            {children ?? <span>{term}</span>}
            <Info
              className={cn(
                'size-3 shrink-0 opacity-70',
                badgeTone === 'primary' ? 'text-primary' : 'text-foreground-muted',
              )}
              aria-hidden
            />
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            align={align}
            side={side}
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              'z-50 w-[260px] space-y-3 rounded-md border border-card-border bg-card p-4 text-card-foreground shadow-sm outline-none',
              'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95',
              'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
              'data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2',
            )}
          >
            <header className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{term}</span>
              {tagStyle && (
                <span
                  className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] leading-none',
                    tagStyle.cls,
                  )}
                >
                  {tagStyle.label}
                </span>
              )}
            </header>

            <div className="text-xs leading-[18px] text-foreground-secondary">
              {body}
            </div>

            {formula && (
              <div className="border-t border-card-border pt-2 font-mono text-[11px] leading-4 tabular-nums text-foreground-muted">
                {formula}
              </div>
            )}

            {related && related.length > 0 && (
              <footer className="border-t border-card-border pt-2 flex flex-wrap gap-1.5">
                {related.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={r.onClick}
                    className="text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {r.name}
                  </button>
                ))}
              </footer>
            )}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
