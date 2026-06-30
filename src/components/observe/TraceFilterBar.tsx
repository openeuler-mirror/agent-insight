'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X, ChevronLeft } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/client/api';
import { TRACE_FILTER_COLUMNS } from '@/lib/filters/trace-columns';
import { operatorsForColumn, type FilterClause, type FilterColumn, type Operator } from '@/lib/filters/types';

/**
 * 链路追踪结构化过滤栏(click 驱动,对标 langfuse 搜索栏的下拉选择体验):
 * 点「+ 过滤」→ 选字段(FIELDS,来自列注册表)→ 选操作符 / 值(枚举走 facet 件数下拉,
 * 文本/数值走输入框)→ 确定成 chip。chip 集合 = FilterClause[],上抛由父组件序列化进 URL/后端。
 *
 * v1 只覆盖可下推的实列(排除 computed 的 status/ownership、executionSkill 的 skill——它们仍走既有下拉);
 * 自由文本(query/finalResult)由顶部搜索框承担,这里聚焦结构化字段。
 */

const BAR_COLUMNS: FilterColumn[] = TRACE_FILTER_COLUMNS.filter(
  (c) =>
    c.source !== 'computed' &&
    c.source !== 'executionSkill' &&
    c.column !== 'query' &&
    c.column !== 'finalResult',
);

// 这些列在后端有 facet 值+件数端点(facet=values&column=)。
const FACETED = new Set(['framework', 'subagentType']);

function defaultOperator(col: FilterColumn): Operator {
  switch (col.type) {
    case 'string':
      return 'contains';
    case 'number':
      return '>';
    case 'datetime':
      return '>=';
    case 'stringOptions':
    case 'arrayOptions':
      return 'any of';
    case 'boolean':
      return '=';
  }
}

function opLabel(op: Operator): string {
  const map: Record<string, string> = {
    '=': '=',
    contains: '包含',
    'does not contain': '不包含',
    'starts with': '前缀',
    'ends with': '后缀',
    '>': '>',
    '<': '<',
    '>=': '≥',
    '<=': '≤',
    'any of': '任一',
    'none of': '非',
    'all of': '全部',
    'is null': '为空',
    'is not null': '非空',
  };
  return map[op] ?? op;
}

function clauseLabel(clause: FilterClause): string {
  const col = BAR_COLUMNS.find((c) => c.column === clause.column);
  const name = col?.label ?? clause.column;
  if (clause.operator === 'is null' || clause.operator === 'is not null') {
    return `${name} ${opLabel(clause.operator)}`;
  }
  const v = Array.isArray(clause.value) ? clause.value.join(' / ') : String(clause.value ?? '');
  return `${name} ${opLabel(clause.operator)} ${v}`;
}

interface Props {
  clauses: FilterClause[];
  onChange: (clauses: FilterClause[]) => void;
  user: string;
}

export default function TraceFilterBar({ clauses, onChange, user }: Props) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'field' | 'value'>('field');
  const [col, setCol] = useState<FilterColumn | null>(null);
  const [op, setOp] = useState<Operator>('contains');
  const [text, setText] = useState(''); // field 阶段=过滤字段名;value 阶段=输入值
  const [picked, setPicked] = useState<Set<string>>(new Set()); // 多选(any of)选中的值
  const [facet, setFacet] = useState<{ value: string; count: number }[]>([]);

  const reset = useCallback(() => {
    setStage('field');
    setCol(null);
    setText('');
    setPicked(new Set());
    setFacet([]);
  }, []);

  const fieldMatches = useMemo(() => {
    const q = text.trim().toLowerCase();
    return BAR_COLUMNS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.column.toLowerCase().includes(q));
  }, [text]);

  // 进入 value 阶段且字段有 facet 时,拉「值 + 件数」。
  useEffect(() => {
    if (stage !== 'value' || !col || !FACETED.has(col.column)) return;
    let alive = true;
    apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=${encodeURIComponent(col.column)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (alive) setFacet(Array.isArray(rows) ? rows : []);
      })
      .catch(() => alive && setFacet([]));
    return () => {
      alive = false;
    };
  }, [stage, col, user]);

  const pickField = (c: FilterColumn) => {
    setCol(c);
    setOp(defaultOperator(c));
    setText('');
    setPicked(new Set());
    setStage('value');
  };

  const addClause = (clause: FilterClause) => {
    onChange([...clauses, clause]);
    reset();
    setOpen(false);
  };

  const commitValueStage = () => {
    if (!col) return;
    if (op === 'is null' || op === 'is not null') {
      addClause({ column: col.column, operator: op });
      return;
    }
    if (col.type === 'boolean') return; // boolean 用按钮直接提交
    if (col.type === 'stringOptions') {
      if (picked.size === 0) return;
      addClause({ column: col.column, operator: op, value: Array.from(picked) });
      return;
    }
    const v = text.trim();
    if (!v) return;
    addClause({ column: col.column, operator: op, value: v });
  };

  const removeClause = (i: number) => onChange(clauses.filter((_, idx) => idx !== i));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {clauses.map((c, i) => (
        <Badge key={i} variant="secondary" className="gap-1 pl-2 pr-1 py-1 text-xs font-normal">
          {clauseLabel(c)}
          <button
            type="button"
            onClick={() => removeClause(i)}
            className="rounded-sm hover:bg-background-secondary p-0.5"
            aria-label="移除过滤"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}

      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <PopoverAnchor asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setOpen(true)}>
            <Plus className="size-3" />
            过滤
          </Button>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-72 p-0">
          {stage === 'field' ? (
            <div>
              <div className="p-2 border-b border-border">
                <Input
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="选择字段…"
                  className="h-8 text-sm"
                />
              </div>
              <ul className="max-h-64 overflow-auto py-1">
                {fieldMatches.map((c) => (
                  <li key={c.column}>
                    <button
                      type="button"
                      onClick={() => pickField(c)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-background-secondary text-left"
                    >
                      <span>{c.label}</span>
                      <span className="text-xs text-foreground-muted">{c.column}</span>
                    </button>
                  </li>
                ))}
                {fieldMatches.length === 0 && (
                  <li className="px-3 py-2 text-xs text-foreground-muted">无匹配字段</li>
                )}
              </ul>
            </div>
          ) : (
            col && (
              <div>
                <div className="flex items-center gap-1 p-2 border-b border-border">
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-sm hover:bg-background-secondary p-1"
                    aria-label="返回字段"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="text-sm font-medium">{col.label}</span>
                  <select
                    value={op}
                    onChange={(e) => setOp(e.target.value as Operator)}
                    className="ml-auto h-7 rounded-md border border-border bg-background text-xs px-1"
                  >
                    {operatorsForColumn(col).map((o) => (
                      <option key={o} value={o}>
                        {opLabel(o)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-2">
                  {op === 'is null' || op === 'is not null' ? (
                    <Button size="sm" className="w-full h-8 text-xs" onClick={commitValueStage}>
                      添加
                    </Button>
                  ) : col.type === 'boolean' ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-8 text-xs"
                        onClick={() => addClause({ column: col.column, operator: '=', value: true })}
                      >
                        是 / true
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-8 text-xs"
                        onClick={() => addClause({ column: col.column, operator: '=', value: false })}
                      >
                        否 / false
                      </Button>
                    </div>
                  ) : col.type === 'stringOptions' ? (
                    <FacetValuePicker
                      facet={facet}
                      picked={picked}
                      onToggle={(v) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(v)) next.delete(v);
                          else next.add(v);
                          return next;
                        })
                      }
                      onConfirm={commitValueStage}
                    />
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        autoFocus
                        type={col.type === 'number' ? 'number' : col.type === 'datetime' ? 'datetime-local' : 'text'}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && commitValueStage()}
                        placeholder={col.unit ? `值（${col.unit}）` : '值…'}
                        className="h-8 text-sm"
                      />
                      <Button size="sm" className="h-8 text-xs shrink-0" onClick={commitValueStage}>
                        添加
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FacetValuePicker({
  facet,
  picked,
  onToggle,
  onConfirm,
}: {
  facet: { value: string; count: number }[];
  picked: Set<string>;
  onToggle: (v: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div>
      <ul className="max-h-56 overflow-auto -mx-2">
        {facet.map((f) => (
          <li key={f.value}>
            <button
              type="button"
              onClick={() => onToggle(f.value)}
              className="flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-background-secondary text-left"
            >
              <span className="flex items-center gap-2">
                <input type="checkbox" readOnly checked={picked.has(f.value)} className="pointer-events-none" />
                {f.value}
              </span>
              <span className="text-xs text-foreground-muted tabular-nums">{f.count}</span>
            </button>
          </li>
        ))}
        {facet.length === 0 && <li className="px-3 py-2 text-xs text-foreground-muted">无可选值</li>}
      </ul>
      <Button size="sm" className="w-full h-8 text-xs mt-2" disabled={picked.size === 0} onClick={onConfirm}>
        添加（{picked.size}）
      </Button>
    </div>
  );
}
