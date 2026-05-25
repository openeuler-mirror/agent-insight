/**
 * 把 Session.interactions 压缩为评估器可读的步骤序列。
 * 复用 agent-trace 的 buildAgentCallTree → walkTree，沿用同一套 event 模型，
 * 但额外做长度截断以避免 LLM 上下文爆炸。
 */
import {
    buildAgentCallTree,
    walkTree,
    type AgentNode,
} from '@/lib/engine/observability/agent-trace';

export interface TraceStep {
    index: number;
    agent?: string;
    depth: number;
    kind: 'user' | 'llm' | 'tool' | 'skill' | 'task';
    name?: string;
    argsSummary?: string;
    outputSummary?: string;
    textContent?: string;
    durationMs?: number;
}

export interface TraceSummary {
    steps: TraceStep[];
    totalSteps: number;
    truncated: boolean;
    agentTreeDepth: number;
    totalLlmCalls: number;
    totalToolCalls: number;
    totalSkillCalls: number;
    totalTaskCalls: number;
    totalTokens: number;
    durationMs?: number;
    rootAgentName?: string;
}

export interface SummarizeOptions {
    maxSteps?: number;
    maxTextLen?: number;
}

const DEFAULT_MAX_STEPS = 80;
const DEFAULT_MAX_TEXT_LEN = 200;

export function summarizeTrace(interactions: any[], opts: SummarizeOptions = {}): TraceSummary {
    const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxTextLen = opts.maxTextLen ?? DEFAULT_MAX_TEXT_LEN;

    const tree: AgentNode | null = buildAgentCallTree(interactions);
    if (!tree) {
        return {
            steps: [],
            totalSteps: 0,
            truncated: false,
            agentTreeDepth: 0,
            totalLlmCalls: 0,
            totalToolCalls: 0,
            totalSkillCalls: 0,
            totalTaskCalls: 0,
            totalTokens: 0,
        };
    }

    const allSteps: TraceStep[] = [];
    let llm = 0;
    let toolCalls = 0;
    let skillCalls = 0;
    let taskCalls = 0;
    let depth = 0;
    let tokens = 0;
    let stepIdx = 0;

    walkTree(tree, n => {
        depth = Math.max(depth, n.depth);
        tokens += n.stats.totalTokens;
        for (const ev of n.events) {
            if (ev.kind === 'llm') llm++;
            else if (ev.kind === 'tool') toolCalls++;
            else if (ev.kind === 'skill') skillCalls++;
            else if (ev.kind === 'task') taskCalls++;

            const args = ev.args;
            const argsSummary = args === undefined || args === null
                ? undefined
                : (typeof args === 'string' ? args : safeJson(args)).slice(0, maxTextLen);
            const out = ev.output;
            const outputSummary = out === undefined || out === null
                ? undefined
                : (typeof out === 'string' ? out : safeJson(out)).slice(0, maxTextLen);
            const textContent = (ev.kind === 'user' || ev.kind === 'llm') && ev.summary
                ? ev.summary.slice(0, maxTextLen)
                : undefined;

            allSteps.push({
                index: stepIdx++,
                agent: n.depth > 0 ? n.agentName : undefined,
                depth: n.depth,
                kind: ev.kind,
                name: ev.name,
                argsSummary,
                outputSummary,
                textContent,
                durationMs: ev.completedAt && ev.startedAt ? ev.completedAt - ev.startedAt : undefined,
            });
        }
    });

    const totalSteps = allSteps.length;
    let truncated = false;
    let steps = allSteps;
    if (totalSteps > maxSteps) {
        truncated = true;
        const head = Math.ceil(maxSteps / 2);
        const tail = maxSteps - head;
        steps = allSteps.slice(0, head).concat(allSteps.slice(totalSteps - tail));
    }

    return {
        steps,
        totalSteps,
        truncated,
        agentTreeDepth: depth,
        totalLlmCalls: llm,
        totalToolCalls: toolCalls,
        totalSkillCalls: skillCalls,
        totalTaskCalls: taskCalls,
        totalTokens: tokens,
        durationMs: tree.stats.durationMs,
        rootAgentName: tree.agentName,
    };
}

export function formatTraceForLLM(summary: TraceSummary): string {
    const lines: string[] = [];
    lines.push(`# Trace Summary`);
    lines.push(`Root agent: ${summary.rootAgentName || 'Agent'}`);
    lines.push(
        `Total steps: ${summary.totalSteps} (LLM:${summary.totalLlmCalls} / Tool:${summary.totalToolCalls} / Skill:${summary.totalSkillCalls} / Task:${summary.totalTaskCalls})`,
    );
    lines.push(`Agent tree depth: ${summary.agentTreeDepth}`);
    lines.push(
        `Total tokens: ${summary.totalTokens}, Duration: ${summary.durationMs ?? '?'}ms`,
    );
    if (summary.truncated) {
        lines.push(
            `(NOTE: middle steps truncated; only showing first/last halves of ${summary.totalSteps} steps)`,
        );
    }
    lines.push('');
    lines.push(`# Steps (chronological)`);
    for (const s of summary.steps) {
        const parts: string[] = [`[#${s.index}]`];
        if (s.agent) parts.push(`@${s.agent}`);
        parts.push(`(${s.kind})`);
        if (s.name) parts.push(s.name);
        if (s.argsSummary) parts.push(`args=${s.argsSummary}`);
        if (s.outputSummary) parts.push(`out=${s.outputSummary}`);
        if (s.textContent) parts.push(`text=${s.textContent}`);
        if (s.durationMs !== undefined) parts.push(`${s.durationMs}ms`);
        lines.push(parts.join(' '));
    }
    return lines.join('\n');
}

function safeJson(v: any): string {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}
