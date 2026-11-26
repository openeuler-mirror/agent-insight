'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { HarnessAdjacentDiff } from './HarnessAdjacentDiff';
import { HarnessContextPanel } from './HarnessContextPanel';
import type { ContextEntry } from '@/lib/ingest/deepseek-harness-otel/context-view';

export function HarnessContextTabs({ entries, selectedKey, onSelect, zh, children }: { entries: ContextEntry[]; selectedKey: string | null; onSelect: (key: string) => void; zh: boolean; children: ReactNode; taskId?: string | null }) {
  const [tab, setTab] = useState('overview');
  const selected = entries.find(entry => entry.key === selectedKey);
  const rows = entries.filter(entry => entry.request.sourceSessionId === selected?.request.sourceSessionId).sort((a, b) => a.request.eventSequence - b.request.eventSequence);
  const index = selected ? rows.indexOf(selected) : -1;
  if (!entries.length) return <>{children}</>;
  return <>
    <div role="tablist" aria-label={zh ? 'Harness 详情页签' : 'Harness detail tabs'} className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">{[['overview', zh ? '概览' : 'Overview'], ['context', zh ? '上下文' : 'Context'], ['delta', zh ? '相邻对比' : 'Adjacent diff']].map(([id, text]) => <Button key={id} id={`harness-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="harness-detail-content" size="sm" variant={tab === id ? 'default' : 'ghost'} onClick={() => setTab(id)}>{text}</Button>)}</div>
    <div id="harness-detail-content" role="tabpanel" aria-labelledby={`harness-tab-${tab}`} className={`flex min-h-0 flex-1 flex-col ${tab === 'overview' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain'}`}>
      {tab === 'overview' ? children : <div className="space-y-3 p-4">
        {selected && <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" size="sm" disabled={index <= 0} onClick={() => onSelect(rows[index - 1].key)}>{zh ? '← 前次' : '← Previous'}</Button><span className="text-xs">{zh ? '请求' : 'Request'} #{selected.request.eventSequence}</span><Button variant="outline" size="sm" disabled={index >= rows.length - 1} onClick={() => onSelect(rows[index + 1].key)}>{zh ? '后次 →' : 'Next →'}</Button></div>}
        {tab === 'context' && <HarnessContextPanel compact entries={selected ? rows : entries} selectedKey={selectedKey} onSelect={onSelect} zh={zh} />}
        {tab === 'delta' && <HarnessAdjacentDiff entries={entries} current={selected?.request} zh={zh} />}
      </div>}
    </div>
  </>;
}
