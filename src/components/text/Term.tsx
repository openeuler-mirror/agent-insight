// docs/design/components.md §E.14.7 — 词典壳。
// 用法：<Term id="p95-latency" /> 自动从 lib/glossary 取条目；
//      <Term id="..." render="badge" /> 控制是否显示文字。
// 找不到 id 时回退到只展示 id 文本，避免页面崩溃。
'use client';

import * as React from 'react';

import { getTermById, type GlossaryEntry } from '@/lib/glossary';
import { TermPopover, type TermPopoverProps } from './TermPopover';

interface TermProps {
  /** glossary 条目 ID。 */
  id: string;
  /** 渲染模式：default = "术语名 + i 角标"；compact = 只显示 i 角标。 */
  render?: 'default' | 'compact';
  /** 覆盖显示名，不传则使用 glossary 中的名称。 */
  label?: React.ReactNode;
  /** 表头最右列等场景，建议传 "end" 避免出界。 */
  align?: TermPopoverProps['align'];
  /** 弹出方向。 */
  side?: TermPopoverProps['side'];
  /** 角标颜色。 */
  badgeTone?: TermPopoverProps['badgeTone'];
  className?: string;
}

export function Term({
  id,
  render = 'default',
  label,
  align,
  side,
  badgeTone,
  className,
}: TermProps) {
  const entry: GlossaryEntry | undefined = getTermById(id);

  if (!entry) {
    // 不抛错，便于词典缺项的渐进式补全（dev 下 warn 一次）。
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[Term] missing glossary entry: ${id}`);
    }
    return <span className={className}>{label ?? id}</span>;
  }

  const display = label ?? entry.name;

  return (
    <TermPopover
      term={entry.name}
      tag={entry.tag}
      body={entry.body}
      formula={entry.formula}
      align={align}
      side={side}
      badgeTone={badgeTone}
      className={className}
    >
      {render === 'compact' ? null : <span>{display}</span>}
    </TermPopover>
  );
}
