'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { HarnessAdjacentDiff } from './HarnessAdjacentDiff';
import { HarnessContextPanel } from './HarnessContextPanel';
import { DshExistingDetails } from './DshExistingDetails';
import { contextViewEvents, requestContextEvents, type ContextEntry, type ContextViewEvent } from '@/lib/ingest/deepseek-harness-otel/context-view';
import { dshContextTokens } from '@/lib/ingest/deepseek-harness-otel/context-membership';

export function HarnessContextTabs({ entries, selectedKey, onSelect, zh, children, taskId }: { entries: ContextEntry[]; selectedKey: string | null; onSelect: (key: string) => void; zh: boolean; children: ReactNode; taskId?:string|null }) {
  const [tab, setTab] = useState('overview');
  const [scope, setScope] = useState('current');
  const selected = entries.find(e => e.key === selectedKey);
  const rows = entries.filter(e => e.request.sourceSessionId === selected?.request.sourceSessionId).sort((a, b) => a.request.eventSequence - b.request.eventSequence);
  const index = selected ? rows.indexOf(selected) : -1;
  const events = contextViewEvents(entries);
  const relevant = selected ? requestContextEvents(events, selected.request) : [];
  const agentSelected = selectedKey?.startsWith('a:') === true;
  const overviewEvents = selected ? relevant : agentSelected ? events : [];
  const label = (kind: string) => ({ compaction: zh ? '上下文压缩' : 'Compaction', prune: zh ? '上下文裁剪' : 'Pruning', model: zh ? '模型变化记录' : 'Model changes' }[kind] ?? kind);
  const jump = (entry: ContextEntry | undefined, context = false) => { if (entry) { onSelect(entry.key); if (context) setTab('context'); } };
  const card = (e: ContextViewEvent) => {
    const same = selected?.request.sourceSessionId === e.source;
    const previous = entries.filter(r => r.request.sourceSessionId === e.source && r.request.eventSequence < e.seq).sort((a, b) => b.request.eventSequence - a.request.eventSequence)[0];
    return <details key={`${e.source}:${e.seq}`} className="border-b border-border py-3" open={scope === 'current' && tab === 'events'}>
      <summary className="cursor-pointer text-sm">{label(e.kind)} #{e.seq} {selected && same && <span className="text-xs text-foreground-secondary">· {e.target?.key === selected.key ? (zh ? '所在相邻区间 · 非因果绑定' : 'Immediately before request') : e.seq < selected.request.eventSequence ? (zh ? '此前 · 历史事件' : 'Earlier event') : (zh ? '此后 · 后续事件' : 'Later event')}</span>}</summary>
      <div className="mt-2 space-y-2 break-words text-xs">
        <p>{zh ? '来源' : 'Source'}: {e.projected ? (zh ? 'dsh-context · 近似投影' : 'dsh-context · approximate projection') : (zh ? 'Harness · 原生记录' : 'Harness · native event')} · {e.source}</p>
        <p>#{previous?.request.eventSequence ?? '—'} → #{e.target?.request.eventSequence ?? '—'}</p>
        {e.kind === 'model' && <p>{String(e.body.from ?? (zh ? '投影未提供前模型' : 'Previous model unavailable'))} → {String(e.body.to ?? (zh ? '投影未提供目标模型' : 'Target unavailable'))} · {e.body.from&&e.body.to?(zh?'来源：插件模型变化记录':'Source: plugin model change'):(zh?'切换未核实':'Switch unverified')}</p>}
        {e.kind === 'compaction' && <p>{zh ? '完整压缩摘要未提供；可展开 checkpoint 的源预览片段，不当作完整摘要。' : 'Summary body is unavailable in this projection; not inferred from statistics.'}</p>}
        {e.kind === 'prune' && <p>{zh ? '可展开已有归档条目及替换点，归属为区间近似；工具正文通常未提供。' : 'Source sequences do not prove full bodies; missing content cannot be reconstructed exactly.'}</p>}
        <details><summary className="cursor-pointer">{zh ? '展开投影已有字段' : 'Captured fields'}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(e.body, null, 2)}</pre></details>
        {e.target&&e.kind!=='model'&&<DshExistingDetails request={e.target.request} taskId={taskId} zh={zh} eventSeq={e.seq}/>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!previous} onClick={() => jump(previous)}>{zh ? '前一请求' : 'Previous request'}</Button><Button size="sm" variant="outline" disabled={!e.target} onClick={() => jump(e.target)}>{zh ? '后一请求' : 'Next request'}</Button></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!previous} onClick={() => jump(previous, true)}>{zh ? '查看事件前上下文' : 'Context before event'}</Button><Button size="sm" variant="ghost" disabled={!e.target} onClick={() => jump(e.target, true)}>{zh ? '查看事件后上下文' : 'Context after event'}</Button></div>
      </div>
    </details>;
  };
  const visible = scope === 'session' ? events : relevant;
  if (!entries.length) return <>{children}</>;
  return <>
    <div className="shrink-0 border-b border-border px-4 py-3" aria-label={zh ? '当前请求标识' : 'Selected request identity'}>
      <p className="text-sm font-medium">{selected ? `${zh ? '模型请求' : 'Model request'} #${selected.request.eventSequence} · ${selected.request.turn}/${selected.request.step}` : agentSelected ? 'DeepSeek Harness' : (zh ? '节点详情' : 'Node details')}</p>
      {selected && <p className="mt-1 break-all text-xs text-foreground-secondary">{selected.request.sourceSessionId}</p>}
    </div>
    <div role="tablist" aria-label={zh ? 'Harness 详情页签' : 'Harness detail tabs'} className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">{[['overview', zh ? '概览' : 'Overview'], ['context', zh ? '上下文' : 'Context'], ['delta', zh ? '相邻对比' : 'Adjacent diff'], ['events', zh ? '事件' : 'Events']].map(([id, text]) => <Button key={id} id={`harness-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="harness-detail-content" size="sm" variant={tab === id ? 'default' : 'ghost'} onClick={() => setTab(id)}>{text}</Button>)}</div>
    <div id="harness-detail-content" role="tabpanel" aria-labelledby={`harness-tab-${tab}`} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      {tab === 'overview' ? <><div className="shrink-0">{children}</div><section className="shrink-0 border-t border-border p-4"><h4 className="text-sm font-medium">{zh ? '上下文变化' : 'Context changes'}</h4><p className="my-2 text-xs text-foreground-secondary">{selected ? `${selected.request.sourceSessionId} · #${selected.request.eventSequence} · ${selected.request.turn}/${selected.request.step}` : agentSelected ? (zh ? '当前 Trace 已采集范围' : 'Available records in this Trace') : (zh ? '当前为非 LLM 节点，请选择 Agent 查看汇总或选择 LLM 查看请求区间。' : 'Select an Agent for totals or an LLM for a request interval.')}</p><div className="mb-2 flex flex-wrap gap-3 text-xs">{['compaction', 'prune', 'model'].map(kind => <span key={kind}>{label(kind)} {overviewEvents.filter(e => e.kind === kind).length}</span>)}</div>{overviewEvents.length ? overviewEvents.map(card) : <p className="text-xs text-foreground-secondary">{zh ? '未采集到相关事件，不据此断言未发生。' : 'No captured events; absence is not proof none occurred.'}</p>}<Button variant="link" size="sm" onClick={() => { setScope(selected ? 'current' : 'session'); setTab('events'); }}>{zh ? '查看事件详情' : 'View event details'}</Button><p className="text-xs text-foreground-secondary">{zh ? '仅统计可用记录；历史缺失或投影窗口截断时不代表会话总次数。' : 'Available records only; incomplete history or projection windows do not represent session totals.'}</p></section></> : <div className="space-y-3 p-4">
        {selected && <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" size="sm" disabled={index <= 0} onClick={() => jump(rows[index - 1])}>{zh ? '← 前次' : '← Previous'}</Button><span className="text-xs">#{selected.request.eventSequence} · {selected.request.turn}/{selected.request.step}</span><Button variant="outline" size="sm" disabled={index >= rows.length - 1} onClick={() => jump(rows[index + 1])}>{zh ? '后次 →' : 'Next →'}</Button></div>}
        {tab === 'context' && <><HarnessContextPanel compact entries={selected ? rows : entries} selectedKey={selectedKey} onSelect={onSelect} zh={zh} />{selected && <DshExistingDetails key={selected.request.sourceSessionId+':'+selected.request.eventSequence} request={selected.request} taskId={taskId} zh={zh}/>}<p className="text-xs text-foreground-secondary">{selected && dshContextTokens(selected.request) ? `dsh-context ${selected.request.dshContext?.version}` : zh ? '投影不可用，第一版不使用新增采集回退。' : 'Projection unavailable; additional-capture fallback is excluded from v1.'}</p></>}
        {tab === 'delta' && <HarnessAdjacentDiff entries={entries} current={selected?.request} zh={zh} />}
        {tab === 'events' && <><div className="flex flex-wrap gap-2" role="group" aria-label={zh ? '事件展示范围' : 'Event scope'}><Button size="sm" variant={scope === 'current' ? 'default' : 'outline'} aria-pressed={scope === 'current'} onClick={() => setScope('current')}>{zh ? '当前请求相关' : 'Current request'}</Button><Button size="sm" variant={scope === 'session' ? 'default' : 'outline'} aria-pressed={scope === 'session'} onClick={() => setScope('session')}>{zh ? '整个会话' : 'Entire session'}</Button></div><p className="text-xs text-foreground-secondary">{scope === 'current' ? (zh ? '范围：前次请求之后、本次请求之前。' : 'Between previous and current request.') : (zh ? '当前 Trace 已采集会话事件，按各自源会话序号定位。' : 'Available session events; located within their own source session.')}</p>{visible.length ? visible.map(card) : <p className="text-sm text-foreground-secondary">{scope === 'session' ? (zh ? '当前 Trace 已采集范围内未发现压缩、裁剪或模型变化记录。' : 'No compaction, pruning or model-change records in the available Trace window.') : selected ? (zh ? '该区间未采集到事件。' : 'No events captured in this interval.') : (zh ? '请选择左侧 LLM，或切换整个会话。' : 'Select an LLM or switch to entire session.')}</p>}<p className="text-xs text-foreground-secondary">{zh ? '仅展示 dsh-context 有效投影事件，窗口可能不完整；仅有模型事件而无 from/to 时不等于已核实切换。区间定位不证明影响或因果，缺失不等于零。' : 'Historical/projection windows may be incomplete; missing is not zero. Positions do not imply causality.'}</p></>}
      </div>}
    </div>
  </>;
}
