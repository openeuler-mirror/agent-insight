'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronLeft, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { TRACE_FILTER_COLUMNS, resolveTraceColumn } from '@/lib/filters/trace-columns';
import { operatorsForColumn, type FilterClause, type FilterColumn, type Operator } from '@/lib/filters/types';

/**
 * 链路追踪统一搜索/过滤栏(对标 langfuse 的 SearchComposer):**一个**输入栏里同时承载
 *   ① 已添加的结构化过滤 chip(FilterClause[])
 *   ② 一个内联的自由文本输入(对 trace input/output 做 contains 模糊,debounce 下推 `q`)
 * 点/聚焦输入 → 直接弹出字段下拉(FIELDS,来自列注册表)→ 选字段 → 选操作符/值(枚举走
 * facet 件数下拉,文本/数值走输入框)→ 确定成 chip。chip / 自由文本分别上抛,父组件序列化进 URL/后端。
 *
 * 自由文本与结构化字段共用一个输入:打字即模糊搜索 + 同步过滤字段下拉;一旦从下拉里**选了字段**,
 * 视为要加结构化过滤 → 清空输入(连带清掉这段临时自由文本),进入值录入。
 *
 * v1 只覆盖可下推的实列(排除 computed 的 status/ownership、executionSkill 的 skill——它们仍走既有下拉)。
 */

const BAR_COLUMNS: FilterColumn[] = TRACE_FILTER_COLUMNS.filter(
  (c) =>
    c.source !== 'computed' &&
    c.source !== 'executionSkill' &&
    c.column !== 'query' &&
    c.column !== 'finalResult',
);

// 这些列在后端有 facet 值+件数端点(facet=values&column=)。
const FACETED = new Set(['framework', 'agentName', 'model', 'subagentType']);

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
  // 用注册表解析 label(不限 BAR_COLUMNS——skill 等 defer 列不在其中,但 chip 仍要显示中文名)。
  const col = resolveTraceColumn(clause.column);
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
  /** 自由文本搜索的已提交值(来自父组件 URL `q`)。 */
  search: string;
  /** 提交自由文本搜索(空串=清除)。 */
  onSearchChange: (value: string) => void;
  user: string;
}

export default function TraceFilterBar({ clauses, onChange, search, onSearchChange, user }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'field' | 'value'>('field');
  const [col, setCol] = useState<FilterColumn | null>(null);
  const [op, setOp] = useState<Operator>('contains');
  const [valueText, setValueText] = useState(''); // value 阶段的输入值
  const [picked, setPicked] = useState<Set<string>>(new Set()); // 多选(any of)选中的值
  const [facet, setFacet] = useState<{ value: string; count: number }[]>([]);

  // 内联自由文本输入(同时:① 模糊搜索 ② 过滤字段下拉)。
  const [barInput, setBarInput] = useState(search);
  // 外部(如「重置」)改了 search → 同步回输入框。用 React 官方「prop 变化时调整 state」推荐法:
  // 渲染期比较(避免 set-state-in-effect 的级联渲染);trim 比较避免下方 debounce 的回声覆盖用户输入。
  const [prevSearch, setPrevSearch] = useState(search);
  if (search !== prevSearch) {
    setPrevSearch(search);
    if (search !== barInput.trim()) setBarInput(search);
  }
  // 用 ref 持有最新 onSearchChange:调用方常传内联箭头函数(每次父渲染都是新引用),若把它放进下方
  // debounce effect 的依赖里,父组件频繁重渲染(数据加载、filtered/stats 更新)会不断 cleanup+重启
  // 定时器,300ms 窗口被反复重置 → 自由文本搜索可能永不提交。故 effect 只依赖 barInput,回调走 ref。
  const onSearchChangeRef = useRef(onSearchChange);
  useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  });
  // 输入 debounce 300ms 提交到父组件的 `q`(input/output contains 搜索)。
  useEffect(() => {
    const id = setTimeout(() => onSearchChangeRef.current(barInput.trim()), 300);
    return () => clearTimeout(id);
  }, [barInput]);

  const backToField = useCallback(() => {
    setStage('field');
    setCol(null);
    setValueText('');
    setPicked(new Set());
    setFacet([]);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    backToField();
  }, [backToField]);

  // 点击栏外 → 关闭下拉(自前实现,避免 Radix Popover 抢走输入焦点导致没法边打字边筛字段)。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const fieldMatches = useMemo(() => {
    const q = barInput.trim().toLowerCase();
    return BAR_COLUMNS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.column.toLowerCase().includes(q));
  }, [barInput]);

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

  // SUGGESTIONS:几个示例枚举列的「最高频值 + 件数」,对标 langfuse 顶部建议。挂载时拉一次。
  const [suggestions, setSuggestions] = useState<{ column: string; value: string; count: number }[]>([]);
  useEffect(() => {
    const showcase = BAR_COLUMNS.filter((c) => c.type === 'stringOptions' && FACETED.has(c.column)).slice(0, 4);
    let alive = true;
    Promise.all(
      showcase.map((c) =>
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=${encodeURIComponent(c.column)}`)
          .then((r) => r.json())
          .then((rows) =>
            Array.isArray(rows) && rows[0] ? { column: c.column, value: rows[0].value, count: rows[0].count } : null,
          )
          .catch(() => null),
      ),
    ).then((res) => {
      if (alive) setSuggestions(res.filter((x): x is { column: string; value: string; count: number } => x != null));
    });
    return () => {
      alive = false;
    };
  }, [user]);

  const pickField = (c: FilterColumn) => {
    setCol(c);
    setOp(defaultOperator(c));
    setValueText('');
    setPicked(new Set());
    setBarInput(''); // 选了字段=要加结构化过滤,清掉这段临时自由文本(连带清搜索)
    setStage('value');
  };

  const addClause = (clause: FilterClause) => {
    onChange([...clauses, clause]);
    backToField();
    inputRef.current?.focus(); // 加完一个,焦点回到栏继续
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
    const raw = valueText.trim();
    if (!raw) return;
    // datetime-local 无时区信息:在**客户端**按本地墙钟解析成绝对时刻,再归一成带 Z 的 UTC ISO。
    // 否则裸串 "YYYY-MM-DDTHH:mm" 会随 URL 传到后端,由**服务器**的 new Date() 按服务器时区解析,
    // 与用户本地时区差多少就偏多少。归一成 UTC ISO 后,前后端解析都无歧义。
    let v: string = raw;
    if (col.type === 'datetime') {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return;
      v = d.toISOString();
    }
    addClause({ column: col.column, operator: op, value: v });
  };

  const removeClause = (i: number) => onChange(clauses.filter((_, idx) => idx !== i));

  return (
    <div ref={containerRef} className="relative">
      {/* 栏体:看起来像一个搜索输入框,内含 chip + 内联自由文本输入 */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5 min-h-9 cursor-text',
          'focus-within:ring-1 focus-within:ring-ring',
        )}
        onMouseDown={(e) => {
          // 点空白处(非 chip/按钮)→ 聚焦输入并打开下拉
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
      >
        <Search className="size-4 text-foreground-muted shrink-0" />
        {clauses.map((c, i) => (
          <Badge key={i} variant="secondary" className="gap-1 pl-2 pr-1 py-0.5 text-xs font-normal">
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
        <input
          ref={inputRef}
          value={barInput}
          onChange={(e) => setBarInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              close();
              inputRef.current?.blur();
            }
          }}
          placeholder={clauses.length ? '继续搜索 / 过滤…' : '搜索输入/输出内容或 Trace ID,或点选字段过滤…'}
          aria-label="搜索或过滤 trace"
          className="flex-1 min-w-[10rem] bg-transparent outline-none text-sm h-6 placeholder:text-muted-foreground"
        />
      </div>

      {/* 下拉:field 阶段=字段列表(被 barInput 过滤);value 阶段=操作符 + 值录入 */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-full max-w-md rounded-md border border-card-border bg-card text-card-foreground shadow-sm">
          {stage === 'field' ? (
            <div className="py-1">
              {/* 有输入 → 顶部「模糊搜索」行(自由文本已实时下推,点它仅收起下拉) */}
              {barInput.trim() && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    inputRef.current?.blur();
                  }}
                  className="flex w-full items-center gap-2 border-b border-card-border px-3 py-2 text-left text-xs text-foreground-muted hover:bg-background-secondary"
                >
                  <Search className="size-3.5 shrink-0" />
                  <span className="truncate">
                    模糊搜索输入/输出含 <span className="font-medium text-foreground">{barInput.trim()}</span>
                  </span>
                </button>
              )}

              {/* 无输入 → SUGGESTIONS:示例列的最高频值 + 件数,点击直接加 chip(对标 langfuse) */}
              {!barInput.trim() && suggestions.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
                    建议
                  </div>
                  <ul className="pb-1">
                    {suggestions.map((s) => (
                      <li key={s.column}>
                        <button
                          type="button"
                          onClick={() => addClause({ column: s.column, operator: 'any of', value: [s.value] })}
                          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-background-secondary"
                        >
                          <span className="truncate font-mono text-xs">
                            <span className="text-foreground-muted">{s.column}:</span>
                            {s.value}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-foreground-muted">{s.count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
                字段
              </div>
              <ul className="max-h-64 overflow-auto pb-1">
                {fieldMatches.map((c) => (
                  <li key={c.column}>
                    <button
                      type="button"
                      onClick={() => pickField(c)}
                      className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-background-secondary"
                    >
                      <Search className="size-4 shrink-0 text-foreground-muted" />
                      <span className="font-medium">{c.label}</span>
                      <span className="font-mono text-xs text-foreground-muted">{c.column}</span>
                      {c.description && (
                        <span className="ml-auto truncate text-xs text-foreground-muted">{c.description}</span>
                      )}
                    </button>
                  </li>
                ))}
                {fieldMatches.length === 0 && <li className="px-3 py-2 text-xs text-foreground-muted">无匹配字段</li>}
              </ul>
            </div>
          ) : (
            col && (
              <div>
                <div className="flex items-center gap-1 p-2 border-b border-border">
                  <button
                    type="button"
                    onClick={backToField}
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
                    <div>
                      <div className="flex gap-2">
                        <Input
                          autoFocus
                          type={col.type === 'number' ? 'number' : col.type === 'datetime' ? 'datetime-local' : 'text'}
                          value={valueText}
                          onChange={(e) => setValueText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && commitValueStage()}
                          placeholder={col.unit ? `值（${col.unit}）` : '值…'}
                          className="h-8 text-sm"
                        />
                        <Button size="sm" className="h-8 text-xs shrink-0" onClick={commitValueStage}>
                          添加
                        </Button>
                      </div>
                      {/* FACETED 的文本列(agentName/model):输入下方给「实际存在的值 + 件数」建议,
                          随输入实时过滤(搜索引擎式)。点击=按当前操作符直接成 chip,免手打全名。
                          facet 已由上方 effect 拉取;非 FACETED 文本列 facet 为空,自然不渲染。 */}
                      <ValueSuggestions
                        facet={facet}
                        query={valueText}
                        onPick={(v) => addClause({ column: col.column, operator: op, value: v })}
                      />
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** 文本值录入下方的建议列表:facet 值按输入实时子串过滤(不区分大小写),点击直接提交。 */
function ValueSuggestions({
  facet,
  query,
  onPick,
}: {
  facet: { value: string; count: number }[];
  query: string;
  onPick: (value: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => facet.filter((f) => !q || f.value.toLowerCase().includes(q)).slice(0, 8),
    [facet, q],
  );
  if (matches.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
        建议
      </div>
      <ul className="max-h-48 overflow-auto">
        {matches.map((f) => (
          <li key={f.value}>
            <button
              type="button"
              onClick={() => onPick(f.value)}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-background-secondary"
            >
              <span className="truncate">{f.value}</span>
              <span className="shrink-0 text-xs tabular-nums text-foreground-muted">{f.count}</span>
            </button>
          </li>
        ))}
      </ul>
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
