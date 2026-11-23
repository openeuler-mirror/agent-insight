/* eslint-disable @typescript-eslint/no-explicit-any */
import { getAgentActiveDurationMs, type AgentNode } from './agent-trace';

export interface AgentNodeExecutionProjection {
    query: string;
    finalResult: string | null;
    model: string | null;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    latency: number | null;
    llmCallCount: number;
    toolCallCount: number;
    toolCallErrorCount: number;
}

export function interactionContentText(content: any): string {
    if (content == null) return '';
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                return interactionContentText(JSON.parse(trimmed));
            } catch {}
        }
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => interactionContentText(part?.text ?? part?.content ?? part))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'object') return interactionContentText(content.text ?? content.content ?? '');
    return String(content);
}

function isFailedAgentToolEvent(event: any): boolean {
    const calls = Array.isArray(event?.interaction?.tool_calls) ? event.interaction.tool_calls : [];
    const eventId = event?._toolCallId;
    const call = calls.find((item: any) => !eventId || item?.id === eventId);
    const state = String(call?.state || '').toLowerCase();
    if (state === 'error' || state === 'failed') return true;
    const output = event?.output ?? call?.output ?? call?.result;
    if (output && typeof output === 'object') {
        const status = String(output.status || output.state || '').toLowerCase();
        return status === 'error' || status === 'failed' || !!output.error;
    }
    if (typeof output === 'string' && output.trim().startsWith('{')) {
        try {
            return isFailedAgentToolEvent({ ...event, output: JSON.parse(output), interaction: undefined });
        } catch {}
    }
    return false;
}

function parsedToolArguments(call: any): Record<string, any> {
    const value = call?.function?.arguments ?? call?.arguments;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function findSubagentSpawnDescription(interactions: any[], sessionId: string): string | null {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    for (const interaction of interactions) {
        const calls = Array.isArray(interaction?.tool_calls) ? interaction.tool_calls : [];
        for (const call of calls) {
            const name = call?.function?.name ?? call?.name;
            if (name !== 'task') continue;
            const args = parsedToolArguments(call);
            const argSessionId = String(args.subagent_session_id ?? args.session_id ?? args.agent_session_id ?? '').trim();
            if (argSessionId !== sid) continue;
            const description = interactionContentText(args.description ?? args.task_description ?? args.prompt ?? args.subagent_type).trim();
            if (description) return description;
        }
    }
    return null;
}

export function findSubagentRoleName(
    node: AgentNode,
    interactions: Array<Record<string, unknown>>,
): string {
    for (const index of node.interactionIndices || []) {
        const role = interactions[index]?.subagent_name;
        if (typeof role === 'string' && role.trim()) return role.trim();
    }
    if (typeof node.subagentType === 'string' && node.subagentType.trim()) {
        return node.subagentType.trim();
    }
    return 'Codex subagent';
}

export function projectAgentNodeExecution(node: AgentNode, interactions: any[]): AgentNodeExecutionProjection {
    const ownTurns = (node.interactionIndices || []).map((index) => interactions[index]).filter(Boolean);
    const textTurns = ownTurns
        .map((interaction) => interactionContentText(interaction?.content).trim())
        .filter(Boolean);
    const query = textTurns[0] || node.agentName || node.sessionId;
    const llmEvents = (node.events || []).filter((event) => event.kind === 'llm');
    const meteredLlmEvents = llmEvents.filter((event) => {
        const usage = event.usage;
        return !!usage && ((usage.total || 0) > 0 || (usage.input || 0) > 0 || (usage.output || 0) > 0 || (usage.reasoning || 0) > 0);
    });
    const firstOwnIndex = node.interactionIndices?.[0];
    const fallbackLlmCalls = llmEvents.filter((event) =>
        event.interactionIndex !== firstOwnIndex &&
        (!!event.summary?.trim() || (event.interaction?.tool_calls?.length || 0) > 0)
    ).length;
    const toolEvents = (node.events || []).filter((event) =>
        event.kind === 'tool' || event.kind === 'skill' || event.kind === 'task'
    );
    const model = ownTurns
        .map((interaction) => interaction?.model ?? interaction?.modelID)
        .find((value) => typeof value === 'string' && value.trim()) || null;

    return {
        query,
        finalResult: textTurns.length > 1 ? textTurns[textTurns.length - 1]
            : meteredLlmEvents.map(event => interactionContentText(event.interaction?.content).trim()).filter(Boolean).at(-1) ?? null,
        model,
        tokens: node.stats.totalTokens,
        inputTokens: node.stats.inputTokens,
        outputTokens: node.stats.outputTokens,
        reasoningTokens: node.stats.reasoningTokens,
        cacheReadInputTokens: node.stats.cacheReadTokens,
        cacheCreationInputTokens: node.stats.cacheWriteTokens,
        // 与主记录 Execution.latency 统一为毫秒（此前派生子记录存的是秒，
        // 导致调用方无法区分单位，见 docs/tasks/bugs/issue-159-codex-open.md Bug 2）。
        latency: getAgentActiveDurationMs(node) ?? null,
        llmCallCount: meteredLlmEvents.length || fallbackLlmCalls,
        toolCallCount: toolEvents.length,
        toolCallErrorCount: toolEvents.filter(isFailedAgentToolEvent).length,
    };
}


export interface InvokedSkill {
    name: string;
    version: number | null;
}

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_\-\.]+$/;

function numericSemverMajor(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const semver = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim());
    return semver ? Number(semver[1]) : null;
}

export function extractExplicitSkillsFromNode(node: AgentNode): InvokedSkill[] {
    const seen = new Set<string>();
    const out: InvokedSkill[] = [];
    for (const ev of node.events || []) {
        if (ev.kind !== 'skill') continue;
        const a = (ev.args && typeof ev.args === 'object') ? ev.args : {};
        // Accept id only when the call-tree classifier resolved it as a Skill name.
        const idName = typeof a.id === 'string' && ev.name === a.id.trim() ? a.id : undefined;
        const rawName = a.name ?? a.skill_name ?? a.skillName ?? a.skill ?? idName;
        if (rawName == null || !String(rawName).trim()) continue;
        const s = String(rawName).trim().replace(/^['"]+|['"]+$/g, '');
        if (!SKILL_NAME_PATTERN.test(s) || seen.has(s)) continue;
        seen.add(s);
        const v = a.version != null ? Number(a.version) : null;
        out.push({ name: s, version: v !== null && !isNaN(v) ? v : numericSemverMajor(a.version) });
    }
    return out;
}
