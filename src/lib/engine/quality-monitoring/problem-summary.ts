// problem-summary — 统一问题汇总（双源合并，FR-008/009/015 / BR-012/013 / DC-009）。
// 来源A 结构化错误：buildFaultPathSteps 重解析原始交互 → status==='error' 步 → (节点×错误码×对象) 聚类。
// 来源B 评测问题：failures(自由文本) + skillIssues + 低分/失败维度。
// 合并去重 → 影响度排序（频次×严重度/受影响维度）→ 帕累托。纯函数（交互由调用方注入）。

import { buildFaultPathSteps, type FaultPathStep } from '@/lib/engine/observability/fault-path';
import type { FailureItem } from '@/lib/engine/evaluation/judge';
import type { TraceLite, ProblemItem, Attribution, Severity, DimScore, SkillDragItem, DiagnosisLite } from './types';

/** SkillIssue 表行的精简投影（由编排层 join Evaluation.executionId∈T 加载，只取未解决的）。 */
export interface SkillIssueRowLite {
    dedupKey: string;
    severity: string;                 // 'high' | 'medium' | 'low'（表内为自由字符串，解析时容错）
    summary: string;
    suggestedFix?: string | null;
    category?: string | null;         // '轨迹偏差' | '工具误用' | '关键观点遗漏' | ...
    skillName: string;
    version: number | null;
    executionId?: string | null;
}

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
    /** SkillIssue 表行（未解决，已 scope 到 T）；缺省退化为仅用 Execution.skillIssues JSON 快照。 */
    skillIssueRows?: SkillIssueRowLite[];
    /** executionId → 诊断根因摘要（join AgentDebugReport，status=done）；缺省不做诊断增强。 */
    diagnosesByTrace?: Map<string, DiagnosisLite>;
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
            affectedDimensions: ['过程'], frequency: e.count, severity: severityFromCount(e.count),
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

function parseSeverity(s: string | null | undefined): Severity {
    return s === 'high' || s === 'medium' || s === 'low' ? s : 'medium';
}

/**
 * 来源B'：SkillIssue 表（按 dedupKey 聚合 = 同一问题跨评测的身份键）。
 * 相比 Execution.skillIssues JSON 快照：有真实严重度、suggestedFix、生命周期(只取未解决)、skill 归属。
 */
export function tableSkillIssueProblems(rows: SkillIssueRowLite[]): ProblemItem[] {
    const byKey = new Map<string, {
        rows: SkillIssueRowLite[]; traces: Set<string>;
    }>();
    for (const r of rows) {
        const key = `${r.skillName}@${r.version ?? 0}:${r.dedupKey}`;
        const e = byKey.get(key) ?? { rows: [], traces: new Set<string>() };
        e.rows.push(r);
        if (r.executionId) e.traces.add(r.executionId);
        byKey.set(key, e);
    }
    const out: ProblemItem[] = [];
    for (const [key, e] of byKey) {
        const first = e.rows[0];
        // 严重度取簇内最高（prevalence 抬升的完整逻辑在 skill-issues 引擎，这里取保守近似）
        const sev = e.rows.map((r) => parseSeverity(r.severity))
            .sort((a, b) => SEV_WEIGHT[b] - SEV_WEIGHT[a])[0];
        out.push({
            key: `skilltbl:${key}`,
            desc: clip(first.summary, 80),
            source: '评测',
            affectedDimensions: ['过程'],
            frequency: e.rows.length,                  // T 范围内的 prevalence
            severity: sev,
            attribution: 'agent逻辑',                   // skill 问题定义上归 agent 逻辑，路由到 skill-opt
            relatedTraces: [...e.traces],
            impact: 0,
            suggestedFix: first.suggestedFix ?? undefined,
            skillRef: { name: first.skillName, version: first.version },
        });
    }
    return out;
}

/** Skill 拖累榜：按 skill@version 聚合未解决问题，回答「哪个 skill 在拖累这个 Agent」。 */
export function buildSkillDrag(rows: SkillIssueRowLite[], traces: TraceLite[]): SkillDragItem[] {
    const bySkill = new Map<string, { name: string; version: number | null; dedup: Map<string, Severity>; traces: Set<string> }>();
    for (const r of rows) {
        const key = `${r.skillName}@${r.version ?? 0}`;
        const e = bySkill.get(key) ?? { name: r.skillName, version: r.version, dedup: new Map<string, Severity>(), traces: new Set<string>() };
        const sev = parseSeverity(r.severity);
        const prev = e.dedup.get(r.dedupKey);
        if (!prev || SEV_WEIGHT[sev] > SEV_WEIGHT[prev]) e.dedup.set(r.dedupKey, sev);
        if (r.executionId) e.traces.add(r.executionId);
        bySkill.set(key, e);
    }
    const n = traces.length || 1;
    const out: SkillDragItem[] = [];
    for (const e of bySkill.values()) {
        // 受影响面：优先按 invokedSkills 匹配；评测覆盖的 executionId 兜底（两者口径取大）
        const invoked = traces.filter((t) => t.invokedSkills?.some((s) => s.name === e.name)).length;
        const affectedTraces = Math.max(invoked, e.traces.size);
        const sevSum = [...e.dedup.values()].reduce((s, sev) => s + SEV_WEIGHT[sev], 0);
        const topSeverity = [...e.dedup.values()].sort((a, b) => SEV_WEIGHT[b] - SEV_WEIGHT[a])[0] ?? 'low';
        out.push({
            name: e.name,
            version: e.version,
            unresolved: e.dedup.size,
            topSeverity,
            affectedTraces,
            affectedPct: Math.round((affectedTraces / n) * 100),
            dragScore: Math.round(sevSum * 10) / 10,
        });
    }
    return out.sort((a, b) => b.dragScore - a.dragScore);
}

/** 诊断 triage 分类 / 根因模块 → 责任归因（诊断信号优先级高于文本规则）。 */
function attributionOfDiagnosis(d: DiagnosisLite): Attribution {
    if (d.category === 'infra' || d.category === 'tool_systemic') return '工具&infra';
    switch (d.module) {
        case 'planning': case 'memory': case 'reflection': return 'agent逻辑';
        case 'action': case 'system': return '工具&infra';
        default: return 'agent逻辑';
    }
}

/**
 * 诊断增强（簇 × 根因交叉校验）：对每个错误簇看簇内已诊断成员——
 * 多数模块一致 → 写入 rootCauseModule 并把归因从"文本规则猜的"升级为"诊断投票的"；
 * 簇没有 suggestedFix 时用诊断的修复指引补上。纯函数，导出供单测。
 */
export function applyDiagnoses(problems: ProblemItem[], diagnoses: Map<string, DiagnosisLite>): void {
    if (!diagnoses.size) return;
    for (const p of problems) {
        if (p.source !== '错误' || !p.relatedTraces.length) continue;
        const ds = p.relatedTraces
            .map((id) => diagnoses.get(id))
            .filter((d): d is DiagnosisLite => Boolean(d));
        if (!ds.length) continue;
        p.diagnosedTraces = ds.length;
        const votes = new Map<string, number>();
        for (const d of ds) votes.set(d.module, (votes.get(d.module) ?? 0) + 1);
        const [topModule, topCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
        p.rootCauseModule = topModule;
        if (topCount * 2 >= ds.length) p.attribution = attributionOfDiagnosis(ds.find((d) => d.module === topModule)!);
        if (!p.suggestedFix) {
            const g = ds.find((d) => d.guidance)?.guidance;
            if (g) p.suggestedFix = clip(g, 120);
        }
    }
}

/** 根因模块分布 + 诊断覆盖（T 全量视角，供右栏指纹条与"去诊断"调度）。纯函数。 */
export function summarizeDiagnoses(traces: TraceLite[], diagnoses: Map<string, DiagnosisLite>): {
    moduleFingerprint: { module: string; count: number; pct: number }[];
    diagnosisCoverage: { diagnosed: number; errorish: number };
} {
    const errorish = traces.filter((t) => (t.toolCallErrorCount ?? 0) > 0 || (t.failures?.length ?? 0) > 0).length;
    const counts = new Map<string, number>();
    let diagnosed = 0;
    for (const t of traces) {
        const d = diagnoses.get(t.executionId);
        if (!d) continue;
        diagnosed++;
        counts.set(d.module, (counts.get(d.module) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    const moduleFingerprint = [...counts.entries()]
        .map(([module, count]) => ({ module, count, pct: Math.round((count / total) * 100) }))
        .sort((a, b) => b.count - a.count);
    return { moduleFingerprint, diagnosisCoverage: { diagnosed, errorish } };
}

export function buildProblemSummary(input: ProblemSummaryInput): ProblemSummaryResult {
    const { clusters, errorTraces, eventCount } = clusterStructuredErrors(input);

    const errorProblems: ProblemItem[] = clusters.map((c) => ({
        key: `err:${c.key}`,
        // 描述带上对象名：同错误码不同对象是不同簇（如 参数校验失败 · todowrite vs · file_read），
        // 否则列表里看起来像重复项。
        desc: c.object && c.object !== '—' ? `${c.errorCode} · ${clip(c.object, 32)}` : c.errorCode,
        source: '错误',
        affectedDimensions: ['过程'],
        frequency: c.count,
        severity: severityFromCount(c.count),
        attribution: c.attribution,
        relatedTraces: [...c.traces],
        impact: 0,
        node: c.node,
    }));

    // 评测来源双轨：SkillIssue 表级聚合（真实严重度/suggestedFix/skill 归属/生命周期）优先，
    // Execution.skillIssues/failures JSON 快照补充；同描述跨源去重，表级胜出。
    const normDesc = (s: string) => clip(s, 48).toLowerCase();
    const tableItems = tableSkillIssueProblems(input.skillIssueRows ?? []);
    const tableDescs = new Set(tableItems.map((p) => normDesc(p.desc)));
    const jsonItems = evalProblems(input.traces).filter((p) => !tableDescs.has(normDesc(p.desc)));

    // 诊断增强：错误簇 × 已诊断成员的根因模块交叉校验（归因升级 + 修复指引补全）
    if (input.diagnosesByTrace) applyDiagnoses(errorProblems, input.diagnosesByTrace);

    const problems = [...errorProblems, ...tableItems, ...jsonItems];

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

/** 由过程/成本低分追加问题（编排序：score 之后）。 */
export function lowScoreProblems(dims: { process: DimScore; cost: DimScore }, statusFloor: number): ProblemItem[] {
    const out: ProblemItem[] = [];
    const entries: [string, DimScore, Attribution][] = [
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
