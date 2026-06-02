'use client';

/**
 * 执行轨迹对齐 · Skill 预期标注 面板（共享组件）。
 *
 * 原先内联在 用例分析 ③「分析结果 → 展开分析细节」里，现抽出供 评测执行 → 轨迹评测
 * (TrajectoryDetailView) 复用。数据来自 analyze-match：matches / skippedExpectedSteps /
 * alignment / flowSteps / extractedSteps / mermaid。
 *
 * 样式复用 skill-analysis.css 里的 .sa-* 规则（全部 .sa- 前缀、无全局污染）；这些规则依赖
 * .sa-root 上定义的 --sa-* 主题变量，这里用包裹 div 的内联 CSS 变量提供，使面板脱离 .sa-root
 * 容器（如 /eval/trajectory 详情页）也能正确取色。
 */
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import '@/app/(main)/skill-eval/skill-analysis.css';

type Severity = 'high' | 'medium' | 'low';

interface MatchSummary {
    totalSteps?: number;
    matchedSteps?: number;
    partialSteps?: number;
    unexpectedSteps?: number;
    nonBusinessSteps?: number;
    skippedSteps?: number;
    orderViolations?: number;
    overallScore?: number;
}

interface ProblemStep {
    stepIndex?: number;
    stepName?: string;
    status?: 'partial' | 'unexpected' | 'non_business' | 'skipped';
    problem?: string;
    suggestion?: string;
}

interface StepMatch {
    expectedStepId?: string;
    expectedStepName?: string;
    actualStepIndex?: number;
    actualAction?: string;
    matchStatus: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business' | 'skipped';
    matchReason?: string;
}

interface SkippedExpectedStep {
    expectedStepId: string;
    expectedStepName: string;
}

interface FlowStep {
    id: string;
    name: string;
    description?: string;
    type?: 'action' | 'decision' | 'output';
}

interface ExtractedTraceStep {
    uiStepIndex?: number;
    name?: string;
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
    type?: 'action' | 'decision' | 'output';
}

interface AlignmentActualStep {
    index: number;
    action: string;
    type?: 'action' | 'decision' | 'output';
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
}

interface AlignmentMapping {
    actualStepIndex: number;
    expectedStepId?: string;
    expectedStepName?: string;
    status: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business';
    reason?: string;
}

interface AlignmentSkillSpan {
    skillName: string;
    version?: number;
    startActualStepIndex: number;
    endActualStepIndex: number;
    trigger?: 'primary' | 'invoked' | 'load_skill' | 'trace_tag' | 'subagent';
    expectedStepId?: string;
    expectedStepName?: string;
    evaluationStatus?: 'matched' | 'partial' | 'unexpected' | 'non_business';
    evaluationReason?: string;
}

interface AlignmentViolation {
    kind: 'partial' | 'unexpected' | 'non_business' | 'skipped' | 'order_violation' | 'tool_choice';
    actualStepIndex?: number;
    expectedStepId?: string;
    expectedStepName?: string;
    severity?: Severity;
    problem: string;
    suggestion?: string;
    evidenceInteractionIndexes?: number[];
}

interface TraceSkillAlignment {
    actualSteps?: AlignmentActualStep[];
    mappings?: AlignmentMapping[];
    skippedExpectedSteps?: SkippedExpectedStep[];
    skillSpans?: AlignmentSkillSpan[];
    violations?: AlignmentViolation[];
    summary?: MatchSummary;
}

export interface TraceAlignmentPanelProps {
    matches: StepMatch[];
    skippedExpectedSteps: SkippedExpectedStep[];
    problemByStepKey: Map<string, ProblemStep>;
    flowSteps: FlowStep[];
    extractedSteps: ExtractedTraceStep[];
    alignment?: TraceSkillAlignment;
    mermaidCode?: string;
}

// 取自 .sa-root 的 --sa-* 主题变量；通过包裹 div 内联提供，让面板脱离 .sa-root 也能取色。
const SA_VARS = {
    '--sa-bg': '#f4f4f5',
    '--sa-card': '#fff',
    '--sa-text': '#18181b',
    '--sa-secondary': '#52525b',
    '--sa-muted': '#71717a',
    '--sa-line': '#e4e4e7',
    '--sa-line-strong': '#d4d4d8',
    '--sa-primary': '#4f46e5',
    '--sa-primary-soft': '#eef2ff',
    '--sa-primary-line': '#c7d2fe',
    '--sa-success': '#16a34a',
    '--sa-success-soft': '#f0fdf4',
    '--sa-warning': '#d97706',
    '--sa-warning-soft': '#fffbeb',
    '--sa-error': '#dc2626',
    '--sa-error-soft': '#fef2f2',
    '--sa-teal': '#0891b2',
    '--sa-teal-soft': '#ecfeff',
    '--sa-purple': '#7c3aed',
    '--sa-purple-soft': '#f5f3ff',
} as React.CSSProperties;

// ────────────────────────────────────────────────────────────────────────
// 以下整块从 src/app/(main)/skill-eval/page.tsx 迁移（FlowBox … MermaidRenderer），
// 仅把对外入口 TraceAlignmentPanel 重命名为 TraceAlignmentPanelInner，逻辑零改动。
// ────────────────────────────────────────────────────────────────────────
function FlowBox({ title, subtitle, code }: { title: string; subtitle?: string; code?: string }) {
    return (
        <div className="sa-flow-box">
            <h4>{title}{subtitle && <small>{subtitle}</small>}</h4>
            <div className="sa-mermaid-wrap">
                {code ? <MermaidRenderer code={code} /> : <span>暂无流程图</span>}
            </div>
        </div>
    );
}

type AlignmentStatus = 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business' | 'skipped';

interface AlignmentNode {
    key: string;
    kind: 'actual' | 'skipped';
    status: AlignmentStatus;
    actualStepIndex?: number;
    actualAction?: string;
    expectedStepId?: string;
    expectedStepName?: string;
    expectedIndex?: number;
    reason?: string;
    problem?: string;
    suggestion?: string;
    extracted?: ExtractedTraceStep;
    violation?: AlignmentViolation;
    skillSpanLabels?: string[];
    evidenceInteractionIndexes?: number[];
}

const ALIGNMENT_STATUS_LABEL: Record<AlignmentStatus, string> = {
    matched: '符合预期',
    partial: '部分偏离',
    unexpected: '非预期调用',
    delegated: '子 Skill',
    non_business: '过渡操作',
    skipped: 'Skill 步骤缺失',
};

function TraceAlignmentPanelInner({
    matches,
    skippedExpectedSteps,
    problemByStepKey,
    flowSteps,
    extractedSteps,
    alignment,
    mermaidCode,
}: TraceAlignmentPanelProps) {
    const nodes = useMemo(
        () => alignment && Array.isArray(alignment.mappings) && alignment.mappings.length > 0
            ? buildAlignmentNodesFromStructuredAlignment(alignment, problemByStepKey, flowSteps, extractedSteps)
            : buildAlignmentNodes(matches, skippedExpectedSteps, problemByStepKey, flowSteps, extractedSteps),
        [alignment, matches, skippedExpectedSteps, problemByStepKey, flowSteps, extractedSteps],
    );
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [showRawFlow, setShowRawFlow] = useState(false);
    const selectedNode = nodes.find(node => node.key === selectedKey)
        || nodes.find(node => node.status !== 'matched' && node.status !== 'delegated' && node.status !== 'non_business')
        || nodes[0]
        || null;

    const counts = useMemo(() => ({
        matched: nodes.filter(node => node.kind === 'actual' && node.status === 'matched').length,
        partial: nodes.filter(node => node.kind === 'actual' && node.status === 'partial').length,
        unexpected: nodes.filter(node => node.kind === 'actual' && node.status === 'unexpected').length,
        delegated: nodes.filter(node => node.kind === 'actual' && node.status === 'delegated').length,
        nonBusiness: nodes.filter(node => node.kind === 'actual' && node.status === 'non_business').length,
        skipped: nodes.filter(node => node.kind === 'skipped').length,
        actualTotal: nodes.filter(node => node.kind === 'actual').length,
    }), [nodes]);
    const skillSpans = Array.isArray(alignment?.skillSpans)
        ? [...alignment.skillSpans].sort((a, b) => {
            if (a.trigger === 'primary' && b.trigger !== 'primary') return -1;
            if (a.trigger !== 'primary' && b.trigger === 'primary') return 1;
            return a.startActualStepIndex - b.startActualStepIndex;
        })
        : [];
    if (nodes.length === 0) {
        return (
            <div className="sa-alignment-empty">
                暂无可对齐步骤。可以点击右上角重试，生成实际执行步骤与 Skill 预期的匹配结果。
            </div>
        );
    }

    return (
        <div className="sa-alignment">
            <div className="sa-alignment-summary" aria-label="轨迹诊断摘要">
                <div className="sa-alignment-summary-main">
                    <b>{counts.actualTotal}</b>
                    <span>个实际步骤</span>
                </div>
                <div className="sa-alignment-metrics">
                    <AlignmentMetric status="matched" value={counts.matched} label="符合预期" />
                    <AlignmentMetric status="partial" value={counts.partial} label="部分偏离" />
                    <AlignmentMetric status="unexpected" value={counts.unexpected} label="非预期调用" />
                    <AlignmentMetric status="delegated" value={counts.delegated} label="子 Skill" />
                    <AlignmentMetric status="non_business" value={counts.nonBusiness} label="过渡操作" />
                    <AlignmentMetric status="skipped" value={counts.skipped} label="缺失步骤" />
                </div>
            </div>

            <div className="sa-alignment-body">
                <div className="sa-alignment-timeline" aria-label="执行轨迹对齐图">
                    {skillSpans.length > 0 && (
                        <div className="sa-align-span-summary">
                            {skillSpans.map((span, index) => (
                                <span key={`${span.skillName}-${index}`}>
                                    {formatSkillSpanLabel(span)}
                                    <small>步骤 #{span.startActualStepIndex} - #{span.endActualStepIndex}</small>
                                </span>
                            ))}
                        </div>
                    )}
                    {nodes.map((node, index) => (
                        <TraceAlignmentNode
                            key={node.key}
                            node={node}
                            position={index + 1}
                            selected={selectedNode?.key === node.key}
                            onSelect={() => setSelectedKey(node.key)}
                        />
                    ))}
                </div>
                <AlignmentDetail node={selectedNode} />
            </div>

            {mermaidCode && (
                <div className="sa-alignment-raw">
                    <button className="sa-mini-action" onClick={() => setShowRawFlow(v => !v)}>
                        {showRawFlow ? '收起原始流程图' : '查看原始流程图'}
                    </button>
                    {showRawFlow && (
                        <div className="sa-flow-grid single">
                            <FlowBox title="原始流程图" subtitle="保留用于排查与回退" code={mermaidCode} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function AlignmentMetric({ status, value, label }: { status: AlignmentStatus; value: number; label: string }) {
    return (
        <div className={`sa-alignment-metric ${status}`}>
            <b>{value}</b>
            <span>{label}</span>
        </div>
    );
}

function TraceAlignmentNode({
    node,
    position,
    selected,
    onSelect,
}: {
    node: AlignmentNode;
    position: number;
    selected: boolean;
    onSelect: () => void;
}) {
    const title = node.kind === 'skipped'
        ? node.expectedStepName || '未执行的 Skill 步骤'
        : node.actualAction || `实际步骤 #${node.actualStepIndex ?? position}`;
    const subtitle = node.kind === 'skipped'
        ? 'Skill 规定了该步骤，但实际轨迹没有覆盖'
        : node.status === 'delegated' && node.skillSpanLabels?.length
            ? `子 Skill：${node.skillSpanLabels.join('、')}，不参与主 Skill 内容匹配`
            : node.status === 'non_business'
            ? '上下文收集或流程衔接动作，不参与主 Skill 业务评分'
            : node.expectedStepName
            ? `对齐 Skill：${node.expectedStepName}`
            : '未匹配到 Skill 预期步骤';
    return (
        <button className={`sa-align-node ${node.status} ${selected ? 'selected' : ''}`} onClick={onSelect}>
            <span className="sa-align-rail">
                <span className="sa-align-dot">{statusGlyph(node.status)}</span>
            </span>
            <span className="sa-align-card">
                <span className="sa-align-card-head">
                    <span className="sa-align-index">
                        {node.kind === 'skipped' ? 'Skill' : `#${node.actualStepIndex ?? position}`}
                    </span>
                    <span className={`sa-align-status ${node.status}`}>{ALIGNMENT_STATUS_LABEL[node.status]}</span>
                    {node.skillSpanLabels?.map((label, index) => (
                        <span key={`${label}-${index}`} className="sa-align-skill-chip">{label}</span>
                    ))}
                </span>
                <b>{title}</b>
                <small>{subtitle}</small>
                {node.problem && <em>{node.problem}</em>}
            </span>
        </button>
    );
}

function AlignmentDetail({ node }: { node: AlignmentNode | null }) {
    if (!node) {
        return (
            <aside className="sa-align-detail">
                <b>步骤详情</b>
                <p>选择左侧步骤查看实际行为、Skill 预期和偏离建议。</p>
            </aside>
        );
    }

    return (
        <aside className={`sa-align-detail ${node.status}`}>
            <div className="sa-align-detail-head">
                <span className={`sa-align-status ${node.status}`}>{ALIGNMENT_STATUS_LABEL[node.status]}</span>
                <b>{node.kind === 'skipped' ? node.expectedStepName : node.actualAction}</b>
            </div>
            <dl>
                {node.actualStepIndex != null && (
                    <>
                        <dt>实际位置</dt>
                        <dd>Trace 步骤 #{node.actualStepIndex}</dd>
                    </>
                )}
                {node.expectedStepName && (
                    <>
                        <dt>Skill 预期</dt>
                        <dd>{node.expectedStepName}</dd>
                    </>
                )}
                {node.extracted?.description && (
                    <>
                        <dt>实际描述</dt>
                        <dd>{node.extracted.description}</dd>
                    </>
                )}
                {node.skillSpanLabels && node.skillSpanLabels.length > 0 && (
                    <>
                        <dt>Skill 区间</dt>
                        <dd>{node.skillSpanLabels.join('、')}</dd>
                    </>
                )}
                {node.problem && (
                    <>
                        <dt>偏离问题</dt>
                        <dd>{node.problem}</dd>
                    </>
                )}
                {node.suggestion && (
                    <>
                        <dt>建议</dt>
                        <dd>{node.suggestion}</dd>
                    </>
                )}
                {node.evidenceInteractionIndexes && node.evidenceInteractionIndexes.length > 0 && (
                    <>
                        <dt>证据位置</dt>
                        <dd>Trace 步骤 #{node.evidenceInteractionIndexes.join(', #')}</dd>
                    </>
                )}
            </dl>
        </aside>
    );
}

function buildAlignmentNodesFromStructuredAlignment(
    alignment: TraceSkillAlignment,
    problemByStepKey: Map<string, ProblemStep>,
    flowSteps: FlowStep[],
    extractedSteps: ExtractedTraceStep[],
): AlignmentNode[] {
    const mappings = Array.isArray(alignment.mappings) ? alignment.mappings : [];
    const actualSteps = Array.isArray(alignment.actualSteps) ? alignment.actualSteps : [];
    const skipped = Array.isArray(alignment.skippedExpectedSteps) ? alignment.skippedExpectedSteps : [];
    const violations = Array.isArray(alignment.violations) ? alignment.violations : [];
    const spans = Array.isArray(alignment.skillSpans) ? alignment.skillSpans : [];
    const expectedIndexById = new Map(flowSteps.map((step, index) => [step.id, index]));
    const actualByIndex = new Map(actualSteps.map(step => [step.index, step]));

    const nodes: AlignmentNode[] = mappings
        .slice()
        .sort((a, b) => a.actualStepIndex - b.actualStepIndex)
        .map((mapping, index) => {
            const actual = actualByIndex.get(mapping.actualStepIndex);
            const violation = findViolationForMapping(violations, mapping);
            const fallbackProblem = problemByStepKey.get(`actual:${mapping.actualStepIndex}`)
                || problemByStepKey.get(`name:${mapping.expectedStepName || ''}`)
                || problemByStepKey.get(`name:${actual?.action || ''}`);
            const extracted = actual
                ? {
                    name: actual.action,
                    description: actual.description,
                    dialogStartIndex: actual.dialogStartIndex,
                    dialogEndIndex: actual.dialogEndIndex,
                    type: actual.type,
                }
                : findExtractedStep(extractedSteps, mapping.actualStepIndex);
            return {
                key: `alignment-actual-${mapping.actualStepIndex}-${index}`,
                kind: 'actual',
                status: mapping.status,
                actualStepIndex: mapping.actualStepIndex,
                actualAction: actual?.action || `实际步骤 #${mapping.actualStepIndex}`,
                expectedStepId: mapping.expectedStepId,
                expectedStepName: mapping.expectedStepName,
                expectedIndex: mapping.expectedStepId ? expectedIndexById.get(mapping.expectedStepId) : undefined,
                reason: mapping.reason,
                problem: violation?.problem || fallbackProblem?.problem,
                suggestion: violation?.suggestion || fallbackProblem?.suggestion,
                extracted,
                violation,
                skillSpanLabels: spans
                    .filter(span => span.trigger !== 'primary' && mapping.actualStepIndex >= span.startActualStepIndex && mapping.actualStepIndex <= span.endActualStepIndex)
                    .map(formatSkillSpanLabel)
                    .filter((label, labelIndex, labels) => labels.indexOf(label) === labelIndex),
                evidenceInteractionIndexes: violation?.evidenceInteractionIndexes,
            };
        });

    const skippedNodes = skipped
        .slice()
        .sort((a, b) => (expectedIndexById.get(a.expectedStepId) ?? Number.MAX_SAFE_INTEGER) - (expectedIndexById.get(b.expectedStepId) ?? Number.MAX_SAFE_INTEGER))
        .map((step, index): AlignmentNode => {
            const violation = violations.find(v => v.kind === 'skipped' && (v.expectedStepId === step.expectedStepId || v.expectedStepName === step.expectedStepName));
            const fallbackProblem = problemByStepKey.get(`name:${step.expectedStepName}`);
            return {
                key: `alignment-skipped-${step.expectedStepId}-${index}`,
                kind: 'skipped',
                status: 'skipped',
                expectedStepId: step.expectedStepId,
                expectedStepName: step.expectedStepName,
                expectedIndex: expectedIndexById.get(step.expectedStepId),
                problem: violation?.problem || fallbackProblem?.problem,
                suggestion: violation?.suggestion || fallbackProblem?.suggestion,
                violation,
                evidenceInteractionIndexes: violation?.evidenceInteractionIndexes,
            };
        });

    return insertSkippedNodes(nodes, skippedNodes);
}

function buildAlignmentNodes(
    matches: StepMatch[],
    skippedExpectedSteps: SkippedExpectedStep[],
    problemByStepKey: Map<string, ProblemStep>,
    flowSteps: FlowStep[],
    extractedSteps: ExtractedTraceStep[],
): AlignmentNode[] {
    const expectedIndexById = new Map(flowSteps.map((step, index) => [step.id, index]));
    const actualNodes: AlignmentNode[] = matches
        .filter(match => match.matchStatus !== 'skipped')
        .slice()
        .sort((a, b) => (a.actualStepIndex ?? 0) - (b.actualStepIndex ?? 0))
        .map((match, index) => {
            const actualStepIndex = match.actualStepIndex ?? index;
            const problem = problemByStepKey.get(`actual:${match.actualStepIndex}`)
                || problemByStepKey.get(`name:${match.expectedStepName || ''}`)
                || problemByStepKey.get(`name:${match.actualAction}`);
            return {
                key: `actual-${actualStepIndex}-${index}`,
                kind: 'actual',
                status: match.matchStatus,
                actualStepIndex,
                actualAction: match.actualAction,
                expectedStepId: match.expectedStepId,
                expectedStepName: match.expectedStepName,
                expectedIndex: match.expectedStepId ? expectedIndexById.get(match.expectedStepId) : undefined,
                reason: match.matchReason,
                problem: problem?.problem,
                suggestion: problem?.suggestion,
                extracted: findExtractedStep(extractedSteps, actualStepIndex),
            };
        });

    const skippedNodes = skippedExpectedSteps
        .slice()
        .sort((a, b) => (expectedIndexById.get(a.expectedStepId) ?? Number.MAX_SAFE_INTEGER) - (expectedIndexById.get(b.expectedStepId) ?? Number.MAX_SAFE_INTEGER))
        .map((step, index): AlignmentNode => {
            const problem = problemByStepKey.get(`name:${step.expectedStepName}`);
            return {
                key: `skipped-${step.expectedStepId}-${index}`,
                kind: 'skipped',
                status: 'skipped',
                expectedStepId: step.expectedStepId,
                expectedStepName: step.expectedStepName,
                expectedIndex: expectedIndexById.get(step.expectedStepId),
                problem: problem?.problem,
                suggestion: problem?.suggestion,
            };
        });

    return insertSkippedNodes(actualNodes, skippedNodes);
}

function insertSkippedNodes(actualNodes: AlignmentNode[], skippedNodes: AlignmentNode[]) {
    const nodes: AlignmentNode[] = [...actualNodes];
    for (const skipped of skippedNodes) {
        if (skipped.expectedIndex == null) {
            nodes.push(skipped);
            continue;
        }
        const insertBefore = nodes.findIndex(node => node.expectedIndex != null && node.expectedIndex > skipped.expectedIndex!);
        if (insertBefore >= 0) {
            nodes.splice(insertBefore, 0, skipped);
            continue;
        }
        let insertAfter = -1;
        nodes.forEach((node, index) => {
            if (node.expectedIndex != null && node.expectedIndex <= skipped.expectedIndex!) insertAfter = index;
        });
        nodes.splice(insertAfter + 1, 0, skipped);
    }

    return nodes;
}

function findViolationForMapping(violations: AlignmentViolation[], mapping: AlignmentMapping) {
    return violations.find(violation => {
        if (violation.actualStepIndex != null && violation.actualStepIndex === mapping.actualStepIndex) return true;
        if (violation.expectedStepId && violation.expectedStepId === mapping.expectedStepId) return true;
        return !!violation.expectedStepName && violation.expectedStepName === mapping.expectedStepName;
    });
}

function formatSkillSpanLabel(span: AlignmentSkillSpan) {
    return span.version != null ? `${span.skillName} v${span.version}` : span.skillName;
}

function findExtractedStep(extractedSteps: ExtractedTraceStep[], actualStepIndex: number) {
    const byUiIndex = extractedSteps.find(step => step.uiStepIndex === actualStepIndex);
    if (byUiIndex) return byUiIndex;
    return extractedSteps.find(step => {
        const start = step.dialogStartIndex;
        const end = step.dialogEndIndex;
        return typeof start === 'number' && typeof end === 'number' && start <= actualStepIndex && end >= actualStepIndex;
    });
}

function statusGlyph(status: AlignmentStatus) {
    if (status === 'matched') return '✓';
    if (status === 'partial') return '!';
    if (status === 'unexpected') return '×';
    if (status === 'delegated') return 'S';
    if (status === 'non_business') return '~';
    return '−';
}

function MermaidRenderer({ code }: { code: string }) {
    const [svg, setSvg] = useState('');
    const [error, setError] = useState('');
    const [scale, setScale] = useState(1);
    const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [renderId] = useState(() => `sa-mermaid-${Math.random().toString(36).slice(2)}`);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const fullscreenViewportRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const fullscreenContentRef = useRef<HTMLDivElement | null>(null);
    const userAdjustedZoomRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        setSvg('');
        setError('');
        setScale(1);
        setBaseSize(null);
        userAdjustedZoomRef.current = false;
        import('mermaid')
            .then(mod => {
                const mermaid = mod.default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'base',
                    themeVariables: {
                        primaryColor: '#ffffff',
                        primaryTextColor: '#18181b',
                        primaryBorderColor: '#d4d4d8',
                        lineColor: '#71717a',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontSize: '12px',
                    },
                    flowchart: { curve: 'basis', padding: 8, nodeSpacing: 18, rankSpacing: 18 },
                });
                return mermaid.render(`${renderId}-${Date.now()}`, code);
            })
            .then(({ svg }) => {
                if (!cancelled) setSvg(svg);
            })
            .catch(() => {
                if (!cancelled) setError('流程图渲染失败');
            });
        return () => { cancelled = true; };
    }, [code]);

    const clampScale = useCallback((value: number) => Math.max(0.35, Math.min(2.5, value)), []);

    const fitScaleFor = useCallback((target: HTMLDivElement | null, width: number) => {
        if (!target || width <= 0) return 1;
        const available = Math.max(160, target.clientWidth - 24);
        return clampScale(available / width);
    }, [clampScale]);

    const measureSvg = useCallback((root: HTMLDivElement | null) => {
        const svgEl = root?.querySelector('svg');
        if (!svgEl) return null;
        const viewBox = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number);
        const width = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2])
            ? viewBox[2]
            : svgEl.getBoundingClientRect().width;
        const height = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3])
            ? viewBox[3]
            : svgEl.getBoundingClientRect().height;
        if (width <= 0 || height <= 0) return null;
        return { width, height };
    }, []);

    useEffect(() => {
        if (!svg) return;
        const frame = window.requestAnimationFrame(() => {
            const activeContent = fullscreen ? fullscreenContentRef.current : contentRef.current;
            const activeViewport = fullscreen ? fullscreenViewportRef.current : viewportRef.current;
            const measured = measureSvg(activeContent);
            if (!measured) return;
            setBaseSize(measured);
            if (!userAdjustedZoomRef.current) {
                setScale(fitScaleFor(activeViewport, measured.width));
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [fitScaleFor, fullscreen, measureSvg, svg]);

    useEffect(() => {
        if (!baseSize || !svg || userAdjustedZoomRef.current) return;
        const target = fullscreen ? fullscreenViewportRef.current : viewportRef.current;
        if (!target || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (!userAdjustedZoomRef.current) {
                setScale(fitScaleFor(target, baseSize.width));
            }
        });
        observer.observe(target);
        return () => observer.disconnect();
    }, [baseSize, fitScaleFor, fullscreen, svg]);

    useEffect(() => {
        if (!fullscreen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setFullscreen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [fullscreen]);

    const setZoom = useCallback((next: number) => {
        userAdjustedZoomRef.current = true;
        setScale(clampScale(Math.round(next * 100) / 100));
    }, [clampScale]);

    const fitWidth = useCallback((target: HTMLDivElement | null) => {
        if (!target || !baseSize?.width) return;
        userAdjustedZoomRef.current = true;
        setScale(fitScaleFor(target, baseSize.width));
    }, [baseSize, fitScaleFor]);

    const renderControls = (targetRef: React.RefObject<HTMLDivElement | null>, isFullscreen = false) => (
        <div className="sa-mermaid-tools" aria-label="流程图查看器工具栏">
            <button onClick={() => setZoom(scale - 0.1)} title="缩小">-</button>
            <button onClick={() => setZoom(scale + 0.1)} title="放大">+</button>
            <button onClick={() => setZoom(1)} title="恢复 100%">100%</button>
            <button onClick={() => fitWidth(targetRef.current)} title="适应宽度">适应宽度</button>
            {!isFullscreen && <button onClick={() => setFullscreen(true)} title="全屏查看">全屏</button>}
            <span>{Math.round(scale * 100)}%</span>
        </div>
    );

    const renderViewport = (
        targetRef: React.RefObject<HTMLDivElement | null>,
        targetContentRef: React.RefObject<HTMLDivElement | null>,
        isFullscreen = false,
    ) => (
        <>
            {renderControls(targetRef, isFullscreen)}
            <div className={`sa-mermaid-viewport ${isFullscreen ? 'fullscreen' : ''}`} ref={targetRef}>
                <div
                    className="sa-mermaid-stage"
                    style={{
                        width: baseSize ? `${baseSize.width * scale}px` : undefined,
                        height: baseSize ? `${baseSize.height * scale}px` : undefined,
                    }}
                >
                    <div
                        ref={targetContentRef}
                        className="sa-mermaid"
                        style={{
                            width: baseSize ? `${baseSize.width}px` : undefined,
                            height: baseSize ? `${baseSize.height}px` : undefined,
                            transform: `scale(${scale})`,
                        }}
                        dangerouslySetInnerHTML={{ __html: svg }}
                    />
                </div>
            </div>
        </>
    );

    if (error) return <span>{error}</span>;
    if (!svg) return <span>正在渲染流程图...</span>;
    return (
        <>
            {renderViewport(viewportRef, contentRef)}
            {fullscreen && (
                <div className="sa-mermaid-fullscreen" role="dialog" aria-modal="true" aria-label="流程图全屏查看器">
                    <div className="sa-mermaid-fullscreen-head">
                        <b>流程图查看器</b>
                        <button onClick={() => setFullscreen(false)}>关闭</button>
                    </div>
                    {renderViewport(fullscreenViewportRef, fullscreenContentRef, true)}
                </div>
            )}
        </>
    );
}


// 对外导出：包一层提供 --sa-* 变量，使面板脱离 .sa-root 容器也能正确取色。
export function TraceAlignmentPanel(props: TraceAlignmentPanelProps) {
    return (
        <div className="sa-alignment-embed" style={SA_VARS}>
            <TraceAlignmentPanelInner {...props} />
        </div>
    );
}
