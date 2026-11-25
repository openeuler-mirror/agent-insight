'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { HarnessAdjacentDiff } from './HarnessAdjacentDiff';
import { HarnessContextPanel } from './HarnessContextPanel';
import { DshExistingDetails, NativeContextBodies } from './DshExistingDetails';
import { contextViewEvents, requestContextEvents, nativeContextBodies, type ContextEntry, type ContextViewEvent } from '@/lib/ingest/deepseek-harness-otel/context-view';

export function HarnessContextTabs({ entries, selectedKey, onSelect, zh, children, taskId }: { entries: ContextEntry[]; selectedKey: string | null; onSelect: (key: string) => void; zh: boolean; children: ReactNode; taskId?:string|null }) {
  const [tab, setTab] = useState('overview');
  const [scope, setScope] = useState('session');
  const selected = entries.find(e => e.key === selectedKey);
  const rows = entries.filter(e => e.request.sourceSessionId === selected?.request.sourceSessionId).sort((a, b) => a.request.eventSequence - b.request.eventSequence);
  const index = selected ? rows.indexOf(selected) : -1;
  const events = contextViewEvents(entries);
  const relevant = selected ? requestContextEvents(events, selected.request) : [];
  const agentSelected = selectedKey?.startsWith('a:') === true;
  const label = (kind: string) => ({ compaction: zh ? '上下文压缩' : 'Compaction', prune: zh ? '上下文裁剪' : 'Pruning', model: zh ? '模型变化记录' : 'Model changes' }[kind] ?? kind);
  const jump = (entry: ContextEntry | undefined, context = false) => { if (entry) { onSelect(entry.key); if (context) setTab('context'); } };
  const card = (e: ContextViewEvent) => {
    const same = selected?.request.sourceSessionId === e.source;
    const previous = entries.filter(r => r.request.sourceSessionId === e.source && r.request.eventSequence < e.seq).sort((a, b) => b.request.eventSequence - a.request.eventSequence)[0];
    return <details key={`${e.source}:${e.seq}`} className="border-b border-border py-3" open={scope === 'current' && tab === 'events'}>
      <summary className="cursor-pointer text-sm">{label(e.kind)} #{e.seq} {selected && same && <span className="text-xs text-foreground-secondary">· {e.target?.key === selected.key ? (zh ? '本次请求前' : 'Immediately before request') : e.seq < selected.request.eventSequence ? (zh ? '此前 · 历史事件' : 'Earlier event') : (zh ? '此后 · 后续事件' : 'Later event')}</span>}</summary>
      <div className="mt-2 space-y-2 break-words text-xs">
        <p>{zh ? '请求区间' : 'Request interval'}</p>
        <p>#{previous?.request.eventSequence ?? '—'} → #{e.target?.request.eventSequence ?? '—'}</p>
        {e.kind === 'model' && <p>{String(e.body.from ?? (zh ? '投影未提供前模型' : 'Previous model unavailable'))} → {String(e.body.to ?? (zh ? '投影未提供目标模型' : 'Target unavailable'))} · {e.body.from&&e.body.to?(zh?'来源：插件模型变化记录':'Source: plugin model change'):(zh?'切换未核实':'Switch unverified')}</p>}
        {e.kind === 'compaction' && <><p>{zh?'压缩记录数':'Compacted records'}: {String(e.body.count??'—')} · {zh?'估算 Token':'Estimated tokens'}: {String(e.body.grossTokens??e.body.tokens??'—')}</p><NativeContextBodies bodies={e.bodies??[]} taskId={taskId} zh={zh}/>{!e.bodies?.length&&<p>{zh?'摘要正文未采集。':'Summary body not collected.'}</p>}</>}
        {e.kind === 'prune' && <p>{zh ? '下方列出可获取的归档条目；不保证完整覆盖。' : 'Available archived items are shown below; coverage may be incomplete.'}</p>}
        <details><summary className="cursor-pointer">{zh ? '技术详情' : 'Technical details'}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(e.body, null, 2)}</pre></details>
        {e.target&&e.kind==='prune'&&<DshExistingDetails request={e.target.request} taskId={taskId} zh={zh} eventSeq={e.seq}/>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!previous} onClick={() => jump(previous, true)}>{zh ? '查看事件前上下文' : 'Context before event'}</Button><Button size="sm" variant="ghost" disabled={!e.target} onClick={() => jump(e.target, true)}>{zh ? '查看事件后上下文' : 'Context after event'}</Button></div>
      </div>
    </details>;
  };
  const visible = scope === 'session' ? events : relevant;
  if (!entries.length) return <>{children}</>;
  return <>
    <div role="tablist" aria-label={zh ? 'Harness 详情页签' : 'Harness detail tabs'} className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">{[['overview', zh ? '概览' : 'Overview'], ['context', zh ? '上下文' : 'Context'], ['delta', zh ? '相邻对比' : 'Adjacent diff'], ['events', zh ? '事件' : 'Events']].map(([id, text]) => <Button key={id} id={`harness-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="harness-detail-content" size="sm" variant={tab === id ? 'default' : 'ghost'} onClick={() => setTab(id)}>{text}</Button>)}</div>
    <div id="harness-detail-content" role="tabpanel" aria-labelledby={`harness-tab-${tab}`} className={`flex min-h-0 flex-1 flex-col ${tab === 'overview' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain'}`}>
      {tab === 'overview' ? children : <div className="space-y-3 p-4">
    <div className="border-b border-border pb-2" aria-label={zh ? '当前请求标识' : 'Selected request identity'}>
      <p className="text-sm font-medium">{selected ? `${zh ? '模型请求' : 'Model request'} #${selected.request.eventSequence} · ${selected.request.turn}/${selected.request.step}` : agentSelected ? 'DeepSeek Harness' : (zh ? '节点详情' : 'Node details')}</p>
    </div>

        {selected && <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" size="sm" disabled={index <= 0} onClick={() => jump(rows[index - 1])}>{zh ? '← 前次' : '← Previous'}</Button><span className="text-xs">#{selected.request.eventSequence} · {selected.request.turn}/{selected.request.step}</span><Button variant="outline" size="sm" disabled={index >= rows.length - 1} onClick={() => jump(rows[index + 1])}>{zh ? '后次 →' : 'Next →'}</Button></div>}
        {tab === 'context' && <><HarnessContextPanel compact entries={selected ? rows : entries} selectedKey={selectedKey} onSelect={onSelect} zh={zh} />{selected && <DshExistingDetails key={selected.request.sourceSessionId+':'+selected.request.eventSequence} request={selected.request} taskId={taskId} zh={zh} bodies={rows.flatMap(row=>nativeContextBodies(row.request)).filter(body=>body.sourceEventSeq<selected.request.eventSequence)}/>}</>}
        {tab === 'delta' && <HarnessAdjacentDiff entries={entries} current={selected?.request} zh={zh} />}
        {tab === 'events' && <><div className="flex flex-wrap gap-2" role="group" aria-label={zh ? '事件展示范围' : 'Event scope'}><Button size="sm" variant={scope === 'current' ? 'default' : 'outline'} aria-pressed={scope === 'current'} onClick={() => setScope('current')}>{zh ? '本次请求前' : 'Before this request'}</Button><Button size="sm" variant={scope === 'session' ? 'default' : 'outline'} aria-pressed={scope === 'session'} onClick={() => setScope('session')}>{zh ? '整个会话' : 'Entire session'}</Button></div><p className="text-xs text-foreground-secondary">{scope === 'current' ? (zh ? '仅显示前一已采集响应与当前响应之间的事件。' : 'Between previous and current request.') : (zh ? '已采集的会话事件；选择事件查看前后上下文。' : 'Available session events; located within their own source session.')}</p>{visible.length ? visible.map(card) : <p className="text-sm text-foreground-secondary">{scope === 'session' ? (zh ? '当前 Trace 已采集范围内未发现压缩、裁剪或模型变化记录。' : 'No compaction, pruning or model-change records in the available Trace window.') : selected ? (zh ? '该区间未采集到事件。' : 'No events captured in this interval.') : (zh ? '请选择左侧 LLM，或切换整个会话。' : 'Select an LLM or switch to entire session.')}</p>}<p className="text-xs text-foreground-secondary">{zh ? '历史记录可能不完整；事件先后关系不代表因果。' : 'Historical/projection windows may be incomplete; missing is not zero. Positions do not imply causality.'}</p></>}
      </div>}
    </div>
  </>;
}
