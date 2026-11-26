'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';
import { dshContextTokens } from '@/lib/ingest/deepseek-harness-otel/context-membership';
import { clampRequestWindow, DEFAULT_REQUEST_WINDOW_SIZE, revealRequestWindow, shiftRequestWindow, type RequestWindow } from './harness-request-window';

type Reference = NonNullable<RawInteraction['harnessRequests']>[number];
type Entry = { request: Reference; key: string; usage?: RawInteraction['usage'] };
const categoryFills: Record<string, string> = { 'tool-definition': 'var(--group-a)', system: 'var(--group-b)', user: 'var(--foreground-muted)', assistant: 'var(--group-a-subtle-border)', tool: 'var(--group-b-subtle-border)', 'runtime-context': 'var(--foreground-secondary)', 'skill-injection': 'color-mix(in srgb, var(--group-b) 65%, var(--foreground-secondary))', 'skill-catalog': 'color-mix(in srgb, var(--group-a) 65%, var(--foreground-secondary))', developer: 'var(--foreground)' };
const names: Record<string, string> = { system: '系统提示词', 'tool-definition': '工具定义', user: '用户消息', 'skill-injection': 'Skill 注入', tool: '工具结果', assistant: '历史回复', 'runtime-context': '运行上下文', 'skill-catalog': 'Skill 目录', developer: 'Developer' };

type BodyMember = Record<string, any> & { itemId: string; category: string };

export function filterHarnessBodyMembers(items: BodyMember[], category: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return items.map((item, index) => ({ item, index })).filter(({ item }) =>
    (category === 'all' || item.category === category) && (!needle ||
      [item.itemId, item.category, names[item.category], item.sourceKind, item.sourceType, item.sourceCallId]
        .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle))));
}

export function HarnessBodyDetails({ json, zh, requestLabel, embedded = false, bodiesLoaded = true }: { json: string; zh: boolean; requestLabel?: string; embedded?: boolean; bodiesLoaded?: boolean }) {
  const items = useMemo<BodyMember[] | null>(() => {
    try {
      const value = JSON.parse(json);
      return Array.isArray(value) && value.every(item => item && typeof item === 'object'
        && typeof item.itemId === 'string' && typeof item.category === 'string') ? value : null;
    } catch { return null; }
  }, [json]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (!items) return <p>{zh ? '正文格式不兼容' : 'Incompatible body format'}</p>;
  const counts = items.reduce<Record<string, number>>((all, item) => {
    all[item.category] = (all[item.category] ?? 0) + 1; return all;
  }, {});
  const filtered = filterHarnessBodyMembers(items, category, query);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 5) - 1));
  const visible = filtered.slice(currentPage * 5, currentPage * 5 + 5);
  const selected = selectedIndex === null ? null : items[selectedIndex];
  const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—';
  const reset = () => { setPage(0); setSelectedIndex(null); };
  const browser = <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2" aria-label={zh ? '成员分类数量' : 'Member category counts'}>
      {[['all', items.length], ...Object.entries(counts)].map(([key, count]) => <Button key={String(key)} size="sm" variant={category === key ? 'default' : 'outline'}
        aria-pressed={category === key} onClick={() => { setCategory(String(key)); reset(); }}>
        {key === 'all' ? (zh ? '全部' : 'All') : zh ? names[String(key)] ?? key : key} {count}
      </Button>)}
    </div>
    <label className="block text-sm">{zh ? '搜索成员标识、分类或来源' : 'Search member ID, category or source'}
      <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={query}
        placeholder={zh ? '例如 bash、用户消息、compact-checkpoint' : 'e.g. bash, user, compact-checkpoint'}
        onChange={event => { setQuery(event.target.value); reset(); }} />
    </label>
    <div className="max-w-full overflow-auto rounded-md border border-border">
      <table className="w-full min-w-[700px] text-left text-sm" aria-label={zh ? '请求成员分类来源与字节明细' : 'Request members, sources and bytes'}>
        <thead className="bg-background-secondary text-xs text-foreground-secondary"><tr>
          <th className="p-2">{zh ? '成员 / 来源' : 'Member / source'}</th><th className="p-2">{zh ? '分类' : 'Category'}</th>
          <th className="p-2 text-right">{zh ? '原始 B' : 'Source B'}</th><th className="p-2 text-right">{zh ? '脱敏 B' : 'Redacted B'}</th>
          <th className="p-2 text-right">{zh ? '存储 B' : 'Stored B'}</th><th className="p-2">{zh ? '正文状态' : 'Body status'}</th><th className="p-2">{zh ? '详情' : 'Details'}</th>
        </tr></thead><tbody>{visible.map(({ item, index }) => <tr key={index} className={`border-t border-border ${selectedIndex === index ? 'bg-primary-subtle' : ''}`}>
          <td className="max-w-64 p-2"><p className="break-all font-mono text-xs">{item.itemId}</p><p className="break-all text-xs text-foreground-secondary">{item.sourceKind ?? item.sourceType ?? (zh ? '来源未提供' : 'Source unavailable')} {item.sourceCallId ?? ''}</p></td>
          <td className="p-2 whitespace-nowrap">{zh ? names[item.category] ?? item.category : item.category}</td>
          <td className="p-2 text-right tabular-nums">{bytes(item.originalBytes)}</td><td className="p-2 text-right tabular-nums">{bytes(item.redactedBytes)}</td>
          <td className="p-2 text-right tabular-nums">{bytes(item.storedBytes)}</td><td className="p-2">{item.bodyStatus ?? (zh ? '未知' : 'Unknown')}</td>
          <td className="p-2"><Button size="sm" variant="outline" aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(index)}>{zh ? '展开' : 'Open'}</Button></td>
        </tr>)}</tbody>
      </table>
      {filtered.length === 0 && <p className="p-4 text-sm text-foreground-secondary">{zh ? '没有匹配成员' : 'No matching members'}</p>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-secondary">
      <p>{filtered.length ? currentPage * 5 + 1 : 0}–{Math.min(filtered.length, currentPage * 5 + 5)} / {filtered.length} {zh ? '项；字节不是 Token' : 'items; bytes are not tokens'}</p>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{zh ? '上一页' : 'Previous'}</Button>
        <Button size="sm" variant="outline" disabled={(currentPage + 1) * 5 >= filtered.length} onClick={() => setPage(currentPage + 1)}>{zh ? '下一页' : 'Next'}</Button></div>
    </div>
    {selected && <section className="space-y-2 rounded-md border border-border bg-background-secondary p-3" aria-label={zh ? '选中成员正文' : 'Selected member body'}>
      <h4 className="break-all font-mono text-sm">{selected.itemId}</h4>
      <p className="text-xs">{zh ? '来源' : 'Source'}: {selected.sourceKind ?? selected.sourceType} {selected.sourceCallId ?? ''} · {zh ? '源事件' : 'Source event'}: {selected.sourceEventSeq ?? (zh ? '未提供，不推测' : 'unavailable, not inferred')}</p>
      <p className="text-xs">{zh ? '原始 / 脱敏 / 存储字节' : 'Source / redacted / stored bytes'}: {bytes(selected.originalBytes)} / {bytes(selected.redactedBytes)} / {bytes(selected.storedBytes)} · {selected.bodyStatus}</p>
      {typeof selected.text === 'string' && bodiesLoaded ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{selected.text}</pre> : <p>{!bodiesLoaded ? (zh ? '正文尚未加载，请点击加载已采集正文。' : 'Body not loaded; choose Load captured bodies.') : zh ? '未记录正文，仅有成员元数据' : 'Body not collected; membership metadata only'}</p>}
    </section>}
    <p className="text-xs text-foreground-secondary">{zh ? '未记录正文时仅有成员元数据；截断、省略和到期不能作为完整正文比较证据。' : 'Uncollected bodies retain metadata only; truncated, omitted or expired content cannot support full-text comparisons.'}</p>
  </div>;
  if (embedded) return browser;
  return <div className="mt-3 min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{zh ? '请求成员' : 'Request members'} · {items.length}</h4>
      <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>{zh ? '展开成员面板' : 'Expand member panel'}</Button></div>
    {!expanded && browser}
    <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-h-[90vh] max-w-[1200px] overflow-auto">
      <DialogHeader><DialogTitle>{zh ? '请求成员分类与正文' : 'Request member categories and bodies'} · {items.length}</DialogTitle>
        <DialogDescription>{requestLabel && <span className="mb-1 block break-all font-mono text-xs">{requestLabel}</span>}{zh ? '按分类筛选、搜索来源并核对字节；仅显示已授权读取的采集记录。' : 'Filter categories, search sources and inspect sizes in authorized captured records.'}</DialogDescription></DialogHeader>
      {expanded && browser}
    </DialogContent></Dialog>
  </div>;
}

export function HarnessContextPanel({ entries, selectedKey, onSelect, zh, compact = false }: { compact?: boolean; entries: Entry[]; selectedKey: string | null; onSelect: (key: string) => void; zh: boolean }) {
  const selectedSource = entries.find(entry => entry.key === selectedKey)?.request.sourceSessionId;
  const [source, setSource] = useState(selectedSource ?? '');
  const sources = [...new Set(entries.map(entry => entry.request.sourceSessionId))];
  const currentSource = sources.includes(source) ? source : sources[0];
  useEffect(() => { if (selectedSource) setSource(selectedSource); }, [selectedKey, selectedSource]);
  const rows = useMemo(() => entries.filter(entry => entry.request.sourceSessionId === currentSource)
    .sort((a, b) => a.request.eventSequence - b.request.eventSequence), [entries, currentSource]);
  return <details className="rounded-lg border border-border bg-card p-3" open>
    <summary className="cursor-pointer font-medium">{zh ? '逐请求上下文趋势' : 'Context by model request'}</summary>
    {sources.length > 1 && <div className="my-2 flex min-w-0 flex-wrap gap-3 text-sm">
      <label className="min-w-0 max-w-full">{zh ? '源会话 ' : 'Source session '}<select className="max-w-full" aria-label={zh ? '上下文源会话' : 'Context source session'} value={currentSource} onChange={event => setSource(event.target.value)}>{sources.map(id => <option key={id}>{id}</option>)}</select></label>
    </div>}
    <p className="text-xs text-foreground-secondary">{zh ? '分类 Token 为近似估算，与服务商实际用量分开显示；缺失保持为空。' : 'Category tokens are estimates, separate from provider usage. Missing data stays unknown.'}</p>
    <HarnessSourceTrend key={currentSource ?? ''} rows={rows} selectedKey={selectedKey} onSelect={onSelect} zh={zh} compact={compact} />
    <details className="mt-2 text-xs text-foreground-secondary"><summary className="cursor-pointer">{zh ? '数据来源' : 'Data source'}</summary><p>dsh-context {rows.find(row => dshContextTokens(row.request))?.request.dshContext?.version ?? '—'}</p><p>{currentSource}</p></details>
    {!rows.some(row => dshContextTokens(row.request)) && <p>{zh ? '没有可用投影：插件不可用、版本不兼容或历史不足；不展示成员估算，原有 Trace 仍可使用。' : 'No valid projection: unavailable plugin, incompatible version or insufficient history. Existing Trace remains available.'}</p>}
  </details>;
}

function HarnessSourceTrend({ rows: entries, selectedKey, onSelect, zh, compact }: { rows: Entry[]; selectedKey: string | null; onSelect: (key: string) => void; zh: boolean; compact: boolean }) {
  const rows = useMemo(() => entries.map(entry => ({ ...entry, sourceTokens: dshContextTokens(entry.request) })), [entries]);
  const selectedIndex = rows.findIndex(row => row.key === selectedKey);
  const [window, setWindow] = useState<RequestWindow>(() => revealRequestWindow(rows.length, selectedIndex));
  const previousSelection = useRef({ key: selectedKey, index: selectedIndex });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { key: selectedKey, index: selectedIndex };
    const selectionChanged = previous.key !== selectedKey || previous.index < 0 && selectedIndex >= 0;
    setWindow(current => {
      const next = selectionChanged ? revealRequestWindow(rows.length, selectedIndex, current) : clampRequestWindow(rows.length, current);
      return next.startIndex === current.startIndex && next.endIndex === current.endIndex ? current : next;
    });
  }, [selectedKey, selectedIndex, rows.length]);
  const range = clampRequestWindow(rows.length, window);
  const visibleRows = rows.slice(range.startIndex, range.endIndex + 1);
  const categories = [...new Set(rows.flatMap(row => Object.keys(row.sourceTokens ?? {})))];
  const data = rows.map(row => ({ seq: row.request.eventSequence, requestKey: row.key, ...Object.fromEntries(categories.map(category => [category,
    row.sourceTokens?.[category] ?? null])) }));
  const visibleData = data.slice(range.startIndex, range.endIndex + 1);
  const size = visibleRows.length;
  return <>
    <div className="my-2 flex flex-wrap items-center justify-between gap-2">
      <output className="text-xs text-foreground-secondary" aria-live="polite">{zh ? `第 ${size ? range.startIndex + 1 : 0}–${size ? range.endIndex + 1 : 0} / ${rows.length} 次请求` : `Requests ${size ? range.startIndex + 1 : 0}–${size ? range.endIndex + 1 : 0} of ${rows.length}`}</output>
      {rows.length > DEFAULT_REQUEST_WINDOW_SIZE && <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={range.startIndex === 0} onClick={() => setWindow(shiftRequestWindow(rows.length, range, -1))}>{zh ? `← 前 ${size} 次` : `← Previous ${size}`}</Button>
        <Button size="sm" variant="outline" onClick={() => setWindow(revealRequestWindow(rows.length, selectedIndex))}>{zh ? '重置为10次' : 'Reset to 10'}</Button>
        <Button size="sm" variant="outline" disabled={range.endIndex >= rows.length - 1} onClick={() => setWindow(shiftRequestWindow(rows.length, range, 1))}>{zh ? `后 ${size} 次 →` : `Next ${size} →`}</Button>
      </div>}
    </div>
    <div className={compact ? 'h-48' : 'h-64'} aria-label={zh ? '逐请求上下文分类堆叠柱状图' : 'Stacked context composition by request'}>
      <ResponsiveContainer width="100%" height="100%"><BarChart data={visibleData} margin={{ top: 15, right: 15, left: 10, bottom: 5 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="seq" /><YAxis width={60} /><Tooltip cursor={{ fill: 'var(--background-secondary)' }}
          itemStyle={{ color: 'var(--foreground)' }} labelStyle={{ color: 'var(--foreground)' }} contentStyle={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)', color: 'var(--foreground)' }} /><Legend formatter={value => <span className="text-xs text-foreground-secondary">{value}</span>} />
        {categories.map(category => <Bar key={category} dataKey={category} stackId="context" name={zh ? names[category] ?? category : category}
          fill={categoryFills[category] ?? 'var(--foreground-muted)'} isAnimationActive={false} cursor="pointer" onClick={point => { if (point?.payload?.requestKey) onSelect(point.payload.requestKey); }}>
          {visibleRows.map(row => <Cell key={row.key} stroke={selectedKey === row.key ? 'var(--primary)' : undefined} strokeWidth={selectedKey === row.key ? 2 : 0} />)}
        </Bar>)}
      </BarChart></ResponsiveContainer>
    </div>
    <p className="text-xs text-foreground-secondary">{zh ? '每根柱对应一次请求；点击柱或下表请求定位 LLM。新选中的左侧调用会自动进入当前窗口。缺失数据不代表零值。' : 'Each stacked bar represents one request. Select a bar or table request to locate its LLM. Newly selected calls are revealed automatically. Missing data does not mean zero.'}</p>
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-foreground-secondary">{zh ? '查看当前窗口数据' : 'View window data'}</summary><div className="max-h-64 max-w-full overflow-auto"><table className="w-full text-left text-xs"><caption className="text-left">{zh ? '当前范围内的请求；分类值为近似估算 Token，实际用量单列。' : 'Requests in the visible range. Category estimates and provider usage are separate.'}</caption><thead><tr><th>{zh ? '请求' : 'Request'}</th>{categories.map(category => <th key={category}>{zh ? names[category] ?? category : category}</th>)}<th>{zh ? '服务商实际 Input / Output / Cache' : 'Provider Input / Output / Cache'}</th></tr></thead><tbody>{visibleRows.map(row => <tr key={row.key} className="border-t border-border"><td><button className="text-primary hover:underline aria-current:font-semibold" aria-current={selectedKey === row.key ? 'true' : undefined} onClick={() => onSelect(row.key)}>#{row.request.eventSequence}</button></td>{categories.map(category => <td key={category}>{row.sourceTokens?.[category] ?? '—'}</td>)}<td>{row.request.providerUsage ? `${row.request.providerUsage.input ?? '—'} / ${row.request.providerUsage.output ?? '—'} / ${row.request.providerUsage.cacheRead ?? '—'}` : '—'}</td></tr>)}</tbody></table></div></details>
  </>;
}
