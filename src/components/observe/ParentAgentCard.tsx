'use client';

import { Button } from '@/components/ui/button';
import { getAgentNodeDisplayLabel } from '@/lib/engine/observability/agent-registration';
import type { ParentAgentReference } from '@/lib/trace/parent-agent';

export function ParentAgentCard({ parent, onNavigate, locale }: {
    parent: ParentAgentReference | null;
    onNavigate?: (taskId: string) => void;
    locale: string;
}) {
    if (!parent) return null;
    const zh = locale === 'zh';
    const messages = {
        pending: zh ? '等待父 Trace' : 'Waiting for parent Trace',
        ambiguous: zh ? '父 Agent 关系存在冲突' : 'Conflicting parent Agent relationships',
        unavailable: zh ? '父 Agent 信息暂不可用' : 'Parent Agent temporarily unavailable',
    };
    return (
        <section aria-label={zh ? '父 Agent' : 'Parent Agent'}>
            <h4 className="mb-2 text-xs font-semibold text-foreground-muted">{zh ? '父 Agent' : 'Parent Agent'}</h4>
            <div className="flex items-center gap-2 rounded-md border border-border bg-background-secondary p-2">
                {parent.state === 'resolved' ? <>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{getAgentNodeDisplayLabel(parent.agentName)}</span>
                    {parent.framework && <span className="text-xs text-foreground-muted">{parent.framework}</span>}
                    {onNavigate && <Button type="button" variant="outline" size="sm"
                        className="h-6 border-primary px-2 text-xs text-primary"
                        title={zh ? '打开父 Agent 的 Trace' : 'Open parent Agent Trace'}
                        onClick={() => onNavigate(parent.taskId)}>
                        Trace
                    </Button>}
                </> : <span role="status" className="text-sm text-foreground-muted">{messages[parent.state]}</span>}
            </div>
        </section>
    );
}
