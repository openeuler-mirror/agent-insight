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

import { formatDuration } from '@/lib/engine/observability/agent-trace';
import { getAgentNodeDisplayLabel } from '@/lib/engine/observability/agent-registration';
import type { AgentRelationStats } from '@/lib/trace/parent-agent';
import { cn } from '@/lib/utils';

export function AgentRelationCard({ agentName, subagentType, stats, durationBasisMs, onNavigate, onSelect, label, reported, locale }: {
    agentName: string;
    subagentType?: string | null;
    stats?: AgentRelationStats;
    durationBasisMs?: number;
    onNavigate?: () => void;
    onSelect?: () => void;
    label: string;
    reported?: boolean;
    locale?: string;
}) {
    const duration = stats?.durationMs;
    const tokens = stats?.totalTokens;
    const hasDuration = duration != null && Number.isFinite(duration) && duration >= 0;
    const hasTokens = tokens != null && Number.isFinite(tokens) && tokens >= 0;
    const slow = hasDuration && duration > 60_000;
    const pct = hasDuration && durationBasisMs != null && Number.isFinite(durationBasisMs) && durationBasisMs > 0
        ? Math.min(100, duration / durationBasisMs * 100) : null;
    const content = <>
        <span className="flex items-center gap-2">
            {hasDuration && <span aria-hidden className={cn('size-1.5 rounded-full shrink-0', slow ? 'bg-warning' : 'bg-foreground-muted')} />}
            <span className="flex-1 truncate text-sm font-medium">{getAgentNodeDisplayLabel(agentName, subagentType)}</span>
            <span className={cn('text-xs tabular-nums shrink-0 font-mono', slow ? 'text-warning' : 'text-foreground-muted')}>
                {hasDuration ? formatDuration(duration) : '—'}
            </span>
            <span className="text-xs text-foreground-muted tabular-nums shrink-0 font-mono">
                {hasTokens ? tokens.toLocaleString('en-US') : '—'}
            </span>
            {reported && <span className="text-xs text-foreground-muted">{locale === 'zh' ? '上报关联' : 'Reported relation'}</span>}
            {onNavigate && <span className="px-2 py-0.5 text-xs font-semibold tracking-wider rounded-sm border border-primary text-primary bg-primary/10 shrink-0">Trace</span>}
        </span>
        {pct !== null && <span className="block h-[3px] bg-background-tertiary rounded-sm overflow-hidden mt-1.5" aria-hidden>
            <span className={cn('block h-full rounded-sm', slow ? 'bg-warning' : 'bg-foreground-muted')} style={{ width: `${pct}%` }} />
        </span>}
    </>;
    const className = 'block w-full p-2 text-left rounded-md border border-border bg-background-secondary';
    const activate = onNavigate ?? onSelect;
    return activate ? <button type="button" onClick={activate} aria-label={label}
        className={cn(className, 'hover:bg-background-tertiary cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
        {content}
    </button> : <div className={className}>{content}</div>;
}
