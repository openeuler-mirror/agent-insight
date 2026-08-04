import {
    langfuseSubagentSessionId,
    normalizeLangfuseRequestMessages,
    type LangfuseTraceNode,
} from '@/lib/ingest/otel/adapters/langfuse-trace';
import type {
    AgentEvent,
    AgentNode,
    AgentNodeStats,
    InteractionUsage,
    RawInteraction,
} from './agent-trace';

export interface LangfuseAgentTraceProjection {
    tree: AgentNode | null;
    interactions: RawInteraction[];
}

function emptyStats(): AgentNodeStats {
    return {
        interactions: 0,
        llmCalls: 0,
        toolCalls: 0,
        skillCalls: 0,
        taskCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        durationMs: undefined,
    };
}

function makeAgentNode(
    id: string,
    agentName: string,
    sessionId: string,
    parentId: string | null,
): AgentNode {
    return {
        id,
        agentName,
        subagentType: parentId ? agentName : null,
        sessionId,
        parentId,
        events: [],
        children: [],
        stats: emptyStats(),
        depth: 0,
        interactionIndices: [],
    };
}

function hasContent(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function contentText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function llmOutputText(value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const content = (value as Record<string, unknown>).content;
        if (content != null) return contentText(content);
    }
    return contentText(value);
}

function llmOutputToolCalls(value: unknown): NonNullable<RawInteraction['tool_calls']> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const output = value as Record<string, unknown>;
    const additional = output.additional_kwargs && typeof output.additional_kwargs === 'object' && !Array.isArray(output.additional_kwargs)
        ? output.additional_kwargs as Record<string, unknown>
        : undefined;
    const calls = Array.isArray(output.tool_calls)
        ? output.tool_calls
        : Array.isArray(additional?.tool_calls)
            ? additional.tool_calls
            : [];
    return calls.flatMap(call => {
        if (!call || typeof call !== 'object' || Array.isArray(call)) return [];
        const item = call as Record<string, unknown>;
        const fn = item.function && typeof item.function === 'object' && !Array.isArray(item.function)
            ? item.function as Record<string, unknown>
            : undefined;
        const name = String(item.name ?? fn?.name ?? '').trim();
        if (!name) return [];
        const rawArgs = item.args ?? item.arguments ?? fn?.arguments;
        const args = typeof rawArgs === 'string'
            ? rawArgs
            : rawArgs == null
                ? ''
                : JSON.stringify(rawArgs);
        return [{
            id: typeof item.id === 'string' ? item.id : undefined,
            type: typeof item.type === 'string' ? item.type : 'tool_call',
            function: { name, arguments: args },
        }];
    });
}

type RequestMessage = NonNullable<RawInteraction['requestMessages']>[number];

function comparableRequestMessage(message: RequestMessage): string {
    const role = String(message.role || 'user').toLowerCase();
    const content = contentText(message.content).trim();
    const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map(comparableToolCall).filter(Boolean).join('\u0001')
        : '';
    return `${role}\u0000${content}\u0000${toolCalls}\u0000${message.tool_call_id || ''}`;
}

function comparableToolCall(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const call = value as Record<string, unknown>;
    const fn = call.function && typeof call.function === 'object' && !Array.isArray(call.function)
        ? call.function as Record<string, unknown>
        : undefined;
    const name = String(call.name ?? fn?.name ?? '').trim();
    const rawArgs = call.args ?? call.arguments ?? fn?.arguments;
    let args = rawArgs;
    if (typeof rawArgs === 'string') {
        try {
            args = JSON.parse(rawArgs);
        } catch {
            args = rawArgs;
        }
    }
    return `${name}\u0000${typeof args === 'string' ? args : JSON.stringify(args ?? null)}`;
}

export function langfusePromptHistoryCount(
    current: RequestMessage[],
    previous: RequestMessage[] = [],
    previousResponse = '',
    previousToolCalls: unknown[] = [],
): number {
    if (current.length === 0) return 0;
    if (previous.length > 0) {
        const completedPrevious = [...previous];
        if (previousResponse.trim() || previousToolCalls.length > 0) {
            completedPrevious.push({
                role: 'assistant',
                content: previousResponse,
                ...(previousToolCalls.length ? { tool_calls: previousToolCalls } : {}),
            });
        }
        let repeated = 0;
        const max = Math.min(completedPrevious.length, current.length);
        while (
            repeated < max
            && comparableRequestMessage(completedPrevious[repeated]) === comparableRequestMessage(current[repeated])
        ) {
            repeated++;
        }
        if (repeated > 0) return repeated;
    }

    let currentStart = current.length - 1;
    while (currentStart >= 0 && String(current[currentStart].role || '').toLowerCase() === 'system') {
        currentStart--;
    }
    if (currentStart < 0) return current.length;
    const lastRole = String(current[currentStart].role || '').toLowerCase();
    if (lastRole === 'tool') {
        while (currentStart > 0 && String(current[currentStart - 1].role || '').toLowerCase() === 'tool') {
            currentStart--;
        }
    }
    return currentStart;
}

function userMessageText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const message = value as Record<string, unknown>;
    const role = String(message.role ?? message.type ?? '').toLowerCase();
    if (role !== 'user' && role !== 'human') return undefined;
    return typeof message.content === 'string' && message.content.trim()
        ? message.content.trim()
        : undefined;
}

function lastUserMessage(value: unknown, depth = 0): string | undefined {
    if (value == null || depth > 8) return undefined;
    const direct = userMessageText(value);
    if (direct) return direct;
    if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
            const found = userMessageText(value[index]) || lastUserMessage(value[index], depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof value !== 'object') return undefined;
    const object = value as Record<string, unknown>;
    for (const key of ['history', 'messages']) {
        const found = lastUserMessage(object[key], depth + 1);
        if (found) return found;
    }
    for (const [key, child] of Object.entries(object)) {
        if (key === 'history' || key === 'messages') continue;
        const found = lastUserMessage(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}

function namedQuestion(value: unknown, depth = 0): string | undefined {
    if (value == null || depth > 8 || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = namedQuestion(child, depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    const object = value as Record<string, unknown>;
    for (const key of ['question', 'query', 'user_input', 'userInput', 'prompt', 'input']) {
        const candidate = object[key];
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const child of Object.values(object)) {
        const found = namedQuestion(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}

export function extractLangfuseUserQuestion(nodes: LangfuseTraceNode[]): string | undefined {
    const ordered = [...nodes].sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
    const rootInputs = ordered.filter(node => !node.sourceParentSpanId).map(node => node.input);
    for (const input of rootInputs) {
        const found = lastUserMessage(input) || namedQuestion(input);
        if (found) return found;
    }
    for (const node of ordered) {
        if (node.kind !== 'llm') continue;
        const found = lastUserMessage(node.input) || namedQuestion(node.input);
        if (found) return found;
    }
    return undefined;
}

function usageFromNode(node: LangfuseTraceNode): InteractionUsage | undefined {
    if (!node.usage) return undefined;
    const input = node.usage.inputTokens || 0;
    const output = node.usage.outputTokens || 0;
    const reasoning = node.usage.reasoningTokens || 0;
    const total = node.usage.totalTokens ?? input + output + reasoning;
    if (!input && !output && !reasoning && !total) return undefined;
    return { input, output, reasoning, total };
}

function updateNodeBounds(host: AgentNode, startedAt: number, completedAt: number) {
    if (!host.startedAt || startedAt < host.startedAt) host.startedAt = startedAt;
    if (!host.endedAt || completedAt > host.endedAt) host.endedAt = completedAt;
}

function addUsage(host: AgentNode, usage: InteractionUsage | undefined) {
    if (!usage) return;
    host.stats.inputTokens += usage.input || 0;
    host.stats.outputTokens += usage.output || 0;
    host.stats.reasoningTokens += usage.reasoning || 0;
    host.stats.cacheReadTokens += usage.cache?.read || 0;
    host.stats.cacheWriteTokens += usage.cache?.write || 0;
    host.stats.totalTokens += usage.total || 0;
}

function finalizeNode(node: AgentNode, depth: number) {
    node.depth = depth;
    node.events.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.interactionIndex - b.interactionIndex);
    node.children.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
    for (const child of node.children) finalizeNode(child, depth + 1);
    if (node.startedAt != null && node.endedAt != null) {
        node.stats.durationMs = Math.max(0, node.endedAt - node.startedAt);
    }
}

/**
 * Projects Langfuse observations into the established AgentTraceView model.
 * Visibility and wrapper collapsing are decided by the Langfuse adapter; this
 * layer only translates visible observations and never matches business names.
 */
export function buildLangfuseAgentTrace(
    sourceNodes: LangfuseTraceNode[],
    rootSessionId?: string,
): LangfuseAgentTraceProjection {
    const nodes = sourceNodes
        .filter(node => node.visibility === 'visible')
        .sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
    if (nodes.length === 0) return { tree: null, interactions: [] };

    const nodeBySpanId = new Map(nodes.map(node => [node.spanId, node]));
    const firstRoot = nodes.find(node => !node.displayParentSpanId) || nodes[0];
    const root = firstRoot.kind === 'agent'
        ? makeAgentNode(`lf-agent-${firstRoot.spanId}`, firstRoot.name, firstRoot.spanId, null)
        : makeAgentNode(`lf-root-${firstRoot.traceId}`, firstRoot.name || 'Langfuse', firstRoot.traceId, null);
    const agentBySpanId = new Map<string, AgentNode>();
    if (firstRoot.kind === 'agent') agentBySpanId.set(firstRoot.spanId, root);

    for (const observation of nodes) {
        if (observation.kind !== 'agent' || agentBySpanId.has(observation.spanId)) continue;
        const sessionId = observation.subagentSessionId
            || (rootSessionId ? langfuseSubagentSessionId(rootSessionId, observation.spanId) : observation.spanId);
        agentBySpanId.set(
            observation.spanId,
            makeAgentNode(`lf-agent-${observation.spanId}`, observation.name, sessionId, root.id),
        );
    }

    const nearestAgent = (observation: LangfuseTraceNode): AgentNode => {
        let parentId = observation.displayParentSpanId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const agent = agentBySpanId.get(parentId);
            if (agent) return agent;
            parentId = nodeBySpanId.get(parentId)?.displayParentSpanId || null;
        }
        return root;
    };

    for (const observation of nodes) {
        if (observation.kind !== 'agent' || observation.spanId === firstRoot.spanId) continue;
        const child = agentBySpanId.get(observation.spanId)!;
        const parent = nearestAgent(observation);
        child.parentId = parent.id;
        child.subagentType = observation.name;
        parent.children.push(child);
    }

    const interactions: RawInteraction[] = [];
    const addInteraction = (host: AgentNode, interaction: RawInteraction): number => {
        const index = interactions.push(interaction) - 1;
        host.interactionIndices.push(index);
        return index;
    };

    const addObservationEvent = (
        host: AgentNode,
        observation: LangfuseTraceNode,
        spawnedChildId?: string,
    ) => {
        const usage = usageFromNode(observation);
        const requestMessages = observation.kind === 'llm'
            ? normalizeLangfuseRequestMessages(observation.input)
            : [];
        const outputToolCalls = observation.kind === 'llm'
            ? llmOutputToolCalls(observation.output)
            : [];
        const interaction: RawInteraction = {
            role: observation.kind === 'tool' ? 'opencode' : 'assistant',
            content: observation.kind === 'llm' ? llmOutputText(observation.output) : contentText(observation.output),
            timestamp: observation.startedAt,
            timeInfo: { created: observation.startedAt, completed: observation.completedAt },
            agent: host.agentName,
            model: observation.model,
            usage,
            ...(requestMessages.length ? { requestMessages } : {}),
            ...(outputToolCalls.length ? { tool_calls: outputToolCalls } : {}),
        };
        const interactionIndex = addInteraction(host, interaction);
        const kind: AgentEvent['kind'] = observation.kind === 'llm'
            ? 'llm'
            : observation.kind === 'tool'
                ? 'tool'
                : observation.kind === 'chain' || observation.kind === 'span'
                    ? 'chain'
                    : 'task';
        const visibleParent = observation.displayParentSpanId
            ? nodeBySpanId.get(observation.displayParentSpanId)
            : undefined;
        const parentSourceSpanId = visibleParent
            && visibleParent.kind !== 'agent'
            && nearestAgent(visibleParent).id === host.id
            ? visibleParent.spanId
            : undefined;
        const event: AgentEvent = {
            kind,
            name: observation.name,
            args: observation.input,
            output: observation.output,
            toolCallId: observation.toolCallId || observation.spanId,
            toolStatus: observation.status,
            startedAt: observation.startedAt,
            completedAt: observation.completedAt,
            interaction,
            interactionIndex,
            spawnedChildId,
            sourceSpanId: observation.spanId,
            parentSourceSpanId,
            treeHidden: observation.kind === 'agent' && !!spawnedChildId,
            summary: observation.name,
            usage,
        };
        host.events.push(event);
        host.stats.interactions++;
        if (kind === 'llm') host.stats.llmCalls++;
        else if (kind === 'tool') host.stats.toolCalls++;
        else if (spawnedChildId && observation.kind !== 'agent') host.stats.taskCalls++;
        addUsage(host, usage);
        updateNodeBounds(host, observation.startedAt, observation.completedAt);
    };

    const userQuestion = extractLangfuseUserQuestion(nodes);
    if (userQuestion) {
        const interaction: RawInteraction = {
            role: 'user',
            content: userQuestion,
            timestamp: firstRoot.startedAt,
            timeInfo: { created: firstRoot.startedAt, completed: firstRoot.startedAt },
            agent: root.agentName,
        };
        const interactionIndex = addInteraction(root, interaction);
        root.events.push({
            kind: 'user',
            interaction,
            interactionIndex,
            startedAt: firstRoot.startedAt,
            completedAt: firstRoot.startedAt,
            summary: userQuestion,
        });
        root.stats.interactions++;
    }

    for (const observation of nodes) {
        if (observation.kind === 'agent') {
            const agent = agentBySpanId.get(observation.spanId)!;
            updateNodeBounds(agent, observation.startedAt, observation.completedAt);
            if (agent !== root) addObservationEvent(nearestAgent(observation), observation, agent.id);
            else if (hasContent(observation.input) || hasContent(observation.output)) addObservationEvent(agent, observation);
            continue;
        }
        addObservationEvent(nearestAgent(observation), observation);
    }

    const overallStart = Math.min(...nodes.map(node => node.startedAt));
    const overallEnd = Math.max(...nodes.map(node => node.completedAt));
    updateNodeBounds(root, overallStart, overallEnd);
    finalizeNode(root, 0);
    return { tree: root, interactions };
}
