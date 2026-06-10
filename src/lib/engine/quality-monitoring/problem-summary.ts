// problem-summary — 统一问题汇总（双源合并，FR-008/009/015 / BR-012/013 / DC-009）。
// 来源A 结构化错误：buildFaultPathSteps 重解析原始交互 → status==='error' 步 → (节点×错误码×对象) 聚类。
// 来源B 评测问题：failures(自由文本) + skillIssues + 低分/失败维度。
// 合并去重 → 影响度排序（频次×严重度/受影响维度）→ 帕累托。纯函数（交互由调用方注入）。

import { buildFaultPathSteps, type FaultPathStep } from '@/lib/engine/observability/fault-path';
import type { FailureItem } from '@/lib/engine/evaluation/judge';
import type { TraceLite, ProblemItem, Attribution, Severity, DimScore } from './types';

const SEV_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function clip(s: string, n = 80): string {
    const t = (s ?? '').trim().replace(/\s+/g, ' ');
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ── 归因映射 ────────────────────────────────────────────────────────────────
const ATTR_INFRA = /(timeout|超时|connection|connect|ECONN|网络|network|503|502|unavailable|infra|限流|rate.?limit)/i;
const ATTR_MODEL = /(parse|解析|json|格式|hallucinat|幻觉|输出|format|schema|model)/i;
const ATTR_INPUT = /(not found|不存在|路径|path|ENOENT|404|invalid input|输入|权限不足|permission|file)/i;
const ATTR_AGENT = /(loop|死循环|步数|step|plan|规划|retry|重复|逻辑|越界)/i;

function attributionFor(blob: string, explicit?: string): Attribution {
    if (explicit) {
        const e = explicit.toUpperCase();
        if (e.includes('SKILL')) return 'agent逻辑';
        if (e.includes('MODEL')) return '模型能力';
        if (e.includes('ENVIRON')) return '工具&infra';
    }
    if (ATTR_INFRA.test(blob)) return '工具&infra';
    if (ATTR_INPUT.test(blob)) return '外部输入';
    if (ATTR_MODEL.test(blob)) return '模型能力';
    if (ATTR_AGENT.test(blob)) return 'agent逻辑';
    return 'agent逻辑';
}

// ── 节点 / 错误码 / 对象 抽取（BR-012 结构化键） ─────────────────────────────
const NODE_LABEL: Record<string, string> = {
    tool: '工具调用', tool_call: '工具调用', toolUse: '工具调用',
    llm: 'LLM 推理', model: 'LLM 推理', reasoning: 'LLM 推理',
    plan: '规划', planning: '规划', agent: '规划',
    retrieval: '检索', system: '系统', user: '输入',
};
function nodeLabel(kind: string): string {
    return NODE_LABEL[kind] ?? (kind ? `${kind}` : '混合');
}

const ERR_CODE_PATTERNS: [RegExp, string][] = [
    [/timeout|超时|timed?\s*out/i, '工具超时'],
    [/ENOENT|not found|不存在/i, '对象不存在'],
    [/JSON|parse|解析失败|unexpected token/i, '输出解析失败'],
    [/invalid|校验|validation|参数|argument/i, '参数校验失败'],
    [/permission|denied|unauthorized|越权|未授权/i, '权限/越权'],
    [/loop|死循环|max.?steps|步数超限/i, '死循环/步数超限'],
    [/rate.?limit|限流|429/i, '限流'],
    [/5\d{2}|server error|internal error/i, '服务端错误'],
];
function errorCodeOf(step: FaultPathStep): string {
    const blob = `${step.name} ${step.meta} ${step.rawOutput ?? ''}`;
    for (const [re, code] of ERR_CODE_PATTERNS) if (re.test(blob)) return code;
    // 兜底不再截原始文本当错误码（会产出垃圾簇名）；同对象的未分类错误并为一簇。
    return '未分类错误';
}
// fault-path 的步骤 name 多为语义标签（"工具调用/模型调用/执行 Skill"），真实对象藏在 meta 里：
// tool → `${toolName} ${args}`、skill → `skill ${name}`、task → `spawn ${type}`、llm → `${provider} · req…`。
const GENERIC_STEP_NAMES = new Set([
    '工具调用', 'Tool call', '模型调用', 'Model call', '执行 Skill', 'Run skill',
    '调度子任务', 'Dispatch subtask', '用户输入', 'User input', '控制器路由', 'Controller routing',
]);

/** 错误对象：优先具体的 step.name；语义标签步从 meta 抽真实对象名；最后 toolCallId 兜底。 */
function objectOf(step: FaultPathStep): string {
    const name = (step.name ?? '').trim();
    if (name && name.length <= 48 && !GENERIC_STEP_NAMES.has(name)) return name;
    const metaTokens = (step.meta ?? '').trim().split(/[\s·]+/).filter(Boolean);
    if (metaTokens[0] === 'skill' || metaTokens[0] === 'spawn') return clip(metaTokens[1] ?? metaTokens[0], 48);
    if (metaTokens[0]) return clip(metaTokens[0], 48);
    return step.toolCallId ?? '—';
}

// 注意：现有 buildFaultPathSteps 不产出 status==='error'（仅 ok/skipped），错误需从步骤内容判定。
const ERROR_SIGNAL = /(error|errno|failed|failure|失败|异常|exception|timed?\s*out|超时|denied|拒绝|not\s*found|不存在|unauthorized|未授权|invalid|无法|cannot|traceback|stack\s*trace|\b[45]\d{2}\b)/i;
/**
 * 某步是否为错误步：显式 error 状态 或 内容命中错误信号。
 * 关键区分：LLM 步骤的 rawOutput 是模型的自然语言输出——"谈论失败"≠"步骤失败"
 * （日志分析类 agent 的正常回答里全是 error/失败 字样），故 LLM 步只看结构化元信息；
 * 工具/技能/任务步的 rawOutput 才是工具返回值，命中错误信号即视为失败。
 */
export function isErrorStep(step: FaultPathStep): boolean {
    if (step.status === 'error') return true;
    if (step.kind === 'user' || step.kind === 'agent' || step.kind === 'system') return false;
    const blob = step.kind === 'llm'
        ? `${step.meta ?? ''} ${step.name ?? ''}`
        : `${step.meta ?? ''} ${step.name ?? ''} ${step.rawOutput ?? ''}`;
    return ERROR_SIGNAL.test(blob);
}

function severityFromCount(count: number): Severity {
    if (count >= 8) return 'high';
    if (count >= 3) return 'medium';
    return 'low';
}

export interface ProblemSummaryInput {
    traces: TraceLite[];
    /** executionId 或 taskId → 原始 interactions（调用方注入；缺失则跳过结构化解析并计覆盖率）。 */
    interactionsByTrace?: Map<string, unknown[]>;
}

export interface ProblemSummaryResult {
    problems: ProblemItem[];            // 未排序（rankProblems 统一排序/帕累托）
    errorSummary: { errorEventCount: number; errorTraceCount: number; clusterCount: number };
    errorNodeDistribution: { node: string; count: number; pct: number }[];
}

interface Cluster {
    key: string; node: string; errorCode: string; object: string;
    count: number; traces: Set<string>; attribution: Attribution;
}

/** 把（executionId → 错误步）聚成 (节点×错误码×对象) 簇。导出供单测。 */
export function clusterErrorSteps(
    perTrace: { executionId: string; steps: FaultPathStep[] }[],
): { clusters: Cluster[]; errorTraces: Set<string>; eventCount: number } {
    const clusters = new Map<string, Cluster>();
    const errorTraces = new Set<string>();
    let eventCount = 0;
    for (const { executionId, steps } of perTrace) {
        for (const step of steps) {
            if (!isErrorStep(step)) continue;
            eventCount++;
            errorTraces.add(executionId);
            const node = nodeLabel(step.kind);
            const errorCode = errorCodeOf(step);
            const object = objectOf(step);
            const key = `${node}×${errorCode}×${object}`;
            const c = clusters.get(key) ?? {
                key, node, errorCode, object, count: 0, traces: new Set<string>(),
                attribution: attributionFor(`${errorCode} ${object} ${step.meta} ${step.rawOutput ?? ''}`),
            };
            c.count++;
            c.traces.add(executionId);
            clusters.set(key, c);
        }
    }
    return { clusters: [...clusters.values()], errorTraces, eventCount };
}

/** 来源A：从原始交互重解析 → 结构化错误事件聚类。 */
function clusterStructuredErrors(input: ProblemSummaryInput): { clusters: Cluster[]; errorTraces: Set<string>; eventCount: number } {
    const map = input.interactionsByTrace;
    if (!map) return { clusters: [], errorTraces: new Set(), eventCount: 0 };

    const perTrace: { executionId: string; steps: FaultPathStep[] }[] = [];
    for (const t of input.traces) {
        const interactions = map.get(t.executionId) ?? (t.taskId ? map.get(t.taskId) : undefined);
        if (!interactions || !Array.isArray(interactions) || !interactions.length) continue;
        try { perTrace.push({ executionId: t.executionId, steps: buildFaultPathSteps(interactions, 'zh') }); }
        catch { /* 交互缺失/解析失败 → 跳过，计入覆盖率 */ }
    }
    return clusterErrorSteps(perTrace);
}

/** 来源B：评测问题（failures 自由文本 + skillIssues）。 */
function evalProblems(traces: TraceLite[]): ProblemItem[] {
    // failures 按 failure_type 归并
    const byType = new Map<string, { desc: string; traces: Set<string>; count: number; attr: Attribution }>();
    for (const t of traces) {
        for (const f of (t.failures ?? []) as (FailureItem & { attribution?: string })[]) {
            const type = (f.failure_type || f.description || '未分类失败').toString();
            const key = clip(type, 48);
            const e = byType.get(key) ?? {
                desc: clip(f.description || type, 80), traces: new Set<string>(), count: 0,
                attr: attributionFor(`${type} ${f.description ?? ''} ${f.context ?? ''}`, f.attribution),
            };
            e.count++; e.traces.add(t.executionId);
            byType.set(key, e);
        }
    }
    const out: ProblemItem[] = [];
    for (const [key, e] of byType) {
        out.push({
            key: `eval:fail:${key}`, desc: e.desc, source: '评测',
            affectedDimensions: ['结果'], frequency: e.count, severity: severityFromCount(e.count),
            attribution: e.attr, relatedTraces: [...e.traces], impact: 0,
        });
    }

    // skillIssues（确定是 Skill 问题的项）
    const bySkill = new Map<string, { desc: string; traces: Set<string>; count: number; fix?: string }>();
    for (const t of traces) {
        for (const s of t.skillIssues ?? []) {
            if (s.is_skill_issue === false) continue;
            const desc = clip(s.content || s.explanation || 'Skill 问题', 80);
            const key = `skill:${clip(s.content || s.id || desc, 48)}`;
            const e = bySkill.get(key) ?? { desc, traces: new Set<string>(), count: 0, fix: s.improvement_suggestion };
            e.count++; e.traces.add(t.executionId);
            bySkill.set(key, e);
        }
    }
    for (const [key, e] of bySkill) {
        out.push({
            key, desc: e.desc, source: '评测',
            affectedDimensions: ['过程'], frequency: e.count, severity: severityFromCount(e.count),
            attribution: 'agent逻辑', relatedTraces: [...e.traces], impact: 0, suggestedFix: e.fix,
        });
    }
    return out;
}

export function buildProblemSummary(input: ProblemSummaryInput): ProblemSummaryResult {
    const { clusters, errorTraces, eventCount } = clusterStructuredErrors(input);

    const errorProblems: ProblemItem[] = clusters.map((c) => ({
        key: `err:${c.key}`,
        // 描述带上对象名：同错误码不同对象是不同簇（如 参数校验失败 · todowrite vs · file_read），
        // 否则列表里看起来像重复项。
        desc: c.object && c.object !== '—' ? `${c.errorCode} · ${clip(c.object, 32)}` : c.errorCode,
        source: '错误',
        affectedDimensions: c.node === 'LLM 推理' ? ['结果', '过程'] : ['过程'],
        frequency: c.count,
        severity: severityFromCount(c.count),
        attribution: c.attribution,
        relatedTraces: [...c.traces],
        impact: 0,
        node: c.node,
    }));

    const problems = [...errorProblems, ...evalProblems(input.traces)];

    // 节点分布（FR-009）
    const nodeCount = new Map<string, number>();
    for (const c of clusters) nodeCount.set(c.node, (nodeCount.get(c.node) ?? 0) + c.count);
    const totalNode = [...nodeCount.values()].reduce((a, b) => a + b, 0) || 1;
    const errorNodeDistribution = [...nodeCount.entries()]
        .map(([node, count]) => ({ node, count, pct: Math.round((count / totalNode) * 100) }))
        .sort((a, b) => b.count - a.count);

    return {
        problems,
        errorSummary: { errorEventCount: eventCount, errorTraceCount: errorTraces.size, clusterCount: clusters.length },
        errorNodeDistribution,
    };
}

/** 由四维分追加「低分/失败维度」评测问题（编排序：score 之后）。 */
export function lowScoreProblems(dims: { result: DimScore; process: DimScore; cost: DimScore }, statusFloor: number): ProblemItem[] {
    const out: ProblemItem[] = [];
    const entries: [string, DimScore, Attribution][] = [
        ['结果', dims.result, '模型能力'],
        ['过程', dims.process, 'agent逻辑'],
        ['成本', dims.cost, '工具&infra'],
    ];
    for (const [name, d, attr] of entries) {
        if (d.coverage <= 0 || d.score >= statusFloor) continue;
        // 频次取"缺口质量"≈ 受拖累 trace 数（n × 距达标线的差距），而非原始样本量，
        // 避免维度级问题仅凭样本量恒压过具体错误簇。
        const deficit = Math.max(1, Math.round(d.n * (statusFloor - d.score) / 100));
        out.push({
            key: `dim:${name}`,
            desc: `${name}维偏弱（${d.score}）${d.signal ? '：' + d.signal : ''}`,
            source: '评测',
            affectedDimensions: [name],
            frequency: deficit,
            severity: d.status === '异常' ? 'high' : 'medium',
            attribution: attr,
            relatedTraces: [],
            impact: 0,
        });
    }
    return out;
}

/** 统一排序 + 帕累托（影响度 = 频次×严重度/受影响维度，BR-013）。 */
export function rankProblems(problems: ProblemItem[]): ProblemItem[] {
    const withImpact = problems.map((p) => ({
        ...p,
        impact: Math.round((p.frequency * SEV_WEIGHT[p.severity]) / Math.max(1, p.affectedDimensions.length) * 10) / 10,
    }));
    withImpact.sort((a, b) => b.impact - a.impact || b.frequency - a.frequency);
    const totalFreq = withImpact.reduce((s, p) => s + p.frequency, 0) || 1;
    let cum = 0;
    for (const p of withImpact) {
        cum += p.frequency;
        p.cumulativePct = Math.round((cum / totalFreq) * 100);
    }
    return withImpact;
}
