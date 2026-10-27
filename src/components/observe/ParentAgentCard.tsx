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

import { AgentRelationCard } from './AgentRelationCard';
import type { ParentAgentReference } from '@/lib/trace/parent-agent';

export function ParentAgentCard({ parent, onNavigate, locale }: {
    parent: ParentAgentReference | null;
    onNavigate?: (taskId: string) => void;
    locale: string;
}) {

    const zh = locale === 'zh';
    const messages = {
        pending: zh ? '等待父 Trace' : 'Waiting for parent Trace',
        ambiguous: zh ? '父 Agent 关系存在冲突' : 'Conflicting parent Agent relationships',
        unavailable: zh ? '父 Agent 信息暂不可用' : 'Parent Agent temporarily unavailable',
    };
    return (
        <section aria-label={zh ? '父 Agent' : 'Parent Agent'}>
            <h4 className="mb-2 text-xs font-semibold text-foreground-muted">{zh ? '父 Agent' : 'Parent Agent'}</h4>
            {parent?.state === 'resolved' ? <AgentRelationCard
                agentName={parent.agentName}
                stats={parent.stats}
                reported={parent.reported}
                locale={locale}
                durationBasisMs={parent.stats?.durationMs}
                onNavigate={onNavigate ? () => onNavigate(parent.taskId) : undefined}
                label={zh ? '打开父 Agent 的 Trace' : 'Open parent Agent Trace'}
            /> : <div className="rounded-md border border-border bg-background-secondary p-2">
                <span role="status" className="text-sm text-foreground-muted">{parent ? messages[parent.state] : zh ? '无父 Trace' : 'No parent Trace'}</span>
            </div>}
        </section>
    );
}
