'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/client/api';
import { resolveTraceColumn } from '@/lib/filters/trace-columns';
import type { FilterClause, FilterColumn } from '@/lib/filters/types';

/**
 * 链路追踪左侧过滤栏(对标 langfuse 最左「Filters」列)。
 *
 * 和顶部搜索栏(TraceFilterBar)一样,是对**同一份 `clauses`(FilterClause[])的编辑器**——
 * 「一份 FilterState,两个编辑器」。这里聚焦老横向下拉没有的**数值区间 / 布尔 / 文本包含 / 枚举多选**;
 * ownership/agent/skill/status/time/framework/scope 仍由页面既有下拉承担(不在此)。
 */

type SectionKind = 'select' | 'contains' | 'range' | 'boolean';
const SECTIONS: { column: string; kind: SectionKind; defaultOpen?: boolean }[] = [
  { column: 'framework', kind: 'select', defaultOpen: true },
  { column: 'skill', kind: 'select', defaultOpen: true },
  { column: 'subagentType', kind: 'select' },
  { column: 'model', kind: 'contains', defaultOpen: true },
  { column: 'latency', kind: 'range', defaultOpen: true },
  { column: 'tokens', kind: 'range' },
  { column: 'cost', kind: 'range' },
  { column: 'answerScore', kind: 'range' },
  { column: 'isAnswerCorrect', kind: 'boolean' },
  { column: 'isSkillCorrect', kind: 'boolean' },
];

interface Props {
  clauses: FilterClause[];
  onChange: (clauses: FilterClause[]) => void;
  user: string;
}

export default function TraceFilterSidebar({ clauses, onChange, user }: Props) {
  const clausesFor = (col: string) => clauses.filter((c) => c.column === col);
  const replaceColumn = (col: string, next: FilterClause[]) =>
    onChange([...clauses.filter((c) => c.column !== col), ...next]);

  return (
    <div className="divide-y divide-card-border">
      {SECTIONS.map((s) => {
        const col = resolveTraceColumn(s.column);
        if (!col) return null;
        return (
          <Section
            key={s.column}
            col={col}
            kind={s.kind}
            defaultOpen={s.defaultOpen}
            user={user}
            current={clausesFor(s.column)}
            onSet={(next) => replaceColumn(s.column, next)}
          />
        );
      })}
    </div>
  );
}

function Section({
  col,
  kind,
  defaultOpen,
  user,
  current,
  onSet,
}: {
  col: FilterColumn;
  kind: SectionKind;
  defaultOpen?: boolean;
  user: string;
  current: FilterClause[];
  onSet: (next: FilterClause[]) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const active = current.length > 0;
  return (
    <div className="py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-1 text-left"
      >
        {open ? <ChevronDown className="size-3.5 text-foreground-muted" /> : <ChevronRight className="size-3.5 text-foreground-muted" />}
        <span className="text-sm font-medium">{col.label}</span>
        <span className="font-mono text-[11px] text-foreground-muted">{col.column}</span>
        {active && <span className="ml-auto size-1.5 rounded-full bg-primary" aria-label="已启用" />}
      </button>
      {open && (
        <div className="mt-1.5 px-1">
          {kind === 'select' && <SelectBody col={col} user={user} current={current} onSet={onSet} />}
          {kind === 'contains' && <ContainsBody col={col} current={current} onSet={onSet} />}
          {kind === 'range' && <RangeBody col={col} current={current} onSet={onSet} />}
          {kind === 'boolean' && <BooleanBody col={col} current={current} onSet={onSet} />}
        </div>
      )}
    </div>
  );
}

// —— SELECT:枚举多选(any of),复选框 + 件数 ——
function SelectBody({
  col,
  user,
  current,
  onSet,
}: {
  col: FilterColumn;
  user: string;
  current: FilterClause[];
  onSet: (next: FilterClause[]) => void;
}) {
  const [values, setValues] = useState<{ value: string; count: number }[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // 侧栏 select 段的列都在 FACETED 内(有 facet 端点);loaded 在异步回调里置位,避免 set-state-in-effect。
    let alive = true;
    apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=${encodeURIComponent(col.column)}`)
      .then((r) => r.json())
      .then((rows) => alive && setValues(Array.isArray(rows) ? rows : []))
      .catch(() => alive && setValues([]))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [col.column, user]);

  const picked = new Set(
    (current.find((c) => c.operator === 'any of')?.value as string[] | undefined) ?? [],
  );
  const toggle = (v: string) => {
    const next = new Set(picked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    const arr = Array.from(next);
    onSet(arr.length ? [{ column: col.column, operator: 'any of', value: arr }] : []);
  };

  if (!loaded) return <p className="text-xs text-foreground-muted">加载中…</p>;
  if (values.length === 0) return <p className="text-xs text-foreground-muted">无可选值</p>;
  return (
    <ul className="max-h-48 overflow-auto">
      {values.map((f) => (
        <li key={f.value}>
          <button
            type="button"
            onClick={() => toggle(f.value)}
            className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-sm hover:bg-background-secondary"
          >
            <span className="flex min-w-0 items-center gap-2">
              <input type="checkbox" readOnly checked={picked.has(f.value)} className="pointer-events-none" />
              <span className="truncate">{f.value}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-foreground-muted">{f.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// —— CONTAINS:文本包含(apply on Enter/blur)——
function ContainsBody({
  col,
  current,
  onSet,
}: {
  col: FilterColumn;
  current: FilterClause[];
  onSet: (next: FilterClause[]) => void;
}) {
  const committed = (current.find((c) => c.operator === 'contains')?.value as string | undefined) ?? '';
  const [text, setText] = useState(committed);
  // 外部(重置/搜索栏)改动 → 同步(渲染期,避免 set-state-in-effect)
  const [prev, setPrev] = useState(committed);
  if (committed !== prev) {
    setPrev(committed);
    if (committed !== text) setText(committed);
  }
  const apply = () => {
    const v = text.trim();
    onSet(v ? [{ column: col.column, operator: 'contains', value: v }] : []);
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => e.key === 'Enter' && apply()}
      placeholder="包含…"
      className="h-7 w-full rounded border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

// —— RANGE:数值区间 min/max(≥ / ≤,apply on Enter/blur)——
function RangeBody({
  col,
  current,
  onSet,
}: {
  col: FilterColumn;
  current: FilterClause[];
  onSet: (next: FilterClause[]) => void;
}) {
  const minC = current.find((c) => c.operator === '>=');
  const maxC = current.find((c) => c.operator === '<=');
  const [min, setMin] = useState(minC ? String(minC.value) : '');
  const [max, setMax] = useState(maxC ? String(maxC.value) : '');
  const key = `${minC?.value ?? ''}|${maxC?.value ?? ''}`;
  const [prev, setPrev] = useState(key);
  if (key !== prev) {
    setPrev(key);
    setMin(minC ? String(minC.value) : '');
    setMax(maxC ? String(maxC.value) : '');
  }
  const apply = () => {
    const next: FilterClause[] = [];
    if (min.trim() !== '' && Number.isFinite(Number(min))) next.push({ column: col.column, operator: '>=', value: Number(min) });
    if (max.trim() !== '' && Number.isFinite(Number(max))) next.push({ column: col.column, operator: '<=', value: Number(max) });
    onSet(next);
  };
  const inputCls = 'h-7 w-full rounded border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring';
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        placeholder={col.unit ? `最小(${col.unit})` : '最小'}
        className={inputCls}
      />
      <span className="text-xs text-foreground-muted">–</span>
      <input
        type="number"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        placeholder={col.unit ? `最大(${col.unit})` : '最大'}
        className={inputCls}
      />
    </div>
  );
}

// —— BOOLEAN:全部 / 是 / 否 ——
function BooleanBody({
  col,
  current,
  onSet,
}: {
  col: FilterColumn;
  current: FilterClause[];
  onSet: (next: FilterClause[]) => void;
}) {
  const cur = current.find((c) => c.operator === '=');
  const val = cur ? (cur.value as boolean) : undefined;
  const set = (v: boolean | undefined) =>
    onSet(v === undefined ? [] : [{ column: col.column, operator: '=', value: v }]);
  const opt = (label: string, v: boolean | undefined) => (
    <button
      type="button"
      onClick={() => set(v)}
      className={
        'flex-1 rounded px-2 py-1 text-xs ' +
        (val === v ? 'bg-primary text-primary-foreground' : 'hover:bg-background-secondary text-foreground-muted')
      }
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-1 rounded border border-input p-0.5">
      {opt('全部', undefined)}
      {opt('是', true)}
      {opt('否', false)}
    </div>
  );
}
