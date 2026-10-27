/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { useState } from 'react';
import type { DiagnosisProgressEvent } from '@/lib/engine/agent-debug/progress-types';
import { ExpandableText } from '@/components/text/ExpandableText';
import { Button } from '@/components/ui/button';

export function DiagnosisProgressFeed({ events, zh, onNodeRefClick }: {
  events: DiagnosisProgressEvent[];
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!events.length) return null;
  const visible = showAll ? events : events.slice(-4);
  const sources = zh
    ? { task: '任务状态', tool: '工具调用', evidence: '执行证据', analysis: '阶段分析', stage: '阶段状态' }
    : { task: 'Task', tool: 'Tool', evidence: 'Evidence', analysis: 'Analysis', stage: 'Stage' };
  return (
    <div className="space-y-3">
      {events.length > 4 && <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => setShowAll(value => !value)}>
        {showAll ? (zh ? '收起较早内容' : 'Hide earlier updates') : (zh ? `查看较早的 ${events.length - 4} 段内容` : `Show ${events.length - 4} earlier updates`)}
      </Button>}
      <ol className="space-y-4">
        {visible.map(event => (
          <li key={event.seq} className="relative border-l border-border pl-4">
            <span className={`absolute -left-1 top-1.5 size-2 rounded-full ${event.state === 'failed' ? 'bg-error' : 'bg-foreground-muted'}`} />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-foreground-muted">
              <time dateTime={event.at} className="tabular-nums">{new Date(event.at).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}</time>
              <span>{sources[event.kind]}</span>
              <span>{event.state === 'failed' ? (zh ? '失败' : 'Failed') : event.state === 'skipped' ? (zh ? '已跳过' : 'Skipped') : event.state === 'started' ? (zh ? '已开始' : 'Started') : (zh ? '已返回' : 'Received')}</span>
            </div>
            <p className="mt-1 break-words text-xs font-medium text-foreground">{event.title}</p>
            <ExpandableText maxLines={4} className="mt-1 whitespace-pre-line break-words text-xs leading-6 text-foreground-secondary" expandLabel={zh ? '展开完整内容' : 'Show full content'} collapseLabel={zh ? '收起' : 'Collapse'}>{event.summary}</ExpandableText>
            {Boolean(event.refs?.length) && <div className="mt-1 flex flex-wrap gap-3">{event.refs!.map(ref => ref.anchorId && onNodeRefClick
              ? <Button key={ref.traceStepIndex} variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onNodeRefClick(ref.anchorId!)}>Trace #{ref.traceStepIndex}</Button>
              : <span key={ref.traceStepIndex} className="text-xs text-foreground-muted">Trace #{ref.traceStepIndex}</span>)}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
