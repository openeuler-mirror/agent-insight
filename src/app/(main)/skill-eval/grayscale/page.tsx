'use client';

import React, { useState, useEffect, Suspense, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/shell/PageHeader';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { MetricValue } from '@/components/text/MetricValue';
import { History, Play, ExternalLink, Plus } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { calculateAbScoring, DEFAULT_AB_SCORING_POLICY, type AbScoringResult, type AbScoreBreakdown, type AbTone } from '@/lib/skill-analysis/ab-scoring';
import {
    buildGrayscaleTraceCase,
    findLatestRunnableRunIndex,
} from '@/lib/skill-analysis/grayscale-utils';
import { NewEvaluationBatchDialog, type NewBatchCreated } from '@/components/eval/NewEvaluationBatchDialog';
import '../debug.css';
import '../skill-analysis.css';
import './hifi.css';

export default function GrayscalePage() {
    return (
        <Suspense fallback={null}>
            <GrayscalePageInner />
        </Suspense>
    );
}

interface SkillOption {
    id: string;
    name: string;
}

interface SkillVersionOption {
    id: string;
    version: number;
    semanticVersion?: string;
    isCurrent?: boolean;
}

interface TraceRecord {
    upload_id?: string;
    task_id?: string;
    query?: string;
    skills?: unknown;
    timestamp?: string;
    timeCost?: string;
    framework?: string;
    dataset_id?: string;
    dataset_name?: string;
}

type EvaluationCaseItem = {
    id: string;
    input: string;
    datasetName: string;
    datasetId: string;
    sourceType?: 'dataset' | 'trace';
    sourceExecutionSessionId?: string;
    sourceUploadId?: string;
    sourceDatasetId?: string;
    sourceDatasetName?: string;
};

interface GrayscaleTask {
    id: string;
    user: string;
    skillId?: string;
    skillName?: string;
    skillVersion?: number;
    skillVersionId?: string;
    taskName: string;
    createdAt: string;
    configJson?: {
        skillId?: string;
        versionAId?: string;
        versionBId?: string;
        sourceMode?: 'dataset' | 'trace';
        queryMode?: 'manual' | 'dataset';
        runCount?: number;
        repeatRounds?: number;
        agentMaxConcurrency?: number;
        autoEval?: boolean;
        recordTriggerDetails?: boolean;
        evaluatorId?: string;
        evaluators?: string[];
        latestResultAt?: string;
        query?: string;
        selectedDatasetId?: string;
        selectedCaseId?: string;
        selectedCaseIds?: string[];
        taskDescription?: string;
        linkedDatasetIds?: string[];
        checkedCaseIds?: string[];
        traceTimeRange?: '1d' | '3d' | '7d';
        selectedTraceAId?: string;
        selectedTraceBId?: string;
        // 关联到「评测执行」页的批次 ID (evaluatorRunId)。任务级配置: 用户通过
        // 配置卡顶部「+ 新增评测任务」对话框创建一个空批次后, 把 ID 写回这里。
        // 后续启动评测时 (action='start' / 'evaluate' / retry-eval) 透传给
        // /api/eval/trajectory/run 作 evaluatorRunId append, 让所有评测落到同一批次。
        evaluationBatchId?: string;
        // 同步存批次的可读名 + 评估器列表 (冗余存储, 用于 UI 显示, 避免每次查 /eval 接口)
        evaluationBatchTitle?: string;
        evaluationBatchEvaluators?: string[];
    };
    caseStatesJson?: Record<string, { a: PerVersionState; b: PerVersionState }>;
    activeRun?: {
        taskId: string;
        runId: string;
        status: 'running' | 'evaluating';
        startedAt: number;
    } | null;
}

type ScoreTier = 'good' | 'warn' | 'poor';

interface PerVersionState {
    status: CaseStatus;
    jobId?: string;
    evaluatorRunId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
    tier?: ScoreTier;
    evaluations?: RunEvaluation[];
    runs?: RunResult[];
    runCount?: number;
    traceIds?: string[];
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
}

interface RunResult {
    status: CaseStatus;
    jobId?: string;
    evaluatorRunId?: string;
    evaluationResultId?: string;
    evaluationTraceId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
    tier?: ScoreTier;
    evaluations?: RunEvaluation[];
    runIndex: number;
    roundIndex?: number;
    caseId?: string;
    traceIds?: string[];
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
    // backend 写过来的失败元数据 (agent 执行失败时填); modal 用它跟 evaluator
    // 失败区分, retry 时也要清掉防止下次显示残留错误
    failureType?: string;
    failureDetail?: string;
    completedAt?: string;
}

type RunEvaluationStatus = 'pending' | 'running' | 'done' | 'failed';

interface RunEvaluation {
    evaluatorId: string;
    evaluatorName: string;
    status: RunEvaluationStatus;
    evaluatorRunId?: string;
    evaluationResultId?: string;
    evaluationTraceId?: string;
    score?: number;
    errorMessage?: string;
}

function scoreTierFromComposite(score: number): ScoreTier {
    return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'poor';
}

function buildRunConfigSignature(config: {
    skillId: string;
    versionAId: string;
    versionBId: string;
    sourceMode: 'dataset' | 'trace';
    selectedDatasetId: string;
    linkedDatasetIds: string[];
    selectedTraceAId: string;
    selectedTraceBId: string;
    repeatRounds: number;
    agentMaxConcurrency: number;
    autoEval: boolean;
    recordTriggerDetails: boolean;
    evaluatorIds: string[];
    caseIds: string[];
}) {
    return JSON.stringify({
        skillId: config.skillId,
        versionAId: config.versionAId,
        versionBId: config.versionBId,
        sourceMode: config.sourceMode,
        selectedDatasetId: config.selectedDatasetId,
        linkedDatasetIds: [...config.linkedDatasetIds].sort(),
        selectedTraceAId: config.selectedTraceAId,
        selectedTraceBId: config.selectedTraceBId,
        repeatRounds: config.repeatRounds,
        agentMaxConcurrency: config.agentMaxConcurrency,
        autoEval: config.autoEval,
        recordTriggerDetails: config.recordTriggerDetails,
        evaluatorIds: [...config.evaluatorIds].sort(),
        caseIds: [...config.caseIds].sort(),
    });
}

function hasRunningCaseStates(states: Record<string, { a: PerVersionState; b: PerVersionState }>) {
    return Object.values(states).some(s =>
        ([s.a, s.b] as PerVersionState[]).some(state =>
            state.status === 'running'
            || state.status === 'evaluating'
            || (state.runs || []).some(run => run.status === 'running' || run.status === 'evaluating')
        )
    );
}

function hasPendingAutoEvaluationCaseStates(states: Record<string, { a: PerVersionState; b: PerVersionState }>) {
    return Object.values(states).some(s =>
        ([s.a, s.b] as PerVersionState[]).some(state =>
            (state.runs || []).some(run =>
                run.status === 'executed'
                && Boolean(run.sessionId)
                && !run.evaluatorRunId
                && typeof run.score !== 'number'
            )
        )
    );
}

type CaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

// 状态徽章中文映射，对齐"用例分析"卡的术语（✓已评测 / 评测中 / ⚠评测失败 等），
// 给 A/B 执行记录 modal 用。颜色风格也跟 trace 行的徽章对齐。
//
// 注: A/B 任务有「执行 + 评测」两个阶段, 单一 CaseStatus 字段实际表达的是
// 两阶段串起来的当前位置。renderExecutionRecordSection 把它拆成两个徽章
// 分别展示（执行: 排队/执行中/✓完成/⚠失败, 评测: 待评测/评测中/✓已评测/⚠失败）,
// 让用户一眼看清是哪一步挂了。
type BadgeTone = 'pending' | 'running' | 'done' | 'fail';
const BADGE_TONE: Record<BadgeTone, { bg: string; fg: string; pulse?: boolean; icon?: string }> = {
    pending: { bg: 'rgba(100,116,139,.10)', fg: '#475569' },
    running: { bg: 'rgba(37,99,235,.10)',   fg: '#2563EB', pulse: true },
    done:    { bg: 'rgba(22,163,74,.10)',   fg: '#15803D', icon: '✓' },
    fail:    { bg: 'rgba(220,38,38,.10)',   fg: '#B91C1C', icon: '⚠' },
};

// 带 1s 延迟关闭的 hover tooltip——鼠标移开 trigger 后还有 1s 时间能移进 tooltip
// 里复制错误信息。tooltip 内部 user-select:text + cursor:text。
function HoverTooltip({ trigger, content }: { trigger: React.ReactNode; content: string | React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelClose = () => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    const scheduleClose = () => {
        cancelClose();
        timerRef.current = setTimeout(() => setOpen(false), 1000);
    };
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
    return (
        <span
            style={{ position: 'relative', display: 'inline-block' }}
            onMouseEnter={() => { cancelClose(); setOpen(true); }}
            onMouseLeave={scheduleClose}
        >
            {trigger}
            {open && (
                <div
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        marginTop: 6,
                        zIndex: 50,
                        background: '#1F2937',
                        color: '#F9FAFB',
                        padding: '10px 12px',
                        borderRadius: 6,
                        fontSize: 11,
                        lineHeight: 1.5,
                        maxWidth: 480,
                        minWidth: 240,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        userSelect: 'text',
                        cursor: 'text',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    }}
                >
                    {content}
                </div>
            )}
        </span>
    );
}

// inline 文字状态: 给 session id 列在"还没拿到 id 时"占位用。
// pending/running 时 prefix 加个圆点 + 动效, 跟 trace 卡 pending 徽章观感一致。
function StatusText({ label, tone }: { label: string; tone: BadgeTone }) {
    const cfg = BADGE_TONE[tone];
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            fontWeight: 600,
            color: cfg.fg,
            whiteSpace: 'nowrap',
        }}>
            {cfg.pulse && (
                <span style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'currentColor',
                    animation: 'pulse 1.5s ease-in-out infinite',
                }} />
            )}
            {cfg.icon && <span>{cfg.icon}</span>}
            {label}
        </span>
    );
}

// Card 3「综合判定 & 决策」的主体。设计目标：一屏内同时看到决策结论、三维分数,
// 以及每个分数的计算路径。布局分三段:
//   ① 决策横条—— DECISION 标签 + 决策名 + 综合分(min 短板)；中间一句话写"短板在哪 /
//      关键证据 / 下一步动作";右侧保留 [查看 Trace]。
//   ② 维度表 ——能力/成本/稳定性三行。分数列 mono+tabular-nums,带 50/75 阈值刻度。
//      关键证据列只罗列与判定最相关的几个数(评测均分 / ΔToken / 触发率 等)。
//   ③ "原始数据与计算公式"折叠面板——展开后是四个 mini panel(能力/成本/稳定性/综合),
//      每个里面 A vs B 原始值 + 公式代入式,直接覆盖"分数怎么来的"那条溯源链。
// 公式与术语唯一对齐 docs/skill-ab-scoring.md(v2.1);UI 用到的所有数字都从 abScoring.*
// 拿,不重新计算,避免与算法实现漂移。
function DecisionVerdictCard({
    decisionReady,
    abScoring,
    sampleSize,
    repeatRounds,
    recommendedSampleSize,
    policy,
    decisionTitle,
    decisionAdvice,
    onViewTrace,
    locale,
    toneColor,
    toneBg,
}: {
    decisionReady: boolean;
    abScoring: AbScoringResult;
    sampleSize: number;
    repeatRounds: number;
    recommendedSampleSize: number;
    policy: typeof DEFAULT_AB_SCORING_POLICY;
    decisionTitle: string;
    decisionAdvice: string;
    onViewTrace: () => void;
    locale: 'zh' | 'en';
    toneColor: (tone: AbTone) => string;
    toneBg: (tone: AbTone) => string;
}) {
    // 决策态: reject → 红, direct-release → 绿, monitor-release → 琥珀, insufficient → 灰
    const decisionTone: AbTone = !decisionReady || abScoring.decision === 'insufficient'
        ? 'gray'
        : abScoring.decision === 'reject'
            ? 'red'
            : abScoring.decision === 'direct-release'
                ? 'green'
                : 'amber';
    const decisionColor = toneColor(decisionTone);
    const decisionBg = toneBg(decisionTone);

    // 短板维度: 拒绝时直接看 rejectCategory; 其它时看三维 min。null 表示不出短板提示。
    const shortDim: 'capability' | 'cost' | 'stability' | null = (() => {
        if (!decisionReady) return null;
        if (abScoring.rejectCategory) return abScoring.rejectCategory;
        if (abScoring.totalScore == null) return null;
        const s = [
            { key: 'capability' as const, v: abScoring.capability.score },
            { key: 'cost' as const,       v: abScoring.cost.score },
            { key: 'stability' as const,  v: abScoring.stability.score },
        ].filter(x => x.v != null) as Array<{ key: 'capability' | 'cost' | 'stability'; v: number }>;
        if (s.length === 0) return null;
        return s.sort((a, b) => a.v - b.v)[0].key;
    })();
    const dimLabel = (k: 'capability' | 'cost' | 'stability') => k === 'capability' ? '能力' : k === 'cost' ? '成本' : '稳定性';
    const dimTone = (k: 'capability' | 'cost' | 'stability') =>
        k === 'capability' ? abScoring.capability.tone
        : k === 'cost' ? abScoring.cost.tone
        : abScoring.stability.tone;

    // 描述文本一句话写清:「短板在 X · 关键证据」+「下一步 ...」+ 样本量提示(如果不足)
    const evidenceText: string = (() => {
        if (!decisionReady) return '';
        if (shortDim === 'capability') {
            const a = abScoring.capability.avgEvalScoreA;
            const b = abScoring.capability.avgEvalScoreB;
            const d = abScoring.capability.deltaScore;
            const hit = abScoring.hardGates.find(g => g.key === 'capability');
            const pieces: string[] = [];
            if (a != null && b != null) pieces.push(`评测均分由 ${a} → ${b}`);
            if (d != null) pieces.push(`Δ ${d > 0 ? '+' : ''}${d}`);
            if (hit) pieces.push(`命中 hard gate (< ${policy.capabilityRejectThreshold})`);
            return pieces.join(', ');
        }
        if (shortDim === 'cost') {
            const dToken = abScoring.cost.deltaTokenPct;
            const dDur = abScoring.cost.deltaDurationPct;
            const cap = abScoring.capability.score;
            const coupling = cap == null ? 0 : cap >= policy.capabilityGoodThreshold ? policy.costCouplingBonus : cap < policy.capabilityRejectThreshold ? -policy.costCouplingPenalty : 0;
            const pieces: string[] = [];
            if (dToken != null) pieces.push(`ΔToken ${dToken > 0 ? '+' : ''}${dToken}%`);
            if (dDur != null) pieces.push(`耗时 ${dDur > 0 ? '+' : ''}${dDur}%`);
            if (coupling !== 0) pieces.push(`能力耦合 ${coupling > 0 ? '+' : ''}${coupling}`);
            return pieces.join(', ');
        }
        if (shortDim === 'stability') {
            const inv = abScoring.stability.invokeRate;
            const v = abScoring.stability.variance;
            const pieces: string[] = [];
            if (inv != null) pieces.push(`触发率 ${inv}%`);
            pieces.push(v == null ? `方差 — (R=${repeatRounds})` : `方差 ${v}`);
            return pieces.join(', ');
        }
        return '';
    })();
    const sampleHint = decisionReady && sampleSize < recommendedSampleSize
        ? `样本量偏少, 建议补到 N≥${recommendedSampleSize}、R≥${Math.max(policy.minRepeats, 3)}`
        : '';
    const nextStep: string = decisionAdvice;

    // 维度行的进度条 + 阈值刻度。50 / 75 是 reject / good 边界 (能力/成本各自配置, 但
    // 为简化 UI 统一用 50/75 作视觉刻度——和算法判定阈值差异极小, 不影响读数)。
    const Bar = ({ value, tone }: { value: number | null; tone: AbTone }) => {
        const v = value == null ? 0 : Math.max(0, Math.min(100, value));
        return (
            <div style={{ position: 'relative', height: 8, background: '#E7E5E4', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(2, v)}%`, height: '100%', background: toneColor(tone), borderRadius: 999 }} />
                {/* 50 / 75 阈值刻度——细竖线落在条上方,提示"良好线 / 拒绝线" */}
                <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(0,0,0,0.18)' }} />
                <span style={{ position: 'absolute', left: '75%', top: 0, bottom: 0, width: 1, background: 'rgba(0,0,0,0.18)' }} />
            </div>
        );
    };

    const Score = ({ value, tone }: { value: number | null; tone: AbTone }) => (
        <div style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: toneColor(tone) }}>{value == null ? '—' : value}</span>
            <span style={{ fontSize: 11, color: '#A8A29E', marginLeft: 4 }}>/ 100</span>
        </div>
    );

    const VerdictPill = ({ tone, label }: { tone: AbTone; label: string }) => (
        <span style={{
            display: 'inline-block', padding: '1px 7px', borderRadius: 4,
            fontSize: 10, fontWeight: 700, color: toneColor(tone), background: toneBg(tone),
        }}>{label}</span>
    );

    // 维度行
    const dimensionRows: Array<{
        key: 'capability' | 'cost' | 'stability';
        label: string;
        subtitle: string;
        score: number | null;
        tone: AbTone;
        verdictLabel: string;
        evidence: React.ReactNode;
    }> = [
        {
            key: 'capability',
            label: '能力',
            subtitle: 'Skill 让 Agent 多做成了多少事',
            score: abScoring.capability.score,
            tone: abScoring.capability.tone,
            verdictLabel: abScoring.capability.label,
            evidence: decisionReady ? (
                <>
                    A {abScoring.capability.avgEvalScoreA ?? '—'}
                    <span style={{ color: '#A8A29E', margin: '0 4px' }}>→</span>
                    B {abScoring.capability.avgEvalScoreB ?? '—'}
                    {abScoring.capability.deltaScore != null && (
                        <>
                            <span style={{ color: '#A8A29E', margin: '0 8px' }}>·</span>
                            Δscore {abScoring.capability.deltaScore > 0 ? '+' : ''}{abScoring.capability.deltaScore}
                        </>
                    )}
                </>
            ) : '—',
        },
        {
            key: 'cost',
            label: '成本',
            subtitle: '多花了多少 token / 时间',
            score: abScoring.cost.score,
            tone: abScoring.cost.tone,
            verdictLabel: abScoring.cost.label,
            evidence: decisionReady ? (() => {
                const dToken = abScoring.cost.deltaTokenPct;
                const dDur = abScoring.cost.deltaDurationPct;
                const cap = abScoring.capability.score;
                const coupling = cap == null ? 0 : cap >= policy.capabilityGoodThreshold ? policy.costCouplingBonus : cap < policy.capabilityRejectThreshold ? -policy.costCouplingPenalty : 0;
                return (
                    <>
                        ΔToken {dToken == null ? '—' : `${dToken > 0 ? '+' : ''}${dToken}%`}
                        <span style={{ color: '#A8A29E', margin: '0 8px' }}>·</span>
                        耗时 {dDur == null ? '—' : `${dDur > 0 ? '+' : ''}${dDur}%`}
                        {coupling !== 0 && (
                            <>
                                <span style={{ color: '#A8A29E', margin: '0 8px' }}>·</span>
                                能力耦合 {coupling > 0 ? '+' : ''}{coupling}
                            </>
                        )}
                    </>
                );
            })() : '—',
        },
        {
            key: 'stability',
            label: '稳定性',
            subtitle: '该触发时触发了吗, 结果稳吗',
            score: abScoring.stability.score,
            tone: abScoring.stability.tone,
            verdictLabel: abScoring.stability.label,
            evidence: decisionReady ? (
                <>
                    触发率 {abScoring.stability.invokeRate == null ? '—' : `${abScoring.stability.invokeRate}%`}
                    <span style={{ color: '#A8A29E', margin: '0 8px' }}>·</span>
                    方差 {abScoring.stability.variance == null ? `— (R=${repeatRounds})` : abScoring.stability.variance}
                </>
            ) : '—',
        },
    ];

    return (
        <>
            {/* ① 决策横条 ──────────────────────────────────────────── */}
            <div style={{
                border: `1px solid ${decisionTone === 'gray' ? '#E7E5E4' : decisionColor}`,
                background: decisionBg,
                borderRadius: 10,
                padding: '14px 18px',
                display: 'grid',
                gridTemplateColumns: 'minmax(170px, auto) 1fr auto',
                gap: 18,
                alignItems: 'center',
            }}>
                {/* 左：决策名 + 综合分 */}
                <div style={{ borderRight: '1px solid rgba(0,0,0,0.08)', paddingRight: 16 }}>
                    <div style={{ fontSize: 10, color: '#888780', fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: 1.5 }}>DECISION</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: decisionColor, lineHeight: 1.05, marginTop: 2 }}>
                        {decisionTitle}
                    </div>
                    <div style={{ fontSize: 11, color: '#5F5E5A', marginTop: 4, fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' }}>
                        综合 <span style={{ fontWeight: 700, color: decisionColor }}>{decisionReady && abScoring.totalScore != null ? abScoring.totalScore : '—'}</span> / 100
                    </div>
                </div>

                {/* 中：短板原因 + 下一步建议 + 样本量提示 */}
                <div style={{ fontSize: 13, lineHeight: 1.65, color: '#374151' }}>
                    {shortDim && evidenceText && (
                        <div>
                            <span style={{ color: '#5F5E5A' }}>短板在 </span>
                            <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 700, color: toneColor(dimTone(shortDim)), background: toneBg(dimTone(shortDim)) }}>{dimLabel(shortDim)}</span>
                            <span style={{ color: '#5F5E5A' }}> · </span>
                            <span>{evidenceText}</span>
                        </div>
                    )}
                    <div style={{ marginTop: shortDim && evidenceText ? 4 : 0, color: '#5F5E5A' }}>
                        <span style={{ color: '#1F2937', fontWeight: 700 }}>下一步</span>
                        <span style={{ color: '#A8A29E', margin: '0 6px' }}>·</span>
                        <span>{nextStep}</span>
                        {sampleHint && (
                            <>
                                <span style={{ color: '#A8A29E', margin: '0 6px' }}>;</span>
                                <span style={{ color: '#BA7517' }}>{sampleHint}</span>
                            </>
                        )}
                    </div>
                </div>

                {/* 右：动作按钮 */}
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        onClick={onViewTrace}
                        style={{
                            padding: '7px 14px', borderRadius: 6, border: '1px solid #D6D3D1',
                            background: 'white', color: '#1F2937', fontSize: 12, fontWeight: 600,
                            cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                    >{locale === 'zh' ? '查看 Trace' : 'View Trace'}</button>
                </div>
            </div>

            {/* ② 维度表 ──────────────────────────────────────────── */}
            <div style={{ border: '1px solid #E7E5E4', borderRadius: 10, overflow: 'hidden', background: 'white' }}>
                {/* 表头 */}
                <div style={{
                    display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) 90px minmax(180px, 2fr) minmax(220px, 1.8fr)',
                    gap: 16, padding: '8px 16px',
                    background: '#FAFAF7', borderBottom: '1px solid #E7E5E4',
                    fontSize: 10, color: '#888780', fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: 1,
                }}>
                    <div>维度</div>
                    <div style={{ textAlign: 'right' }}>分数</div>
                    <div style={{ position: 'relative' }}>
                        0 <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>· 50 ·</span>
                        <span style={{ position: 'absolute', left: '75%', transform: 'translateX(-50%)' }}>75</span>
                        <span style={{ float: 'right' }}>100</span>
                    </div>
                    <div>关键证据</div>
                </div>
                {/* 行 */}
                {dimensionRows.map(row => (
                    <div key={row.key} style={{
                        display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) 90px minmax(180px, 2fr) minmax(220px, 1.8fr)',
                        gap: 16, padding: '12px 16px',
                        borderBottom: '1px solid #F5F4EE', alignItems: 'center',
                    }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 14, fontWeight: 700, color: '#1F2937' }}>{row.label}</span>
                                <VerdictPill tone={row.tone} label={row.verdictLabel} />
                            </div>
                            <div style={{ fontSize: 11, color: '#888780', marginTop: 2 }}>{row.subtitle}</div>
                        </div>
                        <Score value={row.score} tone={row.tone} />
                        <Bar value={row.score} tone={row.tone} />
                        <div style={{ fontSize: 12, color: '#374151', fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.evidence}
                        </div>
                    </div>
                ))}
            </div>

            {/* ③ 原始数据与计算公式（折叠） ──────────────────────── */}
            <details style={{ border: '1px solid #E7E5E4', borderRadius: 10, overflow: 'hidden', background: 'white' }} open={!decisionReady ? false : abScoring.decision === 'reject'}>
                <summary style={{
                    cursor: 'pointer', padding: '10px 16px',
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: '#FAFAF7', borderBottom: '1px solid #E7E5E4',
                    fontSize: 12, fontWeight: 700, color: '#374151', userSelect: 'none', listStyle: 'none',
                }}>
                    <span style={{ color: '#A8A29E', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>▸</span>
                    <span>原始数据与计算公式</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: '#A8A29E', fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 400 }}>
                        min(capability, cost, stability)
                    </span>
                </summary>
                <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                    <RawSubCard
                        label="能力" tag="capability" tone={abScoring.capability.tone}
                        rows={[
                            { k: '评测均分', a: abScoring.capability.avgEvalScoreA, b: abScoring.capability.avgEvalScoreB, aFmt: v => v == null ? '—' : String(v), bFmt: v => v == null ? '—' : String(v) },
                            { k: '通过率', a: abScoring.capability.passRateA, b: abScoring.capability.passRateB, aFmt: v => v == null ? '—' : `${v}%`, bFmt: v => v == null ? '—' : `${v}%` },
                        ]}
                        delta={{ label: 'Δscore', value: abScoring.capability.deltaScore == null ? '—' : `${abScoring.capability.deltaScore > 0 ? '+' : ''}${abScoring.capability.deltaScore}` }}
                        breakdown={abScoring.capability.breakdown}
                        dataQualityIssue={abScoring.capability.dataQualityIssue}
                        toneColor={toneColor} toneBg={toneBg}
                    />
                    <RawSubCard
                        label="成本" tag="cost" tone={abScoring.cost.tone}
                        rows={[
                            { k: 'Token', a: abScoring.cost.avgTokensA, b: abScoring.cost.avgTokensB, aFmt: v => v == null ? '—' : v.toLocaleString(), bFmt: v => v == null ? '—' : v.toLocaleString() },
                            { k: '耗时', a: abScoring.cost.avgDurationA, b: abScoring.cost.avgDurationB, aFmt: v => v == null ? '—' : `${v}s`, bFmt: v => v == null ? '—' : `${v}s` },
                            { k: '步数', a: abScoring.cost.avgStepsA, b: abScoring.cost.avgStepsB, aFmt: v => v == null ? '—' : String(v), bFmt: v => v == null ? '—' : String(v) },
                        ]}
                        delta={{ label: 'ΔToken', value: abScoring.cost.deltaTokenPct == null ? '—' : `${abScoring.cost.deltaTokenPct > 0 ? '+' : ''}${abScoring.cost.deltaTokenPct}%` }}
                        breakdown={abScoring.cost.breakdown}
                        dataQualityIssue={abScoring.cost.dataQualityIssue}
                        toneColor={toneColor} toneBg={toneBg}
                    />
                    <RawSubCard
                        label="稳定性" tag="stability" tone={abScoring.stability.tone}
                        rows={[
                            { k: '触发率', a: null, b: abScoring.stability.invokeRate, aFmt: () => '—', bFmt: v => v == null ? '—' : `${v}%`, oneSide: true },
                            { k: '方差', a: null, b: abScoring.stability.variance, aFmt: () => '—', bFmt: v => v == null ? `— (R=${repeatRounds})` : String(v), oneSide: true },
                        ]}
                        delta={null}
                        breakdown={abScoring.stability.breakdown}
                        dataQualityIssue={abScoring.stability.dataQualityIssue}
                        toneColor={toneColor} toneBg={toneBg}
                    />
                    <RawSubCard
                        label="综合 (短板原则)" tag="verdict" tone={decisionTone}
                        rows={[]}
                        delta={null}
                        breakdown={abScoring.totalScoreBreakdown}
                        dataQualityIssue={abScoring.hardGates.length > 0 ? `命中 hard gate：${abScoring.hardGates.map(g => g.label).join('、')}` : undefined}
                        toneColor={toneColor} toneBg={toneBg}
                    />
                </div>
            </details>

            {/* 样本量 + 策略版本 footer——一行小字,便于历史回放与算法对账 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: '#A8A29E', fontFamily: 'ui-monospace, monospace', paddingTop: 2 }}>
                <span>SAMPLE N={sampleSize}{recommendedSampleSize ? ` / 推荐 ≥${recommendedSampleSize}` : ''} · 重复 {repeatRounds} 轮 · 置信度 {abScoring.confidence === 'high' ? '高' : abScoring.confidence === 'medium' ? '中' : '低'}</span>
                <span>策略：{abScoring.policyVersion}</span>
            </div>
        </>
    );
}

// 折叠面板里的 mini sub-card,统一展示一个维度的「原始 A/B 值 → 主指标 Δ → 公式代入」三件套。
// rows 是 A vs B 的并排列表; delta 是该维度的主指标变化(能力 Δscore / 成本 ΔToken),
// 没有就传 null; breakdown 直接复用算法侧出的 AbScoreBreakdown,formula + steps 写进
// mono 代码块,让用户一眼看出"分数怎么从原始数据算出来的"。
function RawSubCard({
    label, tag, tone, rows, delta, breakdown, dataQualityIssue, toneColor, toneBg,
}: {
    label: string;
    tag: string;
    tone: AbTone;
    rows: Array<{
        k: string;
        a: number | null;
        b: number | null;
        aFmt: (v: number | null) => string;
        bFmt: (v: number | null) => string;
        oneSide?: boolean;
    }>;
    delta: { label: string; value: string } | null;
    breakdown: AbScoreBreakdown;
    dataQualityIssue?: string;
    toneColor: (tone: AbTone) => string;
    toneBg: (tone: AbTone) => string;
}) {
    return (
        <div style={{ border: '1px solid #E7E5E4', borderRadius: 8, background: '#FAFAF7', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'white', borderBottom: '1px solid #E7E5E4' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#1F2937' }}>{label}</span>
                <span style={{ fontSize: 10, color: toneColor(tone), background: toneBg(tone), padding: '1px 7px', borderRadius: 4, fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: 0.5 }}>{tag}</span>
            </div>
            <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map(row => (
                    <div key={row.k} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                        <span style={{ color: '#5F5E5A' }}>{row.k}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', color: '#374151', textAlign: 'right' }}>
                            {row.oneSide ? '' : <><span style={{ color: '#A8A29E', marginRight: 6 }}>A</span>{row.aFmt(row.a)}</>}
                        </span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', color: '#374151', textAlign: 'right' }}>
                            <span style={{ color: '#A8A29E', marginRight: 6 }}>B</span>{row.bFmt(row.b)}
                        </span>
                    </div>
                ))}
                {delta && (
                    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, alignItems: 'baseline', fontSize: 12, marginTop: 2, paddingTop: 6, borderTop: '1px dashed #E7E5E4' }}>
                        <span style={{ color: '#5F5E5A' }}>{delta.label}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: toneColor(tone), textAlign: 'right' }}>{delta.value}</span>
                    </div>
                )}
                {/* 公式代入式: 直接复用算法 breakdown.steps,把"分数怎么来的"摆在用户面前 */}
                <pre style={{
                    margin: '8px 0 0', padding: '8px 10px',
                    background: 'white', border: '1px solid #E7E5E4', borderRadius: 4,
                    fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums',
                    fontSize: 10.5, lineHeight: 1.65, color: '#374151',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{breakdown.steps.join('\n')}</pre>
                {dataQualityIssue && (
                    <div style={{ fontSize: 11, color: '#BA7517', marginTop: 2 }}>{dataQualityIssue}</div>
                )}
                <div style={{ fontSize: 10, color: '#A8A29E', fontFamily: 'ui-monospace, monospace', textAlign: 'right' }}>{breakdown.reference}</div>
            </div>
        </div>
    );
}

// 从单一 CaseStatus + failureType 推出执行阶段和评测阶段两个独立 status。
// 区分逻辑: failureType 有值 = 执行阶段挂了 (agent_timeout / permission_blocked /
// agent_error 等); failureType 空 + status='fail' = 执行成功但评测器失败。
function deriveExecAndEval(args: {
    status: CaseStatus | string | undefined;
    hasExecFailure: boolean;
    evaluations?: RunEvaluation[];
    evaluatorRunId?: string;
}): { exec: { label: string; tone: BadgeTone }; evaluation: { label: string; tone: BadgeTone } | null } {
    const { status, hasExecFailure, evaluations, evaluatorRunId } = args;
    const s = (status ?? 'pending') as CaseStatus;
    const evalItems = evaluations || [];
    const hasEvaluationStarted = Boolean(evaluatorRunId) || evalItems.length > 0;
    const hasEvaluationRunning = evalItems.some(item => item.status === 'pending' || item.status === 'running');
    const hasEvaluationFailed = evalItems.some(item => item.status === 'failed');
    const hasEvaluationDone = evalItems.some(item => item.status === 'done');
    // 执行阶段
    let exec: { label: string; tone: BadgeTone };
    if (s === 'fail' && hasExecFailure && !hasEvaluationStarted) {
        exec = { label: '执行失败', tone: 'fail' };
    } else if (s === 'pending') {
        exec = { label: '排队中', tone: 'pending' };
    } else if (s === 'running') {
        exec = { label: '执行中', tone: 'running' };
    } else {
        // executed / evaluating / pass / fail (无 failureType=评测失败, 执行其实是成功的)
        exec = { label: '执行完成', tone: 'done' };
    }
    // 评测阶段——只有执行成功才会有评测阶段
    if (s === 'pending' || s === 'running' || (s === 'fail' && hasExecFailure)) {
        return { exec, evaluation: null };
    }
    let evaluation: { label: string; tone: BadgeTone };
    if (hasEvaluationRunning) {
        evaluation = { label: '评测中', tone: 'running' };
    } else if (s === 'executed' && !hasEvaluationStarted) {
        evaluation = { label: '待评测', tone: 'pending' };
    } else if (hasEvaluationDone && !hasEvaluationFailed) {
        evaluation = { label: '已评测', tone: 'done' };
    } else if (hasEvaluationFailed) {
        evaluation = { label: '评测失败', tone: 'fail' };
    } else if (s === 'evaluating') {
        evaluation = { label: '评测中', tone: 'running' };
    } else if (s === 'pass') {
        evaluation = { label: '已评测', tone: 'done' };
    } else {
        // s === 'fail' 且无 failureType → 评测器自己挂了
        evaluation = { label: '评测失败', tone: 'fail' };
    }
    return { exec, evaluation };
}

// 跟 polling tick 的 setCaseStates(nextStates) 配合：如果本地某 case-side 有
// 比 server 更新的 in-flight 状态，polling 直接覆盖会把那条 running run 抹掉。
// 这里做 case-side 级别的 reconcile：只要本地 runs 长度 ≥ 远端且本地末尾是
// 非 finished 状态，就保留本地不动；否则采用远端。
function mergeServerCaseStates(
    local: Record<string, { a: PerVersionState; b: PerVersionState }>,
    remote: Record<string, { a: PerVersionState; b: PerVersionState }>,
): Record<string, { a: PerVersionState; b: PerVersionState }> {
    const FINISHED: CaseStatus[] = ['pass', 'fail', 'executed'];
    const IN_FLIGHT: CaseStatus[] = ['pending', 'running', 'evaluating'];
    const mergeSide = (l?: PerVersionState, r?: PerVersionState): PerVersionState => {
        if (!l) return r ?? { status: 'pending' };
        if (!r) return l;
        const lRuns = l.runs ?? [];
        const rRuns = r.runs ?? [];
        const lLatest = lRuns[lRuns.length - 1];
        const rLatest = rRuns[rRuns.length - 1];
        // 保留本地比远端更多的 in-flight run，避免 polling tick 用旧 caseStatesJson
        // 把刚产生的本地进行中状态擦回去。
        if (lRuns.length > rRuns.length && lLatest && !FINISHED.includes(lLatest.status)) {
            return l;
        }
        // 行级重试时，本地会先把同一 run 原地切回 evaluating/running；这时服务端上一拍
        // 可能还在返回旧的 fail/executed。若直接覆盖，会闪一下"执行失败/评测失败"再回到成功。
        // 对 evaluating 的 run，只有当远端也进入 evaluating 或已经到 pass，才接受远端覆盖。
        if (
            lLatest
            && rLatest
            && lRuns.length === rRuns.length
            && lLatest.runIndex === rLatest.runIndex
            && IN_FLIGHT.includes(lLatest.status)
        ) {
            if (lLatest.status === 'evaluating' && rLatest.status !== 'evaluating' && rLatest.status !== 'pass') {
                return l;
            }
            if (lLatest.status === 'running' && rLatest.status === 'pending') {
                return l;
            }
        }
        // 其它一律采用 server——之前还有条 "本地 running/evaluating 而远端不是 →
        // keep local" 的兜底, 但 server 把状态从 evaluating 推到 pass 是正常进程,
        // 那条规则会让本地永久卡在 evaluating, 即使 server 已经写 pass。已删。
        return r;
    };
    const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
    const merged: Record<string, { a: PerVersionState; b: PerVersionState }> = {};
    for (const id of ids) {
        merged[id] = {
            a: mergeSide(local[id]?.a, remote[id]?.a),
            b: mergeSide(local[id]?.b, remote[id]?.b),
        };
    }
    return merged;
}

import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

const BUILT_IN_EVALUATORS = [
    ...presetEvaluators.filter(e => e.status === 'ready').map(e => ({ id: e.id, name: e.name }))
];
const BUILT_IN_EVALUATOR_IDS = new Set(BUILT_IN_EVALUATORS.map(e => e.id));

function uniqueIds(ids: Array<string | undefined | null>): string[] {
    return Array.from(new Set(ids.map(id => String(id || '').trim()).filter(Boolean)));
}

function normalizeEvaluatorIds(ids: unknown, fallback?: string): string[] {
    const raw = Array.isArray(ids) ? ids : ids ? [ids] : [];
    const normalized = uniqueIds(raw.map(id => String(id || '').trim()))
        .filter(id => BUILT_IN_EVALUATOR_IDS.has(id));
    if (normalized.length > 0) return normalized;
    const fallbackId = String(fallback || '').trim();
    return fallbackId && BUILT_IN_EVALUATOR_IDS.has(fallbackId) ? [fallbackId] : [];
}

function aggregateEvaluationScore(evaluations: RunEvaluation[] | undefined): number | undefined {
    const scores = (evaluations || [])
        .filter(item => item.status === 'done' && typeof item.score === 'number' && Number.isFinite(item.score))
        .map(item => item.score as number);
    if (scores.length === 0) return undefined;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function pickBoundEvaluationResult(evaluations: RunEvaluation[] | undefined): RunEvaluation | undefined {
    return (evaluations || []).find(item => (
        Boolean(item.evaluationResultId)
        && Boolean(item.evaluatorRunId)
        && item.status === 'done'
    )) || (evaluations || []).find(item => (
        Boolean(item.evaluationResultId)
        && Boolean(item.evaluatorRunId)
    ));
}

function getFailedOrMissingEvaluatorIds(run: Pick<RunResult, 'evaluations'> | undefined, selectedEvaluatorIds: string[]): string[] {
    const existing = new Map((run?.evaluations || []).map(item => [item.evaluatorId, item]));
    return selectedEvaluatorIds.filter(id => {
        const item = existing.get(id);
        return !item || item.status === 'failed' || item.status === 'pending';
    });
}

/* Custom Premium SVG Icons */
const HistoryIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
);
const PlusIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
);
const DatabaseIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>
);
const ScaleIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M18 8h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4"/></svg>
);
const ChevronDownIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
);
const PlayIcon = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
);
const TrophyIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z"/></svg>
);
const CheckIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
);
const GearIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
);
const CalendarIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
);
const UserIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
);
const SparklesIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.3-6.3l-.7.7M6.7 17.3l-.7.7m12.6 0l-.7-.7M6.7 6.7l-.7-.7N12 8a4 4 0 0 0-4 4 4 4 0 0 0 8 0 4 4 0 0 0-4-4z"/></svg>
);
const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
);

function GrayscalePageInner() {
    const { locale } = useLocale();
    const router = useRouter();
    const [newTaskTrigger, setNewTaskTrigger] = useState(0);
    const [historyPanelTrigger, setHistoryPanelTrigger] = useState(0);
    const mainAreaRef = useRef<HTMLDivElement>(null);

    return (
        <div className="debug-root">
            <PageHeader
                variant="management"
                breadcrumbs={[
                    { label: locale === 'zh' ? 'Skills 评测' : 'Skill Evaluation', href: '/skill-eval' },
                    { label: locale === 'zh' ? '调测分析' : 'Debug & Analysis' },
                ]}
                title={locale === 'zh' ? 'A/B 测试' : 'A/B Test'}
                action={{
                    label: locale === 'zh' ? '新建任务' : 'New Task',
                    icon: Plus,
                    onClick: () => setNewTaskTrigger(c => c + 1),
                }}
                secondaryAction={{
                    label: locale === 'zh' ? '历史任务' : 'History',
                    icon: History,
                    onClick: () => setHistoryPanelTrigger(c => c + 1),
                }}
            />
            <div className="d-layout" style={{ background: 'var(--background-secondary)' }}>
                <div className="d-main-area" ref={mainAreaRef} style={{ padding: 0 }}>
                    <GrayscaleEvaluation newTaskTrigger={newTaskTrigger} historyPanelTrigger={historyPanelTrigger} />
                </div>
            </div>
        </div>
    );
}

export function GrayscaleEvaluation({
    newTaskTrigger,
    historyPanelTrigger,
    pageTitle,
    pageDescription,
    pageBadge,
    onBack,
    onOptimize,
    parentSkillId,
    parentSkillVersion,
    skillSelectorSlot,
    hifi = false,
}: {
    newTaskTrigger: number;
    historyPanelTrigger: number;
    pageTitle?: string;
    pageDescription?: string;
    pageBadge?: string;
    onBack?: () => void;
    onOptimize?: () => void;
    parentSkillId?: string;
    parentSkillVersion?: number | null;
    skillSelectorSlot?: React.ReactNode;
    /** Phase 1 hi-fi shell — task-row on top + 3 collapsible cards. Loaded only via `?view=gray`. */
    hifi?: boolean;
}) {
    const { locale } = useLocale();
    const { user } = useAuth();
    const router = useRouter();

    // Task management
    const [currentTask, setCurrentTask] = useState<GrayscaleTask | null>(null);
    const [taskHistory, setTaskHistory] = useState<GrayscaleTask[]>([]);
    const [isEditingTask, setIsEditingTask] = useState(false);
    const [taskNameInput, setTaskNameInput] = useState('');
    const [taskDescInput, setTaskDescInput] = useState('');
    const [isCreatingTask, setIsCreatingTask] = useState(false);
    const taskTitleInputRef = useRef<HTMLInputElement | null>(null);

    // Data
    const [datasets, setDatasets] = useState<any[]>([]);
    const [skills, setSkills] = useState<SkillOption[]>([]);
    const [versions, setVersions] = useState<SkillVersionOption[]>([]);

    // Config
    const [selectedSkillId, setSelectedSkillId] = useState('');
    const [versionAId, setVersionAId] = useState('');
    const [versionBId, setVersionBId] = useState('');

    // Query input
    const [sourceMode, setSourceMode] = useState<'dataset' | 'trace'>('dataset');
    const [selectedDatasetId, setSelectedDatasetId] = useState('');
    const [showDatasetDropdown, setShowDatasetDropdown] = useState(false);
    const [selectedCaseId, setSelectedCaseId] = useState('');

    // Numbers
    const [repeatRounds, setRepeatRounds] = useState<number>(1);
    const [agentMaxConcurrency, setAgentMaxConcurrency] = useState<number>(4);
    const autoEval = true;
    const recordTriggerDetails = true;

    // Output preview modal
    const [outputModal, setOutputModal] = useState<{ title: string; content: string } | null>(null);
    const [recordModal, setRecordModal] = useState<{ title: string; side: 'a' | 'b' } | null>(null);

    // Trace mode
    const [traceTimeRange, setTraceTimeRange] = useState<'1d' | '3d' | '7d'>('7d');
    const [traceRecords, setTraceRecords] = useState<TraceRecord[]>([]);
    const [traceLoading, setTraceLoading] = useState(false);
    const [selectedTraceAId, setSelectedTraceAId] = useState('');
    const [selectedTraceBId, setSelectedTraceBId] = useState('');

    // Evaluator
    const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('');
    const [selectedEvaluatorIds, setSelectedEvaluatorIds] = useState<string[]>([]);
    const [showEvalDropdown, setShowEvalDropdown] = useState(false);

    // Linked datasets
    const [linkedDatasetIds, setLinkedDatasetIds] = useState<string[]>([]);
    const [showNewDatasetModal, setShowNewDatasetModal] = useState(false);
    const [newDatasetName, setNewDatasetName] = useState('');
    const [isCreatingDataset, setIsCreatingDataset] = useState(false);
    const [showLinkDatasetDropdown, setShowLinkDatasetDropdown] = useState(false);

    // History drawer
    const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);

    // Hi-fi shell collapse state (Phase 1, ?view=gray only — see hifi prop).
    // Defaults are derived from the current step status so the user lands on
    // the most relevant stage: config -> exec -> result.
    const [hifiCollapsed, setHifiCollapsed] = useState<{ config: boolean; exec: boolean; result: boolean }>({
        config: false,
        exec: false,
        result: false,
    });
    const [hasManualHifiCollapseOverride, setHasManualHifiCollapseOverride] = useState(false);
    const toggleHifiCard = useCallback((key: 'config' | 'exec' | 'result') => {
        setHasManualHifiCollapseOverride(true);
        setHifiCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
    }, []);
    // Hi-fi verdict-card raw data accordion (the 2×2 formula grid under
    // the three dim rows). Default collapsed; users open it when they want
    // to inspect the calculation.
    const [hifiRawOpen, setHifiRawOpen] = useState(false);

    // Modals
    const [showSkillModal, setShowSkillModal] = useState(false);

    // 「新增评测任务」对话框开关。点确认后通过 onCreated 把新批次 ID 写回当前 task config,
    // 启动评测时透传给 /api/eval/trajectory/run append 落到同一批次。
    const [newBatchDialogOpen, setNewBatchDialogOpen] = useState(false);
    // 用户显式点「新建任务」后, 进入未保存草稿态; 在再次保存/选历史前, 不要被
    // parentSkillId + versionBId 的自动绑定逻辑立刻把旧任务重新套回来。
    const [isFreshTaskDraft, setIsFreshTaskDraft] = useState(false);

    // 评测任务关联: 跟 selectedEvaluatorId 等同级用 React state 管理 (不依赖 currentConfigRef
    // 的 ref-only 模式)。这样 applyTaskToState 加载任务时能正确恢复, useEffect 重设 ref 时
    // 能稳定包含进去, 不会被擦掉 (历史 bug: 首版用了 ref+spread 模式, 任何 state 变化触发
    // useEffect 重设 ref 时会丢 evaluationBatch* 字段, 下一次 PATCH 字段丢光)。
    const [evaluationBatchId, setEvaluationBatchId] = useState('');
    const [evaluationBatchTitle, setEvaluationBatchTitle] = useState('');
    const [evaluationBatchEvaluators, setEvaluationBatchEvaluators] = useState<string[]>([]);

    // Multi-case states
    const [caseStates, setCaseStates] = useState<Record<string, { a: PerVersionState; b: PerVersionState }>>({});
    const [checkedCaseIds, setCheckedCaseIds] = useState<string[]>([]);
    const [isTaskRunInFlight, setIsTaskRunInFlight] = useState(false);
    // 行级 retry 在飞集合: key 形如 `${caseId}::${side}::${runIndex}`。
    // 双写: state 给 UI 渲染时正常反应性, ref 在 click handler 里同步判重
    // (防止 React state 还没 commit 时的快速双击)。两者都指向同一个 Set 实例:
    // mark*/clear* 函数会同时更新 ref 和 state, 它们永不分歧。
    // 自动清理: useEffect watch caseStates, run 走到 terminal (pass/fail) 时清掉,
    // 让按钮恢复可点。顶部「终止」按钮成功后一次性 clearAllRetriesInFlight, 干预所有 in-flight。
    const [inFlightRetries, setInFlightRetries] = useState<Set<string>>(() => new Set());
    const inFlightRetriesRef = useRef<Set<string>>(inFlightRetries);
    const retryKey = (caseId: string, side: 'a' | 'b', runIndex: number) =>
        `${caseId}::${side}::${runIndex}`;
    const markRetryInFlight = (key: string) => {
        if (inFlightRetriesRef.current.has(key)) return false;
        const next = new Set(inFlightRetriesRef.current);
        next.add(key);
        inFlightRetriesRef.current = next;
        setInFlightRetries(next);
        return true;
    };
    const markRetryDone = (key: string) => {
        if (!inFlightRetriesRef.current.has(key)) return;
        const next = new Set(inFlightRetriesRef.current);
        next.delete(key);
        inFlightRetriesRef.current = next;
        setInFlightRetries(next);
    };
    const clearAllRetriesInFlight = () => {
        if (inFlightRetriesRef.current.size === 0) return;
        const next = new Set<string>();
        inFlightRetriesRef.current = next;
        setInFlightRetries(next);
    };
    const [lastRunConfigSignature, setLastRunConfigSignature] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [filterTab, setFilterTab] = useState<'all' | 'pending' | 'executed' | 'evaluated'>('all');

    const activePollsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

    const NONE_VERSION_ID = '__NONE__';

    const defaultTaskName = () => {
        const now = new Date();
        return `A/B测试 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`;
    };
    const taskTitlePlaceholder = locale === 'zh' ? '点击命名任务…' : 'Name this task…';

    const resetToNewTaskDraft = (skillId: string) => {
        setCurrentTask(null);
        currentTaskRef.current = null;
        selectedTaskIdRef.current = null; // 草稿: 明确无选中, 别再被 URL/旧选择拽回
        // 新建草稿没有已存任务, 清掉 URL 的 ?task, 否则刷新又会去恢复旧任务。
        if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.has('task')) {
                url.searchParams.delete('task');
                window.history.replaceState(window.history.state, '', url.toString());
            }
        }
        setTaskNameInput(defaultTaskName());
        setTaskDescInput('');
        setSelectedSkillId(skillId);
        setVersionAId(NONE_VERSION_ID);
        setVersionBId('');
        setSourceMode('dataset');
        setSelectedDatasetId('');
        setSelectedCaseId('');
        setLinkedDatasetIds([]);
        setCheckedCaseIds([]);
        setTraceTimeRange('7d');
        setSelectedTraceAId('');
        setSelectedTraceBId('');
        setCaseStates({});
        caseStatesRef.current = {};
        setIsTaskRunInFlight(false);
        isTaskRunInFlightRef.current = false;
        setLastRunConfigSignature('');
        // 新任务草稿: 清空评测批次关联 (老任务的批次跟新任务无关)
        setEvaluationBatchId('');
        setEvaluationBatchTitle('');
        setEvaluationBatchEvaluators([]);
        setSelectedEvaluatorId('');
        setSelectedEvaluatorIds([]);
        pendingVersionsRef.current = null;
        setIsEditingTask(true);
    };

    const taskMatchesBinding = (
        task: GrayscaleTask,
        skillId: string,
        versionId?: string,
        versionNumber?: number | null,
    ) => {
        if (!skillId) return false;
        const cfg = task.configJson || {};
        const taskSkillId = task.skillId || cfg.skillId || '';
        if (taskSkillId !== skillId) return false;
        if (versionId) return (task.skillVersionId || cfg.versionBId || '') === versionId;
        if (versionNumber != null) return Number(task.skillVersion) === Number(versionNumber);
        return true;
    };
    const getTaskRunTime = (task: GrayscaleTask) => {
        const rawLatest = task.configJson?.latestResultAt;
        const latest = typeof rawLatest === 'string' ? Date.parse(rawLatest) : 0;
        if (Number.isFinite(latest) && latest > 0) return latest;
        const stateRunTimes = Object.values(task.caseStatesJson || {}).flatMap(pair =>
            (['a', 'b'] as const).flatMap(side =>
                (pair?.[side]?.runs || []).map(run =>
                    typeof run.completedAt === 'string' ? Date.parse(run.completedAt) : 0
                )
            )
        ).filter(time => Number.isFinite(time) && time > 0);
        if (stateRunTimes.length > 0) return Math.max(...stateRunTimes);
        return Date.parse(task.createdAt || '') || 0;
    };
    const hasTaskRunHistory = (task: GrayscaleTask) => Object.values(task.caseStatesJson || {}).some(pair =>
        (['a', 'b'] as const).some(side => {
            const state = pair?.[side];
            return Boolean(state && (state.status !== 'pending' || (state.runs?.length || 0) > 0));
        })
    );
    const pickLatestTaskForBinding = (
        tasks: GrayscaleTask[],
        skillId: string,
        versionId?: string,
        versionNumber?: number | null,
    ) => {
        const matched = tasks.filter(task => taskMatchesBinding(task, skillId, versionId, versionNumber));
        if (matched.length === 0) return undefined;
        return matched.sort((a, b) => {
            const activeDelta = Number(Boolean(b.activeRun)) - Number(Boolean(a.activeRun));
            if (activeDelta !== 0) return activeDelta;
            const historyDelta = Number(hasTaskRunHistory(b)) - Number(hasTaskRunHistory(a));
            if (historyDelta !== 0) return historyDelta;
            return getTaskRunTime(b) - getTaskRunTime(a);
        })[0];
    };

    const applyTaskToState = (task: GrayscaleTask) => {
        setCurrentTask(task);
        // 记下"意向选中"的任务并写进 URL(?task=<id>): 刷新 / effect 重跑都恢复到这个任务, 不跳回最新。
        selectedTaskIdRef.current = task?.id ?? null;
        if (typeof window !== 'undefined' && task?.id) {
            const url = new URL(window.location.href);
            url.searchParams.set('task', task.id);
            window.history.replaceState(window.history.state, '', url.toString());
        }
        setIsFreshTaskDraft(false);
        setIsEditingTask(false);
        setTaskNameInput('');
        const cfg = task.configJson || {};
        const boundSkillId = cfg.skillId || task.skillId || '';
        if (boundSkillId) setSelectedSkillId(boundSkillId);
        setSourceMode('dataset'); // 「从执行链路」已下线: 历史 trace 任务加载时一律归一到 dataset, 避免卡在无出口的 trace 模式
        setRepeatRounds(cfg.repeatRounds || 1);
        setAgentMaxConcurrency(cfg.agentMaxConcurrency || 4);
        const evaluatorIds = normalizeEvaluatorIds(cfg.evaluators || cfg.evaluationBatchEvaluators, cfg.evaluatorId || '');
        setSelectedEvaluatorIds(evaluatorIds);
        setSelectedEvaluatorId(evaluatorIds[0] || '');
        setTaskDescInput(cfg.taskDescription || '');
        const restoredLinkedDatasetIds = Array.isArray(cfg.linkedDatasetIds) ? cfg.linkedDatasetIds : [];
        setSelectedDatasetId(cfg.selectedDatasetId || restoredLinkedDatasetIds[0] || '');
        setSelectedCaseId(cfg.selectedCaseId || '');
        setLinkedDatasetIds(restoredLinkedDatasetIds);
        setCheckedCaseIds(Array.isArray(cfg.checkedCaseIds)
            ? cfg.checkedCaseIds
            : Array.isArray(cfg.selectedCaseIds) ? cfg.selectedCaseIds : []);
        setTraceTimeRange(cfg.traceTimeRange || '7d');
        setSelectedTraceAId(cfg.selectedTraceAId || '');
        setSelectedTraceBId(cfg.selectedTraceBId || '');
        // 评测批次关联 (从 DB 恢复, 修 "再次进入 A/B 看不到上次评测任务" 问题)
        setEvaluationBatchId(cfg.evaluationBatchId || '');
        setEvaluationBatchTitle(cfg.evaluationBatchTitle || '');
        setEvaluationBatchEvaluators(Array.isArray(cfg.evaluationBatchEvaluators) ? cfg.evaluationBatchEvaluators : []);
        if (cfg.versionAId || cfg.versionBId) {
            pendingVersionsRef.current = { versionAId: cfg.versionAId, versionBId: cfg.versionBId };
        } else {
            pendingVersionsRef.current = null;
        }
        const rawStates: any = task.caseStatesJson || {};
        let parsedStates: Record<string, { a: PerVersionState; b: PerVersionState }> = {};
        if (rawStates.a || rawStates.b) {
            const caseId = cfg.selectedCaseId || 'legacy-case';
            parsedStates = {
                [caseId]: {
                    a: rawStates.a || { status: 'pending' },
                    b: rawStates.b || { status: 'pending' }
                }
            };
        } else {
            parsedStates = rawStates as Record<string, { a: PerVersionState; b: PerVersionState }>;
        }
        setCaseStates(parsedStates);
        caseStatesRef.current = parsedStates;
        setIsTaskRunInFlight(Boolean(task.activeRun) || hasRunningCaseStates(parsedStates) || hasPendingAutoEvaluationCaseStates(parsedStates));
        setLastRunConfigSignature(Object.keys(parsedStates).length > 0
            ? buildRunConfigSignature({
                skillId: boundSkillId,
                versionAId: cfg.versionAId || '',
                versionBId: cfg.versionBId || '',
                sourceMode: 'dataset', // 「从执行链路」已下线: 配置归一到 dataset
                selectedDatasetId: cfg.selectedDatasetId || '',
                linkedDatasetIds: cfg.linkedDatasetIds || [],
                selectedTraceAId: cfg.selectedTraceAId || '',
                selectedTraceBId: cfg.selectedTraceBId || '',
                repeatRounds: cfg.repeatRounds || 1,
                agentMaxConcurrency: cfg.agentMaxConcurrency || 4,
                autoEval: true,
                recordTriggerDetails: true,
                evaluatorIds: normalizeEvaluatorIds(cfg.evaluators || cfg.evaluationBatchEvaluators, cfg.evaluatorId || ''),
                caseIds: Object.keys(parsedStates),
            })
            : ''
        );
    };

    // Load all tasks for history, then pick the task bound to the current Skill + B version.
    // 用户"意向选中"的任务 id: 首次取 URL 的 ?task, 之后由 applyTaskToState / 手动切换维护。
    // 始终优先它(只要还在列表里)—— 不能"消费一次就丢", 否则本 effect 因 parentSkill 异步解析重跑时
    // 会跳回最新(Q3 根因)。undefined=还没初始化, null=明确无选中(草稿)。
    const selectedTaskIdRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/debug/grayscale-tasks?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                    setTaskHistory(data);
                    if (selectedTaskIdRef.current === undefined) {
                        selectedTaskIdRef.current = typeof window !== 'undefined'
                            ? new URLSearchParams(window.location.search).get('task')
                            : null;
                    }
                    const intended = selectedTaskIdRef.current
                        ? (data as GrayscaleTask[]).find(t => t.id === selectedTaskIdRef.current)
                        : null;
                    const task = intended || (parentSkillId
                        ? pickLatestTaskForBinding(data as GrayscaleTask[], parentSkillId, undefined, parentSkillVersion)
                        : [...(data as GrayscaleTask[])].sort((a, b) => getTaskRunTime(b) - getTaskRunTime(a))[0]);
                    if (task) {
                        applyTaskToState(task);
                    } else if (parentSkillId) {
                        resetToNewTaskDraft(parentSkillId);
                    } else {
                        resetToNewTaskDraft('');
                    }
                } else {
                    resetToNewTaskDraft(parentSkillId || '');
                }
            })
            .catch(() => {
                resetToNewTaskDraft(parentSkillId || '');
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, parentSkillId, parentSkillVersion]);

    const currentTaskRef = useRef<GrayscaleTask | null>(null);
    useEffect(() => { currentTaskRef.current = currentTask; }, [currentTask]);
    const caseStatesRef = useRef(caseStates);
    useEffect(() => { caseStatesRef.current = caseStates; }, [caseStates]);

    // 当 caseStates 里某条 run 走到 terminal (pass/fail) 时, 把它从 in-flight 集合移除,
    // 让重试按钮重新可点 (终态可能仍是 fail, 此时按钮应再次显示为"可重试")。
    // 不把 'executed' 当 terminal —— retryExecution autoEval=true 时, 短暂 executed 后会
    // 马上变 evaluating, 这窗口里清掉会让按钮闪一次"可重试"误导用户。改成执行成功且
    // autoEval=false 的清理走 retryExecution 内部显式 markRetryDone。
    useEffect(() => {
        if (inFlightRetriesRef.current.size === 0) return;
        const next = new Set(inFlightRetriesRef.current);
        let mutated = false;
        for (const key of Array.from(next)) {
            const [caseId, sideStr, runIndexStr] = key.split('::');
            const runIndex = Number(runIndexStr);
            const sideState = caseStates[caseId]?.[sideStr as 'a' | 'b'];
            const run = (sideState?.runs || []).find(r => r.runIndex === runIndex);
            if (!run) continue;
            if (run.status === 'pass' || run.status === 'fail') {
                next.delete(key);
                mutated = true;
            }
        }
        if (mutated) {
            inFlightRetriesRef.current = next;
            setInFlightRetries(next);
        }
    }, [caseStates]);
    const isTaskRunInFlightRef = useRef(isTaskRunInFlight);
    useEffect(() => { isTaskRunInFlightRef.current = isTaskRunInFlight; }, [isTaskRunInFlight]);
    const currentConfigRef = useRef({ skillId: selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, selectedCaseIds: checkedCaseIds, checkedCaseIds, taskDescription: taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, evaluatorId: selectedEvaluatorId, evaluators: selectedEvaluatorIds, evaluationBatchId, evaluationBatchTitle, evaluationBatchEvaluators });
    useEffect(() => {
        currentConfigRef.current = { skillId: selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, selectedCaseIds: checkedCaseIds, checkedCaseIds, taskDescription: taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, evaluatorId: selectedEvaluatorId, evaluators: selectedEvaluatorIds, evaluationBatchId, evaluationBatchTitle, evaluationBatchEvaluators };
    }, [selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, checkedCaseIds, taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, selectedEvaluatorId, selectedEvaluatorIds, evaluationBatchId, evaluationBatchTitle, evaluationBatchEvaluators]);

    const currentRunConfigSignature = useMemo(() => buildRunConfigSignature({
        skillId: selectedSkillId,
        versionAId,
        versionBId,
        sourceMode,
        selectedDatasetId,
        linkedDatasetIds,
        selectedTraceAId,
        selectedTraceBId,
        repeatRounds,
        agentMaxConcurrency,
        autoEval,
        recordTriggerDetails,
        evaluatorIds: selectedEvaluatorIds,
        caseIds: checkedCaseIds,
    }), [
        selectedSkillId,
        versionAId,
        versionBId,
        sourceMode,
        selectedDatasetId,
        linkedDatasetIds,
        selectedTraceAId,
        selectedTraceBId,
        repeatRounds,
        agentMaxConcurrency,
        autoEval,
        recordTriggerDetails,
        selectedEvaluatorIds,
        checkedCaseIds,
    ]);

    const pendingVersionsRef = useRef<{ versionAId?: string; versionBId?: string } | null>(null);

    const persistTaskUpdate = useCallback(async (
        taskId: string,
        configJson?: object,
        caseStatesUpdate?: Record<string, { a: PerVersionState; b: PerVersionState }>
    ) => {
        if (!user || !taskId) return;
        const body: Record<string, unknown> = { user };
        if (configJson !== undefined) body.configJson = configJson;
        if (caseStatesUpdate !== undefined) body.caseStatesJson = caseStatesUpdate;
        try {
            await apiFetch(`/api/debug/grayscale-tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch {}
    }, [user]);

    const persistCaseStates = useCallback((updatedStates: Record<string, { a: PerVersionState; b: PerVersionState }>) => {
        if (!currentTaskRef.current) return;
        persistTaskUpdate(currentTaskRef.current.id, currentConfigRef.current, updatedStates);
    }, [persistTaskUpdate]);

    // 「新增评测任务」对话框 onCreated: 把后端返回的 evaluatorRunId / title / evaluators
    // 设为 React state (currentConfigRef useEffect 会自动同步进 ref, 后续所有 persist 都带这些字段);
    // 同时立刻调一次 persistTaskUpdate 把新字段落库, 避免要等下一次 state 变化才同步。
    const handleEvalBatchCreated = useCallback((result: NewBatchCreated) => {
        setNewBatchDialogOpen(false);
        const task = currentTaskRef.current;
        if (!task) return;
        setEvaluationBatchId(result.evaluatorRunId);
        setEvaluationBatchTitle(result.taskTitle);
        setEvaluationBatchEvaluators(result.selectedEvaluators);
        // 立刻 patch 一次 (不等 useEffect): nextConfig 显式带新字段, 不依赖 ref。
        const nextConfig = {
            ...currentConfigRef.current,
            evaluationBatchId: result.evaluatorRunId,
            evaluationBatchTitle: result.taskTitle,
            evaluationBatchEvaluators: result.selectedEvaluators,
        };
        persistTaskUpdate(task.id, nextConfig, undefined);
        setCurrentTask(prev => prev ? {
            ...prev,
            configJson: { ...(prev.configJson || {}), ...nextConfig },
        } : prev);
    }, [persistTaskUpdate]);

    // 返回 { task, existed }: existed=true 表示该 skill 版本已经有 A/B 任务(后端
    // @@unique([user, skillName, skillVersion]) 撞约束返回 409 + existingTask), 此时
    // task 是已存在的那一条 —— caller 需据此决定是「新建」还是「应用配置到已有任务」。
    const createTaskForBinding = useCallback(async (
        skillId: string,
        boundVersionBId: string,
        taskName?: string,
    ): Promise<{ task: GrayscaleTask; existed: boolean } | null> => {
        if (!user || !skillId || !boundVersionBId || boundVersionBId === NONE_VERSION_ID) return null;
        const name = (taskName || taskNameInput || defaultTaskName()).trim();
        const res = await apiFetch('/api/debug/grayscale-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user, taskName: name, skillId, versionAId, versionBId: boundVersionBId }),
        });
        if (res.ok) {
            const newTask = await res.json();
            setTaskHistory(prev => prev.some(t => t.id === newTask.id) ? prev : [newTask, ...prev]);
            return { task: newTask as GrayscaleTask, existed: false };
        }
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            if (data.existingTask) {
                setTaskHistory(prev => prev.some(t => t.id === data.existingTask.id) ? prev : [data.existingTask, ...prev]);
                return { task: data.existingTask as GrayscaleTask, existed: true };
            }
        }
        return null;
    }, [user, taskNameInput, versionAId]);

    useEffect(() => {
        if (!parentSkillId || !versionBId || versionBId === NONE_VERSION_ID) return;
        if (isFreshTaskDraft) return;
        const current = currentTaskRef.current;
        if (current && taskMatchesBinding(current, parentSkillId, versionBId, parentSkillVersion)) return;
        const existing = pickLatestTaskForBinding(taskHistory, parentSkillId, versionBId, parentSkillVersion);
        if (existing) {
            applyTaskToState(existing);
            return;
        }
        let cancelled = false;
        createTaskForBinding(parentSkillId, versionBId)
            .then(result => {
                if (!cancelled && result?.task) applyTaskToState(result.task);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [parentSkillId, parentSkillVersion, versionBId, taskHistory, createTaskForBinding, isFreshTaskDraft]);

    // Automatically persist core config changes to database when they change
    useEffect(() => {
        const task = currentTaskRef.current;
        if (task && selectedSkillId) {
            if (!versionBId) {
                return;
            }
            const boundSkillId = task.skillId || task.configJson?.skillId || '';
            if (boundSkillId && boundSkillId !== selectedSkillId) {
                return;
            }
            const boundVersionBId = task.skillVersionId || task.configJson?.versionBId || '';
            if (boundVersionBId && boundVersionBId !== versionBId) {
                return;
            }
            const persistedConfig = task.configJson || {};
            if ((!versionAId && persistedConfig.versionAId) || (!versionBId && persistedConfig.versionBId)) {
                return;
            }
            persistTaskUpdate(task.id, {
                ...currentConfigRef.current,
                skillId: selectedSkillId,
                versionAId,
                versionBId
            });
        }
    }, [selectedSkillId, versionAId, versionBId, persistTaskUpdate]);

    useEffect(() => {
        const task = currentTaskRef.current;
        if (!task) return;
        persistTaskUpdate(task.id, {
            ...currentConfigRef.current,
            selectedCaseIds: checkedCaseIds,
            checkedCaseIds,
        });
    }, [checkedCaseIds, persistTaskUpdate]);

    useEffect(() => {
        return () => {
            const task = currentTaskRef.current;
            if (task) {
                persistTaskUpdate(task.id, currentConfigRef.current, caseStatesRef.current);
            }
            Object.values(activePollsRef.current).forEach(clearInterval);
        };
    }, [persistTaskUpdate]);

    // Fetch trace records
    useEffect(() => {
        if (sourceMode !== 'trace' || !user || !selectedSkillId) { setTraceRecords([]); return; }
        setTraceLoading(true);
        const traceSkill = skills.find(s => s.id === selectedSkillId);
        const params = new URLSearchParams({ user });
        if (traceSkill) params.set('skill', traceSkill.name);
        const msPerDay = 86_400_000;
        const days = traceTimeRange === '1d' ? 1 : traceTimeRange === '3d' ? 3 : 7;
        params.set('since', String(Date.now() - days * msPerDay));
        apiFetch(`/api/observe/data?${params.toString()}`)
            .then(r => r.json())
            .then(data => { if (Array.isArray(data)) setTraceRecords(data.slice(0, 100)); })
            .catch(() => {})
            .finally(() => setTraceLoading(false));
    }, [sourceMode, user, selectedSkillId, traceTimeRange, skills]);

    // Fetch datasets + skills. A/B 测试只使用预置评估器, 不加载自定义评估器。
    useEffect(() => {
        if (!user) return;
        Promise.all([
            apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`).then(r => r.json()),
            apiFetch(`/api/skills?user=${encodeURIComponent(user)}`).then(r => r.json()),
        ]).then(([ds, sk]) => {
            if (Array.isArray(ds)) setDatasets(ds);
            if (Array.isArray(sk)) {
                const skillOptions = sk.map((s: any) => ({ id: s.id, name: s.name }));
                setSkills(skillOptions);
                setSelectedSkillId(prev => prev || skillOptions[0]?.id || '');
            }
        }).catch(() => {});
    }, [user]);

    // Fetch versions when skill changes
    useEffect(() => {
        if (!user || !selectedSkillId) { setVersions([]); setVersionAId(NONE_VERSION_ID); setVersionBId(''); return; }
        apiFetch(`/api/skills/${selectedSkillId}/versions?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setVersions(data);
                    const pending = pendingVersionsRef.current;
                    if (pending) {
                        const aExists = pending.versionAId === NONE_VERSION_ID || data.find((v: any) => v.id === pending.versionAId);
                        const bExists = pending.versionBId === NONE_VERSION_ID || data.find((v: any) => v.id === pending.versionBId);
                        if (aExists) setVersionAId(pending.versionAId!);
                        else setVersionAId(NONE_VERSION_ID);
                        if (bExists) setVersionBId(pending.versionBId!);
                        else setVersionBId(data[data.length - 1]?.id || data[0]?.id || '');
                        pendingVersionsRef.current = null;
                    } else {
                        setVersionAId(NONE_VERSION_ID);
                        const cur = data.find((v: any) => v.isCurrent);
                        setVersionBId(cur?.id || data[data.length - 1]?.id || data[0]?.id || '');
                    }
                }
            }).catch(() => {});
    }, [user, selectedSkillId]);

    useEffect(() => {
        if (!parentSkillId) return;
        const task = currentTaskRef.current;
        const taskSkillId = task?.skillId || task?.configJson?.skillId || '';
        if (taskSkillId && taskSkillId !== parentSkillId) {
            resetToNewTaskDraft(parentSkillId);
        }
        if (selectedSkillId === parentSkillId) return;
        setSelectedSkillId(parentSkillId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [parentSkillId, selectedSkillId]);

    useEffect(() => {
        if (parentSkillVersion == null || versions.length === 0) return;
        const matchedVersion = versions.find(v => Number(v.version) === Number(parentSkillVersion));
        if (!matchedVersion?.id) return;
        if (versionBId !== matchedVersion.id) setVersionBId(matchedVersion.id);
    }, [parentSkillVersion, versionBId, versions]);

    /**
     * 行级执行重试: 原地覆盖指定 runIndex 的 run, 不 push 新行。
     *
     * 这是执行记录 modal 里的"再试这一行"语义——用户看到某一行执行失败,
     * 想再跑一次, 同一行覆盖结果。
     *
     * 步骤:
     *   1) 找到 (caseId, side, runIndex) 那条 run, reset 它的状态为 'running',
     *      清掉 sessionId/output/score/eval 相关字段, 保留 runIndex/roundIndex
     *   2) PATCH caseStatesJson 落库
     *   3) POST /api/debug/execute 等 jobId
     *   4) 轮询 /api/debug/execute/{jobId}, completion 时按 runIndex 找到对应 run
     *      原地更新结果字段; autoEval=true 时自动触发该 run 的 evaluate
     */
    const retryExecution = async (caseId: string, side: 'a' | 'b', runIndex: number) => {
        if (!currentTask) return;
        // 同步抢占 in-flight 锁: 双击 / 在飞期间再次点击直接 return, 防止重复 dispatch。
        // markRetryInFlight 返回 false 表示已经在飞中。配 ref 在 React commit 前同步生效。
        const flightKey = retryKey(caseId, side, runIndex);
        if (!markRetryInFlight(flightKey)) return;
        const targetCase = allCases.find(c => c.id === caseId);
        const query = targetCase?.input || '';
        if (!query.trim()) { markRetryDone(flightKey); return; }
        const versionId = side === 'a' ? versionAId : versionBId;
        const isNone = versionId === NONE_VERSION_ID;
        const version = isNone ? null : versions.find(v => v.id === versionId);
        const selectedSkill = skills.find(s => s.id === selectedSkillId);

        // 1) 原地 reset 那一条 run
        const resetRunByIndex = (sideState: PerVersionState | undefined): PerVersionState => {
            const base: PerVersionState = sideState ?? { status: 'pending' };
            const runs = (base.runs ?? []).map(r => {
                if (r.runIndex !== runIndex) return r;
                const next = { ...r, status: 'running' as CaseStatus };
                delete next.sessionId;
                delete next.evaluatorRunId;
                delete next.evaluationResultId;
                delete next.evaluationTraceId;
                delete next.score;
                delete next.tier;
                delete next.evaluations;
                delete next.failureType;
                delete next.failureDetail;
                delete next.timeCost;
                delete next.tokenUsage;
                delete next.skillTriggered;
                delete next.toolCallCount;
                delete next.toolCalls;
                delete next.completedAt;
                next.output = '';
                return next;
            });
            return { ...base, status: 'running', runs };
        };
        let nextStates: Record<string, { a: PerVersionState; b: PerVersionState }> | null = null;
        setCaseStates(prev => {
            const current = prev[caseId];
            if (!current) return prev;
            const updated = { ...prev, [caseId]: { ...current, [side]: resetRunByIndex(current[side]) } };
            nextStates = updated;
            return updated;
        });
        if (!nextStates) { markRetryDone(flightKey); return; }
        await persistTaskUpdate(currentTask.id, currentConfigRef.current, nextStates);

        // 2) POST /api/debug/execute (不传 grayscaleTaskId, 避免 backend 重复写库)
        // baseline (isNone=true) retry 时 skill 字段为空, 但 trace 在逻辑上跟对照的
        // 被测 skill 配对 —— 传 tagSkill 让 backend 把 trace.skill 字段填成
        // selectedSkill?.name (本任务被测 skill), "从 Trace"视图按 skill 过滤能搜到。
        let jobId: string;
        try {
            const res = await apiFetch('/api/debug/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    query,
                    skill: isNone ? undefined : selectedSkill?.name,
                    skillVersion: (isNone || !version) ? undefined : Number(version.version),
                    // baseline 没 skill 加载, 用 selectedSkill?.name 当 trace 归属标签;
                    // skill-agent 那侧已经 skill 字段填上了, tagSkill 即使也传也是冗余无害。
                    tagSkill: selectedSkill?.name,
                    mode: 'grayscale',
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.jobId) {
                setCaseStates(prev => {
                    const current = prev[caseId];
                    if (!current) return prev;
                    const sideState = current[side];
                    if (!sideState) return prev;
                    const runs = (sideState.runs ?? []).map(r =>
                        r.runIndex === runIndex
                            ? { ...r, status: 'fail' as CaseStatus, output: data.error || 'dispatch failed' }
                            : r
                    );
                    return { ...prev, [caseId]: { ...current, [side]: { ...sideState, runs } } };
                });
                markRetryDone(flightKey);
                return;
            }
            jobId = data.jobId;
        } catch (err) {
            setCaseStates(prev => {
                const current = prev[caseId];
                if (!current) return prev;
                const sideState = current[side];
                if (!sideState) return prev;
                const runs = (sideState.runs ?? []).map(r =>
                    r.runIndex === runIndex
                        ? { ...r, status: 'fail' as CaseStatus, output: String(err) }
                        : r
                );
                return { ...prev, [caseId]: { ...current, [side]: { ...sideState, runs } } };
            });
            markRetryDone(flightKey);
            return;
        }

        // 3) 轮询 job, completion 时按 runIndex 原地更新
        const poll = async (): Promise<boolean | null> => {
            try {
                const res = await apiFetch(`/api/debug/execute/${jobId}`);
                const data = await res.json();
                if (data.status === 'completed') {
                    setCaseStates(prev => {
                        const current = prev[caseId];
                        if (!current) return prev;
                        const sideState = current[side];
                        if (!sideState) return prev;
                        const runs = (sideState.runs ?? []).map(r => r.runIndex === runIndex ? {
                            ...r,
                            status: 'executed' as CaseStatus,
                            jobId,
                            output: data.output ?? '',
                            timeCost: data.timeCost,
                            tokenUsage: data.tokenUsage ?? 0,
                            sessionId: data.sessionId,
                            skillTriggered: !!version,
                        } : r);
                        const updated = { ...prev, [caseId]: { ...current, [side]: { ...sideState, runs } } };
                        persistCaseStates(updated);
                        // autoEval: 跑完自动评估这一行 (走 retryEvaluation 同款行级路径)。
                        // in-flight 锁不在这里释放, 让 retryEvaluation 继承同一把锁
                        // 直至评测出结果, 否则按钮会在 executed → evaluating 切换瞬间
                        // 闪一下"可重试"误导用户。
                        if (autoEval) {
                            void retryEvaluation(caseId, side, runIndex);
                        } else {
                            // 用户关掉了 autoEval, 执行成功就到此为止, 把锁释放掉
                            markRetryDone(flightKey);
                        }
                        return updated;
                    });
                    return true;
                } else if (data.status === 'failed' || data.error) {
                    setCaseStates(prev => {
                        const current = prev[caseId];
                        if (!current) return prev;
                        const sideState = current[side];
                        if (!sideState) return prev;
                        const runs = (sideState.runs ?? []).map(r => r.runIndex === runIndex ? {
                            ...r,
                            status: 'fail' as CaseStatus,
                            jobId,
                            output: data.error || 'agent failed',
                            failureType: 'agent_error',
                            failureDetail: data.error || 'agent failed',
                        } : r);
                        const updated = { ...prev, [caseId]: { ...current, [side]: { ...sideState, runs } } };
                        persistCaseStates(updated);
                        return updated;
                    });
                    // run 状态进入 fail, 上面 useEffect 会自动 clear in-flight, 但显式
                    // 再调一次保险, 防止 setCaseStates 还没 commit 就有人再次点 retry
                    markRetryDone(flightKey);
                    return false;
                }
                return null;
            } catch { return null; }
        };
        const pollKey = `retry_exec_${caseId}_${side}_${runIndex}`;
        if (activePollsRef.current[pollKey]) clearInterval(activePollsRef.current[pollKey]);
        activePollsRef.current[pollKey] = setInterval(async () => {
            const done = await poll();
            if (done !== null) {
                clearInterval(activePollsRef.current[pollKey]);
                delete activePollsRef.current[pollKey];
            }
        }, 3000);
    };

    /**
     * 行级评测重试: 严格只 retry 用户点击的那一条 fail run, 不动 case 内其他 run。
     *
     * 步骤:
     *   1) 找到 (caseId, side, runIndex) 那条 run, reset 它的状态:
     *      status='evaluating' (UI 立刻看到 spinner), 清掉 evaluatorRunId/score/
     *      tier/output/failureType/failureDetail (让 backend 把它当"未评测"重选)
     *   2) PATCH caseStatesJson 落库
     *   3) POST action='evaluate' + onlyMissingEvaluation:true → backend 只选
     *      没 evaluatorRunId 也没 score 的 run, 现在只有刚 reset 的这一条匹配, 其他
     *      已 pass run 因为有 score / evaluatorRunId 被 skip, 不会被误评
     *   4) pollCurrentTask 跟进, evaluator 完成时 reconcileFinishedEvaluations
     *      正常推到 pass/fail
     */
    const retryEvaluation = async (caseId: string, side: 'a' | 'b', runIndex: number, evaluatorIds?: string[]) => {
        if (!currentTask) return;
        // 抢 in-flight 锁 (双击保护)。markRetryInFlight 是 idempotent:
        // - 用户直接点"评测失败重试" → 新增 lock
        // - retryExecution autoEval 链式调过来 → lock 已存在, markRetryInFlight 返回
        //   false 但我们继续往下走 (不是双击, 是同一把锁延续)。所以区分: 调用方传 None
        //   即"作为独立入口" — 已在飞中直接 return; 链式入口由上游保证只调一次。
        // 这里采取最简单策略: 总是 markRetryInFlight, 已存在就当作 idempotent, 继续往下
        // 走。配 useEffect terminal-clear 保证 pass/fail 时一次释放。
        const flightKey = retryKey(caseId, side, runIndex);
        markRetryInFlight(flightKey);
        const targetRun = caseStatesRef.current[caseId]?.[side]?.runs?.find(r => r.runIndex === runIndex);
        const retryEvaluatorIds = normalizeEvaluatorIds(
            evaluatorIds && evaluatorIds.length > 0
                ? evaluatorIds
                : getFailedOrMissingEvaluatorIds(targetRun, selectedEvaluatorIds),
            selectedEvaluatorId,
        );
        let resetState: Record<string, { a: PerVersionState; b: PerVersionState }> | null = null;
        setCaseStates(prev => {
            const current = prev[caseId];
            if (!current) return prev;
            const sideState = current[side];
            if (!sideState) return prev;
            const newRuns = (sideState.runs || []).map(r => {
                if (r.runIndex !== runIndex) return r;
                // 重置那一条 run 让 backend 重评:
                //   - status='evaluating' UI 立刻显示「评测中」蓝色脉冲, 用户感知到 retry 已生效
                //   - 清掉 evaluatorRunId/score/tier/output/failureType/failureDetail
                //     让 onlyMissingEvaluation 过滤命中 (无 evaluatorRunId 也无 score)
                //   - backend evaluateRunsWithConcurrency 配套放宽: onlyMissingEvaluation
                //     模式下也接受 status='evaluating' (见 route.ts eligibleStatus 注释)
                const next = { ...r, status: 'evaluating' as CaseStatus };
                const nextEvaluations = (next.evaluations || []).map(item => (
                    retryEvaluatorIds.includes(item.evaluatorId)
                        ? { ...item, status: 'running' as RunEvaluationStatus, errorMessage: undefined }
                        : item
                ));
                next.evaluations = nextEvaluations.length > 0
                    ? nextEvaluations
                    : retryEvaluatorIds.map(id => ({
                        evaluatorId: id,
                        evaluatorName: evaluatorNameById.get(id) || id,
                        status: 'running' as RunEvaluationStatus,
                    }));
                if (!next.evaluations.some(item => item.status === 'done')) {
                    delete next.evaluatorRunId;
                    delete next.evaluationResultId;
                    delete next.evaluationTraceId;
                    delete next.score;
                    delete next.tier;
                } else {
                    const score = aggregateEvaluationScore(next.evaluations);
                    if (typeof score === 'number') {
                        next.score = score;
                        next.tier = scoreTierFromComposite(score);
                    }
                }
                delete next.failureType;
                delete next.failureDetail;
                delete next.completedAt;
                next.output = '';
                return next;
            });
            const updatedSide = { ...sideState, runs: newRuns, status: 'evaluating' as CaseStatus };
            const updated = { ...prev, [caseId]: { ...current, [side]: updatedSide } };
            resetState = updated;
            return updated;
        });
        if (!resetState) { markRetryDone(flightKey); return; }
        // PATCH 让 server 看到 reset 后的状态 (status='evaluating', 字段已清)
        await persistTaskUpdate(currentTask.id, currentConfigRef.current, resetState);
        // 调用 backend 行级 retry
        try {
            const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    action: 'evaluate',
                    caseIds: [caseId],
                    evaluatorId: selectedEvaluatorId,
                    evaluators: retryEvaluatorIds,
                    onlyMissingEvaluation: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.error || (locale === 'zh' ? '评测重试失败' : 'Retry evaluation failed'));
                markRetryDone(flightKey);
                return;
            }
            // 成功 dispatch: 锁继续持有, 由 pollCurrentTask 的 caseStates 更新
            // 触发 useEffect terminal-clear 在 pass/fail 时自动释放。
            pollCurrentTask(currentTask.id);
        } catch (err) {
            alert(String(err));
            markRetryDone(flightKey);
        }
    };

    const resolvedTaskName = (taskNameInput.trim() || currentTask?.taskName?.trim() || defaultTaskName()).trim();
    const taskTitleDisplay = resolvedTaskName || taskTitlePlaceholder;
    const taskTitleIsPlaceholder = !resolvedTaskName;

    const beginTaskTitleEdit = useCallback(() => {
        setTaskNameInput(prev => prev || currentTask?.taskName || '');
        setIsEditingTask(true);
    }, [currentTask?.taskName]);

    const finishTaskTitleEdit = useCallback(() => {
        const trimmed = taskNameInput.trim();
        if (trimmed) {
            setTaskNameInput(trimmed);
        } else if (currentTask?.taskName) {
            setTaskNameInput(currentTask.taskName);
        }
        setIsEditingTask(false);
    }, [currentTask?.taskName, taskNameInput]);

    useEffect(() => {
        if (!isEditingTask) return;
        const frame = window.requestAnimationFrame(() => {
            taskTitleInputRef.current?.focus();
            taskTitleInputRef.current?.select();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isEditingTask]);

    const runCaseSide = async (caseId: string, side: 'a' | 'b') => {
        if (!currentTask) return;
        const sideState = caseStatesRef.current[caseId]?.[side];
        const latestRunIndex = findLatestRunnableRunIndex(sideState?.runs);
        if (latestRunIndex == null) {
            alert(locale === 'zh' ? '当前侧暂无可重跑的执行记录。' : 'No execution record is available to rerun for this side.');
            return;
        }
        await retryExecution(caseId, side, latestRunIndex);
    };

    // Evaluate single side —— 统一走 backend reconcile 路径(retryEvaluation)。
    // 评测结果以 evaluationResultId + grayscaleBinding 为唯一绑定键, 由 pollCurrentTask
    // 这唯一一个写入器把状态/分数/trace reconcile 进 caseStates。
    //
    // 这里不再保留旧的「客户端直接 POST /api/eval/trajectory/run + 轮询
    // /results?runId=... + results.find(caseId) + patchLatestRun + compositeScore」分支:
    // 那条分支用 runId+caseId 非唯一匹配、写到「最后一条 run」、还用与后端不一致的算分
    // 公式, 会和 pollCurrentTask 互相覆盖, 导致分数/状态/trace 在两拍之间跳变。
    const evaluateCaseSide = async (caseId: string, side: 'a' | 'b') => {
        if (!currentTask) {
            alert(locale === 'zh'
                ? '请先创建或加载 A/B 测试任务后再评测。'
                : 'Create or load an A/B task before evaluating.');
            return;
        }
        const sideState = caseStatesRef.current[caseId]?.[side];
        const latestRunIndex = findLatestRunnableRunIndex(sideState?.runs);
        if (latestRunIndex == null) {
            alert(locale === 'zh'
                ? '当前侧暂无可评测的执行记录。'
                : 'No execution record is available to evaluate for this side.');
            return;
        }
        await retryEvaluation(caseId, side, latestRunIndex);
    };

    const hasRunningStates = hasRunningCaseStates;

    const pollCurrentTask = useCallback((taskId: string) => {
        if (!user || !taskId) return;
        const pollKey = `task_${taskId}`;
        if (activePollsRef.current[pollKey]) clearInterval(activePollsRef.current[pollKey]);
        const tick = async () => {
            try {
                const res = await apiFetch(`/api/debug/grayscale-tasks/${taskId}?user=${encodeURIComponent(user)}`);
                const data = await res.json();
                if (!res.ok) return;
                if (currentTaskRef.current?.id !== taskId) {
                    clearInterval(activePollsRef.current[pollKey]);
                    delete activePollsRef.current[pollKey];
                    return;
                }
                const nextStates = data.caseStatesJson || {};
                // Polling 不要无脑覆盖本地：mergeServerCaseStates 会按 case-side
                // 粒度保留本地更新的 in-flight 状态，避免被擦回老值。
                setCaseStates(prev => mergeServerCaseStates(prev, nextStates));
                setCurrentTask(prev => prev ? { ...prev, ...data } : data);
                if (!data.activeRun && !hasRunningStates(nextStates) && !(data.configJson?.autoEval !== false && hasPendingAutoEvaluationCaseStates(nextStates))) {
                    setIsTaskRunInFlight(false);
                    clearInterval(activePollsRef.current[pollKey]);
                    delete activePollsRef.current[pollKey];
                } else {
                    setIsTaskRunInFlight(true);
                }
            } catch {}
        };
        void tick();
        activePollsRef.current[pollKey] = setInterval(tick, 2500);
    }, [user]);

    useEffect(() => {
        if (!currentTask?.id || !isTaskRunInFlight) return;
        pollCurrentTask(currentTask.id);
    }, [currentTask?.id, isTaskRunInFlight, pollCurrentTask]);

    // 用户点「终止」按钮: 让后端马上 abort in-flight chat / 不再 dispatch 新 work,
    // 把 caseStates 里所有 running/evaluating 推到 fail, 让用户脱离"执行中"锁死状态。
    const abortCurrentRun = async () => {
        if (!currentTask) return;
        if (!window.confirm(locale === 'zh'
            ? '确定终止当前 A/B 测试? 已 in-flight 的执行/评测会被标记为「用户终止」失败, 但产生的 trace 不会被清。'
            : 'Abort current A/B test? In-flight runs will be marked as user-aborted failures; existing traces are preserved.')) {
            return;
        }
        try {
            const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: user || 'debug-user', action: 'abort' }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                alert((locale === 'zh' ? '终止失败: ' : 'Abort failed: ') + (data.error || res.status));
                return;
            }
            // 顶部「终止」干预所有 in-flight retry: 一次性释放 retry 锁集合, 让按钮立刻
            // 可点。backend 把所有 running/evaluating 推到 fail 后, useEffect terminal-clear
            // 本来也会清, 但这里显式 clear 让 UI 立即响应不等下一 polling tick。
            clearAllRetriesInFlight();
            // 强制刷一次, 不等下一 polling tick
            pollCurrentTask(currentTask.id);
        } catch (err) {
            alert(String(err));
        }
    };

    const runComparisonForCheckedCases = async () => {
        if (isTaskRunInFlightRef.current || currentTaskRef.current?.activeRun || hasRunningStates(caseStatesRef.current)) {
            return;
        }
        if (!currentTask) {
            alert(locale === 'zh' ? '请先新建并保存评测任务。' : 'Please create and save an evaluation task first.');
            return;
        }
        if (checkedCaseIds.length === 0) {
            alert(locale === 'zh'
                ? '请至少选择 1 条样本后再执行。'
                : 'Please select at least one sample before running.');
            return;
        }
        setIsTaskRunInFlight(true);
        setLastRunConfigSignature(currentRunConfigSignature);
        setCurrentTask(prev => prev ? {
            ...prev,
            activeRun: {
                taskId: prev.id,
                runId: 'pending',
                status: 'running',
                startedAt: Date.now(),
            },
        } : prev);
        try {
            const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    action: 'start',
                    caseIds: checkedCaseIds,
                    evaluatorId: selectedEvaluatorId,
                    evaluators: selectedEvaluatorIds,
                    agentMaxConcurrency,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 409) {
                    pollCurrentTask(currentTask.id);
                    return;
                }
                setIsTaskRunInFlight(false);
                setCurrentTask(prev => prev ? { ...prev, activeRun: null } : prev);
                alert(data.error || (locale === 'zh' ? '启动失败' : 'Failed to start'));
                return;
            }
            pollCurrentTask(currentTask.id);
        } catch (err) {
            setIsTaskRunInFlight(false);
            setCurrentTask(prev => prev ? { ...prev, activeRun: null } : prev);
            alert(String(err));
        }
    };

    // Task CRUD
    const handleSaveTask = async () => {
        if (!resolvedTaskName || !user || !selectedSkillId || !versionBId || versionBId === NONE_VERSION_ID) return;
        setIsCreatingTask(true);
        try {
            if (currentTask) {
                const nextConfig = { ...currentConfigRef.current, taskDescription: taskDescInput.trim() };
                const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, taskName: resolvedTaskName, configJson: nextConfig }),
                });
                if (res.ok) {
                    const updated = await res.json();
                    applyTaskToState(updated);
                    setTaskHistory(prev => prev.map(t => t.id === updated.id ? updated : t));
                } else if (res.status === 409) {
                    // 甲(原地改名)撞同版本同名:提示并把名字还原回当前任务名,不要显示成"已改名"。
                    const data = await res.json().catch(() => ({} as { error?: string }));
                    alert(data?.error || (locale === 'zh'
                        ? '该版本下已存在同名 A/B 任务，请换一个名字'
                        : 'An A/B task with this name already exists for this version'));
                    setTaskNameInput(currentTask.taskName || '');
                    return;
                }
            } else {
                const created = await createTaskForBinding(selectedSkillId, versionBId, resolvedTaskName);
                if (created) {
                    const boundTask = created.task;
                    // 用户的新配置优先, 不能再被已存在任务的旧 configJson 覆盖 (这正是
                    // "保存配置失效" 的直接原因)。只保留绑定字段 (skillId/versionAId/versionBId),
                    // 其余一律用当前选择的配置。
                    const nextConfig = {
                        ...currentConfigRef.current,
                        skillId: boundTask.skillId || boundTask.configJson?.skillId || selectedSkillId,
                        versionAId,
                        versionBId,
                        taskDescription: taskDescInput.trim(),
                    };
                    const res = await apiFetch(`/api/debug/grayscale-tasks/${boundTask.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        // 一并写入用户起的任务名, 否则撞已有任务时会沿用旧名字, 看起来像"回到旧任务"。
                        body: JSON.stringify({ user, taskName: resolvedTaskName, configJson: nextConfig }),
                    });
                    const taskToApply = res.ok
                        ? await res.json()
                        : { ...boundTask, taskName: resolvedTaskName, configJson: nextConfig };
                    applyTaskToState(taskToApply);
                    setTaskHistory(prev => prev.some(t => t.id === taskToApply.id)
                        ? prev.map(t => t.id === taskToApply.id ? taskToApply : t)
                        : [taskToApply, ...prev]);
                    // 每个 skill 版本只能有一个 A/B 任务: 撞到已有任务时不静默退回, 明确告诉用户
                    // "已切换到该版本的现有任务并应用了你的配置"。
                    if (created.existed) {
                        alert(locale === 'zh'
                            ? '该 Skill 版本已存在 A/B 任务（每个版本仅允许一个）。已切换到该任务并保存你的配置。'
                            : 'An A/B task already exists for this skill version (one per version). Switched to it and saved your config.');
                    }
                }
            }
        } catch {}
        finally {
            setIsEditingTask(false);
            setIsCreatingTask(false);
        }
    };

    const handleNewTask = () => {
        // 任务名作为身份后,同一 skill 版本可建多个不同名任务 —— 嵌入模式(parentSkillId,版本被父级
        // 锁死)也放行。后端唯一键含 taskName:起个新名字就是新任务,只有撞同版本同名才会切到已有。
        // (旧逻辑在嵌入模式拦死"新建",是当年"一版本一任务"的约束,现已解除。)
        Object.entries(activePollsRef.current).forEach(([key, timer]) => {
            if (key.startsWith('task_')) {
                clearInterval(timer);
                delete activePollsRef.current[key];
            }
        });
        setIsFreshTaskDraft(true);
        resetToNewTaskDraft(parentSkillId || selectedSkillId);
        // 直接进入命名态:让用户立刻给新任务改名(嵌入模式 hifi 任务行的标题输入框即时聚焦)。
        setIsEditingTask(true);
    };

    // Sync triggers
    useEffect(() => {
        if (newTaskTrigger > 0) handleNewTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [newTaskTrigger]);

    useEffect(() => {
        if (historyPanelTrigger > 0) setShowHistoryDrawer(true);
    }, [historyPanelTrigger]);

    const handleSelectHistoryTask = (t: GrayscaleTask) => {
        if (parentSkillId && t.skillId !== parentSkillId && t.configJson?.skillId !== parentSkillId) {
            resetToNewTaskDraft(parentSkillId);
            return;
        }
        applyTaskToState(t);
    };

    // 嵌入模式(parentSkillId 存在)下, 历史抽屉只列当前 skill 的任务 —— 否则会混进别的 skill 的任务,
    // 且点了也切不动(handleSelectHistoryTask 仅同 skill 放行)。独立模式(无 parentSkillId)不过滤。
    // 历史任务与"当前选中的 skill + B 版本"绑定:切换 skill 或版本时,列表随之刷新只显示对应任务。
    // 嵌入模式按父级 skill 过滤;独立模式按当前选中的 skill(选了 B 版本则进一步按版本)过滤。
    const visibleTaskHistory = parentSkillId
        ? taskHistory.filter(t => t.skillId === parentSkillId || t.configJson?.skillId === parentSkillId)
        : (selectedSkillId
            ? taskHistory.filter(t => taskMatchesBinding(
                t,
                selectedSkillId,
                versionBId && versionBId !== NONE_VERSION_ID ? versionBId : undefined,
            ))
            : taskHistory);

    // Dataset handlers
    const handleCreateDataset = async () => {
        if (!newDatasetName.trim() || !user) return;
        setIsCreatingDataset(true);
        try {
            const res = await apiFetch('/api/agent-datasets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, name: newDatasetName.trim() }),
            });
            if (res.ok) {
                const newDs = await res.json();
                setDatasets(prev => [...prev, newDs]);
                const newLinked = [...linkedDatasetIds, newDs.id];
                setLinkedDatasetIds(newLinked);
                setSelectedDatasetId(newLinked[0] || '');
                setShowNewDatasetModal(false);
                setNewDatasetName('');
                if (currentTaskRef.current) {
                    persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, selectedDatasetId: newLinked[0] || '', linkedDatasetIds: newLinked });
                }
            }
        } catch {}
        finally { setIsCreatingDataset(false); }
    };

    const handleLinkDataset = (dsId: string) => {
        if (linkedDatasetIds.includes(dsId)) return;
        const newLinked = [...linkedDatasetIds, dsId];
        setLinkedDatasetIds(newLinked);
        setSelectedDatasetId(newLinked[0] || '');
        setShowLinkDatasetDropdown(false);
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, selectedDatasetId: newLinked[0] || '', linkedDatasetIds: newLinked });
        }
    };

    const handleUnlinkDataset = (dsId: string) => {
        const newLinked = linkedDatasetIds.filter(id => id !== dsId);
        setLinkedDatasetIds(newLinked);
        setSelectedDatasetId(newLinked[0] || '');
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, selectedDatasetId: newLinked[0] || '', linkedDatasetIds: newLinked });
        }
    };

    const getVersionLabel = (v: SkillVersionOption | string | undefined) => {
        if (v === NONE_VERSION_ID) return locale === 'zh' ? '无 Skill' : 'No Skill';
        return v && typeof v !== 'string' ? (v.semanticVersion || `v${v.version}`) : (typeof v === 'string' ? v : '--');
    };

    // Unified case list
    const activeLinkedDatasetIds = linkedDatasetIds.length > 0 ? linkedDatasetIds : (selectedDatasetId ? [selectedDatasetId] : []);
    const allCases: EvaluationCaseItem[] = sourceMode === 'dataset'
        ? datasets
            .filter(ds => activeLinkedDatasetIds.includes(ds.id))
            .flatMap(ds => (ds.cases || []).map((c: any) => ({
                ...c,
                datasetName: ds.name,
                datasetId: ds.id,
                sourceType: 'dataset' as const,
            })))
        : traceRecords.map((r, idx) => buildGrayscaleTraceCase(r, idx));
    const caseLookup = useMemo(() => new Map(allCases.map(item => [item.id, item])), [allCases]);

    // Auto-prune checkedCaseIds: 切换 sourceMode / 时间窗 / 数据集后, 原来勾选
    // 的 ID 在新的 allCases 里可能找不到了（dataset case id ≠ trace upload_id,
    // 数据被清掉等）。这里把 stale ID 过滤掉, 同步落回 DB, 避免：
    //   - 「已选样本 5 个」UI 上看不见、勾不掉
    //   - 「执行」时尝试跑不存在的 case
    // Guard 1: allCases 为空时 skip——避免 loading 中误把所有勾选清光
    // Guard 2: 必须有 currentTask 才同步落库, 否则只改本地 state
    useEffect(() => {
        if (allCases.length === 0) return;
        const validIds = new Set(allCases.map(c => c.id));
        const stale = checkedCaseIds.filter(id => !validIds.has(id));
        if (stale.length === 0) return;
        const next = checkedCaseIds.filter(id => validIds.has(id));
        setCheckedCaseIds(next);
        if (currentTask) {
            persistTaskUpdate(currentTask.id, {
                ...currentConfigRef.current,
                selectedCaseIds: next,
                checkedCaseIds: next,
            });
        }
    // 依赖只挂 allCases；checkedCaseIds 也读但不挂依赖以避免自己 set 自己导致 loop。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allCases]);

    // Selection
    useEffect(() => {
        if (allCases.length > 0 && !selectedCaseId) {
            setSelectedCaseId(allCases[0].id);
        }
    }, [allCases, selectedCaseId]);

    const activeCase = allCases.find(c => c.id === selectedCaseId) || allCases[0];

    // Filtered case list
    const filteredCases = allCases.filter(c => {
        const matchesSearch = c.input.toLowerCase().includes(searchQuery.toLowerCase()) || c.id.toLowerCase().includes(searchQuery.toLowerCase());
        if (!matchesSearch) return false;

        const state = caseStates[c.id] || { a: { status: 'pending' }, b: { status: 'pending' } };
        const statusA = state.a.status;
        const statusB = state.b.status;

        if (filterTab === 'pending') {
            return statusA === 'pending' && statusB === 'pending';
        }
        if (filterTab === 'executed') {
            return (statusA === 'executed' || statusA === 'evaluating' || statusA === 'running') ||
                   (statusB === 'executed' || statusB === 'evaluating' || statusB === 'running');
        }
        if (filterTab === 'evaluated') {
            return statusA === 'pass' && statusB === 'pass';
        }
        return true;
    });

    const countAll = allCases.length;
    const countPending = allCases.filter(c => {
        const state = caseStates[c.id] || { a: { status: 'pending' }, b: { status: 'pending' } };
        return state.a.status === 'pending' && state.b.status === 'pending';
    }).length;
    const countExecuted = allCases.filter(c => {
        const state = caseStates[c.id] || { a: { status: 'pending' }, b: { status: 'pending' } };
        return (state.a.status === 'executed' || state.a.status === 'evaluating' || state.a.status === 'running') ||
               (state.b.status === 'executed' || state.b.status === 'evaluating' || state.b.status === 'running');
    }).length;
    const countEvaluated = allCases.filter(c => {
        const state = caseStates[c.id] || { a: { status: 'pending' }, b: { status: 'pending' } };
        return state.a.status === 'pass' && state.b.status === 'pass';
    }).length;
    // 只统计「在当前 allCases 里能找到」的那些勾选 ID。否则切了 sourceMode /
    // 时间窗 / 数据集后, 老的 stale 勾选 ID 会让计数虚高（用户在 UI 上看不见,
    // 也勾不掉, 就疑惑「已选 5 个」是从哪里来的）。
    const checkedVisibleIds = checkedCaseIds.filter(id => allCases.some(c => c.id === id));
    const selectedSampleCount = checkedVisibleIds.length;

    const bWins = allCases.filter(c => {
        const state = caseStates[c.id];
        if (!state || state.a.status !== 'pass' || state.b.status !== 'pass') return false;
        return (state.b.score ?? 0) > (state.a.score ?? 0);
    }).length;

    const selectedSkill = skills.find(s => s.id === selectedSkillId);
    const versionA = versions.find(v => v.id === versionAId);
    const versionB = versions.find(v => v.id === versionBId);

    const linkedDatasets = linkedDatasetIds.map(id => datasets.find(d => d.id === id)).filter(Boolean) as any[];
    const unlinkableDatasets = datasets.filter(d => !linkedDatasetIds.includes(d.id));

    // Simulation mapping details for high-fidelity fallback when no real run exists
    const hasActiveCaseRun = caseStates[activeCase?.id]?.a?.status === 'pass' || caseStates[activeCase?.id]?.a?.status === 'executed';
    const currentConfigMatchesLastRun = Boolean(lastRunConfigSignature) && lastRunConfigSignature === currentRunConfigSignature;
    const lastRunCaseIds = Object.keys(caseStates).filter(caseId => {
        const state = caseStates[caseId];
        if (!state) return false;
        return (['a', 'b'] as const).some(side => {
            const sideState = state[side];
            return sideState.status !== 'pending' || (sideState.runs?.length || 0) > 0;
        });
    });
    const displayedResultCaseIds = (currentConfigMatchesLastRun || hasRunningStates(caseStates))
        ? (checkedCaseIds.length > 0 ? checkedCaseIds : lastRunCaseIds)
        : lastRunCaseIds;
    const displayedRunCounts = displayedResultCaseIds.flatMap(caseId => (['a', 'b'] as const).map(side => {
        const sideState = caseStates[caseId]?.[side];
        return sideState?.runCount || sideState?.runs?.length || 0;
    })).filter(count => count > 0);
    const displayedRepeatRounds = displayedRunCounts.length > 0
        ? Math.max(1, ...displayedRunCounts)
        : repeatRounds;

    const getExpectedRunCount = (caseIds: string[], side: 'a' | 'b') => {
        const fromStates = caseIds.reduce((sum, caseId) => {
            const sideState = caseStates[caseId]?.[side];
            if (!sideState) return sum;
            const runCount = sideState.runCount || sideState.runs?.length || 0;
            return sum + runCount;
        }, 0);
        return fromStates > 0 ? fromStates : caseIds.length * repeatRounds;
    };

    const getSimData = (side: 'a' | 'b') => {
        const targetIds = displayedResultCaseIds.length > 0
            ? displayedResultCaseIds
            : (activeCase?.id ? [activeCase.id] : []);
        
        if (targetIds.length === 0) {
            return {
                status: 'pending' as CaseStatus,
                runsCompleted: locale === 'zh' ? '0/0 未执行' : '0/0 Pending',
                timeCost: '—',
                tokenUsage: undefined as number | undefined,
                score: undefined as number | undefined,
                triggerRate: '—',
                toolCall: '—',
                sessionId: '',
                output: ''
            };
        }

        const states = targetIds.map(id => caseStates[id]?.[side]).filter(Boolean);
        const allRuns = states.flatMap(s => (s.runs && s.runs.length > 0)
            ? s.runs
            : (s.status !== 'pending' ? [{ ...s, runIndex: 1 }] : [])
        );
        const expectedRuns = getExpectedRunCount(targetIds, side);
        const totalCount = Math.max(expectedRuns, allRuns.length || targetIds.length);
        const allSideRuns = targetIds.flatMap(id => {
            const pair = caseStates[id];
            if (!pair) return [];
            return (['a', 'b'] as const).flatMap(group => {
                const state = pair[group];
                return state.runs && state.runs.length > 0
                    ? state.runs
                    : (state.status !== 'pending' ? [{ ...state, runIndex: 1 }] : []);
            });
        });
        const globalExpectedRuns = getExpectedRunCount(targetIds, 'a') + getExpectedRunCount(targetIds, 'b');
        const globalExecutedCount = allSideRuns.filter(s => ['executed', 'evaluating', 'pass', 'fail'].includes(s.status)).length;
        const globalExecutionPending = allSideRuns.length > 0 && globalExecutedCount < globalExpectedRuns;
        const executingCount = allRuns.filter(s => s.status === 'running').length;
        const evaluatingCount = allRuns.filter(s => s.status === 'evaluating').length;
        const failedCount = allRuns.filter(s => s.status === 'fail').length;
        const completedStates = allRuns.filter(s => s.status === 'executed' || s.status === 'evaluating' || s.status === 'pass' || s.status === 'fail');
        const terminalStates = allRuns.filter(s => s.status === 'pass' || s.status === 'fail');
        const executedCount = completedStates.length;
        const completedCount = terminalStates.length;
        const successfulExecutionStates = completedStates.filter(s => s.status !== 'fail');
        const successCount = successfulExecutionStates.length;
        const executionMetricStates = successfulExecutionStates.filter(s => Boolean(s.sessionId) || typeof s.timeCost === 'string' || typeof s.tokenUsage === 'number');
        const executionAvgTime = (() => {
            const seconds = executionMetricStates
                .map(s => typeof s.timeCost === 'string' ? parseFloat(s.timeCost) : 0)
                .filter(n => Number.isFinite(n) && n > 0);
            return seconds.length > 0
                ? `${(seconds.reduce((sum, n) => sum + n, 0) / seconds.length).toFixed(1)}s`
                : '—';
        })();
        const executionAvgTokens = (() => {
            const tokened = executionMetricStates.filter(s => typeof s.tokenUsage === 'number' && (s.tokenUsage || 0) > 0);
            return tokened.length > 0
                ? Math.round(tokened.reduce((sum, s) => sum + (s.tokenUsage || 0), 0) / tokened.length)
                : undefined;
        })();
        const executionSessionId = executionMetricStates.find(s => s.sessionId)?.sessionId || '';
        const executionOutput = executionMetricStates.find(s => s.output)?.output || '';
        const executionTriggerCount = executionMetricStates.filter(s => s.skillTriggered).length;
        const executionTriggerRate = executionMetricStates.length > 0
            ? `${executionTriggerCount}/${executionMetricStates.length} (${Math.round(executionTriggerCount / executionMetricStates.length * 100)}%)`
            : '—';
        const executionToolNames = Array.from(new Set(executionMetricStates.flatMap(s => s.toolCalls || []))).slice(0, 3);
        const executionToolCount = executionMetricStates.reduce((sum, s) => sum + (s.toolCallCount || 0), 0);
        const executionToolCall = executionToolNames.length > 0
            ? `${executionToolNames.join(', ')} · ${executionToolCount}`
            : (executionToolCount > 0 ? `${executionToolCount} calls` : '无');

        // Determine Overall State
        let overallStatus: 'pending' | 'running' | 'evaluating' | 'failed' | 'completed' = 'pending';
        if (allRuns.length === 0) {
            overallStatus = 'pending';
        } else if (globalExecutionPending || executingCount > 0 || executedCount < totalCount) {
            overallStatus = 'running';
        } else if (evaluatingCount > 0 || (completedCount < totalCount && executedCount === totalCount)) {
            overallStatus = 'evaluating';
        } else if (failedCount > 0) {
            overallStatus = 'failed';
        } else if (completedCount === totalCount && totalCount > 0) {
            overallStatus = 'completed';
        }

        if (overallStatus === 'pending') {
            return {
                status: 'pending' as CaseStatus,
                runsCompleted: locale === 'zh' ? `0/${totalCount} 未执行` : `0/${totalCount} Pending`,
                timeCost: '—',
                tokenUsage: undefined as number | undefined,
                score: undefined as number | undefined,
                accuracy: '—',
                triggerRate: '—',
                toolCall: '—',
                sessionId: '',
                output: ''
            };
        }

        if (overallStatus === 'running') {
            return {
                status: 'running' as CaseStatus,
                runsCompleted: locale === 'zh' ? `${executedCount}/${totalCount} 执行中` : `${executedCount}/${totalCount} Running`,
                timeCost: '—',
                tokenUsage: undefined as number | undefined,
                score: undefined as number | undefined,
                accuracy: '—',
                triggerRate: '—',
                toolCall: '—',
                sessionId: '',
                output: ''
            };
        }

        if (overallStatus === 'evaluating') {
            return {
                status: 'evaluating' as CaseStatus,
                runsCompleted: locale === 'zh' ? `${completedCount}/${totalCount} 评估中` : `${completedCount}/${totalCount} Evaluating`,
                timeCost: executionAvgTime,
                tokenUsage: executionAvgTokens,
                score: undefined as number | undefined,
                triggerRate: executionTriggerRate,
                toolCall: executionToolCall,
                accuracy: '—',
                sessionId: executionSessionId,
                output: executionOutput
            };
        }

        if (overallStatus === 'failed') {
            return {
                status: 'fail' as CaseStatus,
                runsCompleted: locale === 'zh'
                    ? `${successCount}/${totalCount} 执行完成 · ${failedCount} 失败`
                    : `${successCount}/${totalCount} completed · ${failedCount} failed`,
                timeCost: executionAvgTime,
                tokenUsage: executionAvgTokens,
                score: undefined as number | undefined,
                triggerRate: executionTriggerRate,
                toolCall: executionToolCall,
                accuracy: '—',
                sessionId: executionSessionId,
                output: executionOutput
            };
        }

        // overallStatus === 'completed'
        let totalTime = 0;
        let totalTokens = 0;
        let totalScore = 0;
        let scoredCount = 0;
        const metricStates = terminalStates.filter(s => typeof s.timeCost === 'string' || typeof s.tokenUsage === 'number');

        metricStates.forEach(s => {
            let seconds = 0;
            if (typeof s.timeCost === 'string') {
                seconds = parseFloat(s.timeCost) || 0;
            } else if (typeof s.timeCost === 'number') {
                seconds = s.timeCost;
            }
            totalTime += seconds;
            totalTokens += (s.tokenUsage || 0);

            if (typeof s.score === 'number') {
                totalScore += s.score;
                scoredCount++;
            }
        });

        const avgTime = metricStates.length > 0 ? (totalTime / metricStates.length).toFixed(1) + 's' : '—';
        const avgTokens = metricStates.length > 0 ? Math.round(totalTokens / metricStates.length) : 0;
        const avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : undefined;

        const triggerCount = terminalStates.filter(s => s.skillTriggered).length;
        const triggerRate = completedCount > 0
            ? `${triggerCount}/${completedCount} (${Math.round(triggerCount / completedCount * 100)}%)`
            : '—';
        const toolNames = Array.from(new Set(terminalStates.flatMap(s => s.toolCalls || []))).slice(0, 3);
        const totalToolCalls = terminalStates.reduce((sum, s) => sum + (s.toolCallCount || 0), 0);
        const toolCall = toolNames.length > 0 ? `${toolNames.join(', ')} · ${totalToolCalls}` : (totalToolCalls > 0 ? `${totalToolCalls} calls` : '无');

        return {
            status: 'executed' as CaseStatus,
            runsCompleted: locale === 'zh' ? `${completedCount}/${totalCount} 执行完成` : `${completedCount}/${totalCount} Completed`,
            timeCost: avgTime,
            tokenUsage: avgTokens || undefined,
            score: avgScore,
            accuracy: avgScore != null ? `${avgScore}%` : '—',
            triggerRate,
            toolCall,
            sessionId: terminalStates[0]?.sessionId || '',
            output: terminalStates[0]?.output || 'Success'
        };
    };

    const simA = getSimData('a');
    const simB = getSimData('b');
    const isCompletedA = simA.status === 'executed' || simA.status === 'pass';
    const isCompletedB = simB.status === 'executed' || simB.status === 'pass';
    const isEvaluatingA = simA.status === 'evaluating';
    const isEvaluatingB = simB.status === 'evaluating';
    const isFailedA = simA.status === 'fail';
    const isFailedB = simB.status === 'fail';
    const taskHasActiveRun = Boolean(currentTask?.activeRun);
    const hasPendingAutoEvaluation = autoEval && hasPendingAutoEvaluationCaseStates(caseStates);
    const runButtonBusy = isTaskRunInFlight || taskHasActiveRun || hasRunningStates(caseStates) || hasPendingAutoEvaluation;
    const selectedCasesHaveResults = checkedCaseIds.length > 0 && checkedCaseIds.some(caseId => {
        const state = caseStates[caseId];
        if (!state) return false;
        return (['a', 'b'] as const).some(side => {
            const sideState = state[side];
            return sideState.status !== 'pending' || (sideState.runs?.length || 0) > 0;
        });
    });
    const currentConfigHasRunResult = selectedCasesHaveResults && currentConfigMatchesLastRun;
    const runButtonLabel = runButtonBusy
        ? (locale === 'zh' ? '执行中' : 'Running')
        : currentConfigHasRunResult
            ? (locale === 'zh' ? '重新执行' : 'Run Again')
            : (locale === 'zh' ? '开始执行' : 'Start Execution');
    const decisionReady = isCompletedA && isCompletedB;
    const experimentVersionReady = Boolean(selectedSkillId && versionBId && versionBId !== NONE_VERSION_ID);
    const configReady = !runButtonBusy && experimentVersionReady && selectedEvaluatorIds.length > 0 && (
        sourceMode === 'dataset'
            ? activeLinkedDatasetIds.length > 0 && selectedSampleCount > 0
            : Boolean(selectedTraceAId || selectedTraceBId || traceRecords.length > 0)
    );
    const runButtonDisabled = !configReady;
    const hasExecutionHistory = currentConfigHasRunResult
        || lastRunCaseIds.length > 0
        || countExecuted > 0
        || countEvaluated > 0
        || decisionReady;
    const executionStageActive = runButtonBusy || (!hasExecutionHistory && configReady);
    const configPillLabel = configReady
        ? (locale === 'zh' ? '✓ 配置完成' : 'Configured')
        : (locale === 'zh' ? '配置中' : 'Configuring');
    const derivedHifiCollapsed = {
        config: configReady || runButtonBusy || hasExecutionHistory,
        exec: runButtonBusy ? false : (hasExecutionHistory ? true : !executionStageActive),
        result: runButtonBusy || !hasExecutionHistory,
    };
    const scoringCaseIds = displayedResultCaseIds.length > 0
        ? displayedResultCaseIds
        : checkedCaseIds.length > 0
            ? checkedCaseIds
            : undefined;
    const abScoring = calculateAbScoring(caseStates, { repeatRounds, caseIds: scoringCaseIds });
    const toneColor = (tone: AbScoringResult['capability']['tone']) => {
        if (tone === 'green') return '#0F6E56';
        if (tone === 'red') return '#DC2626';
        if (tone === 'amber') return '#BA7517';
        return '#5F5E5A';
    };
    const toneBg = (tone: AbScoringResult['capability']['tone']) => {
        if (tone === 'green') return '#E1F5EE';
        if (tone === 'red') return '#FEE2E2';
        if (tone === 'amber') return '#FAEEDA';
        return '#F5F4EE';
    };
    const fmtPct = (value: number | null | undefined, suffix = '%') => value == null ? '—' : `${value > 0 ? '+' : ''}${value}${suffix}`;
    const fmtRate = (value: number | null | undefined) => value == null ? '—' : `${value}%`;
    const fmtScore = (value: number | null | undefined) => value == null ? '—' : String(value);
    const decisionTitle = !decisionReady
        ? (locale === 'zh' ? '等待评估完成' : 'Waiting for evaluation')
        : abScoring.decisionLabel;
    const decisionSubtitle = !decisionReady
        ? (locale === 'zh' ? '待评分' : 'Pending score')
        : abScoring.totalScore == null
            ? (locale === 'zh' ? '— 分' : '— pts')
            : (locale === 'zh' ? `${abScoring.totalScore} 分` : `${abScoring.totalScore} pts`);
    const decisionAdvice = !decisionReady
        ? (locale === 'zh' ? '等待所有执行记录评估完成后，再查看综合判定和上线动作。' : 'Wait for all execution records to finish evaluation before taking a release action.')
        : abScoring.decision === 'insufficient'
            ? (locale === 'zh' ? `当前只有 ${abScoring.sampleSize} 个完成配对样本；N < ${DEFAULT_AB_SCORING_POLICY.minSampleSize} 不输出发布结论，请补齐样本后复测。` : `Only ${abScoring.sampleSize} paired samples are complete; add samples before making a release decision.`)
            : abScoring.decision === 'reject'
                ? (() => {
                    const gateList = abScoring.hardGates.map(g => g.label).join('、');
                    return locale === 'zh'
                        ? `命中 hard gate：${gateList}。至少一个维度已低于拒绝阈值，因此当前结论为打回。建议先按打回类别修正后复测。`
                        : `Hard gate hit: ${abScoring.hardGates.map(g => g.label).join(', ')}. At least one dimension is below the reject threshold, so the current decision is reject. Revise and retest first.`;
                })()
                : abScoring.decision === 'monitor-release'
                    ? (locale === 'zh' ? '可小流量监控发布，并持续观察 Token 成本、触发率和多轮一致性。' : 'Proceed with monitored rollout and watch token cost, invoke rate, and variance.')
                    : (locale === 'zh' ? '三维指标均达标，可进入全量发布，同时保留后续复测记录。' : 'All three dimensions pass; proceed to full release and keep retesting over time.');

    const stepSourceMeta = (() => {
        if (sourceMode === 'trace') {
            const traceCount = [selectedTraceAId, selectedTraceBId].filter(Boolean).length || traceRecords.length;
            return locale === 'zh' ? `${traceCount} 条链路` : `${traceCount} traces`;
        }
        const datasetCount = activeLinkedDatasetIds.length;
        return locale === 'zh' ? `${datasetCount} 数据集` : `${datasetCount} datasets`;
    })();
    const stepConfigMeta = locale === 'zh'
        ? `${selectedSampleCount} 样本 x ${repeatRounds} 轮 · ${stepSourceMeta}`
        : `${selectedSampleCount} samples x ${repeatRounds} rounds · ${stepSourceMeta}`;
    const stepExecutionCaseIds = checkedCaseIds.length > 0 ? checkedCaseIds : lastRunCaseIds;
    const stepExpectedRuns = stepExecutionCaseIds.length * 2 * repeatRounds;
    const countStepRuns = (statusFilter: (status: CaseStatus) => boolean) => {
        return stepExecutionCaseIds.reduce((sum, caseId) => {
            const pair = caseStates[caseId];
            if (!pair) return sum;
            return sum + (['a', 'b'] as const).reduce((sideSum, side) => {
                const sideState = pair[side];
                if (!sideState) return sideSum;
                const runs = sideState.runs && sideState.runs.length > 0
                    ? sideState.runs
                    : (sideState.status !== 'pending' ? [{ ...sideState, runIndex: 1 }] : []);
                return sideSum + runs.filter(run => statusFilter(run.status)).length;
            }, 0);
        }, 0);
    };
    const stepFinishedRuns = countStepRuns(status => ['executed', 'evaluating', 'pass', 'fail'].includes(status));
    const stepScoredRuns = countStepRuns(status => status === 'pass' || status === 'fail');
    const stepExecutionMeta = stepExpectedRuns === 0
        ? (locale === 'zh' ? '0/0 未选择样本' : '0/0 No samples selected')
        : runButtonBusy
            ? (locale === 'zh'
                ? `${stepFinishedRuns}/${stepExpectedRuns} 完成 · 执行中`
                : `${stepFinishedRuns}/${stepExpectedRuns} done · Running`)
            : stepScoredRuns >= stepExpectedRuns
                ? (locale === 'zh'
                    ? `${stepFinishedRuns}/${stepExpectedRuns} 完成 · 已评分`
                    : `${stepFinishedRuns}/${stepExpectedRuns} done · Scored`)
                : autoEval && stepFinishedRuns > stepScoredRuns
                    ? (locale === 'zh'
                        ? `${stepFinishedRuns}/${stepExpectedRuns} 完成 · ${stepScoredRuns}/${stepExpectedRuns} 已评分`
                        : `${stepFinishedRuns}/${stepExpectedRuns} done · ${stepScoredRuns}/${stepExpectedRuns} scored`)
                    : (locale === 'zh'
                        ? `${stepFinishedRuns}/${stepExpectedRuns} 完成 · 待执行`
                        : `${stepFinishedRuns}/${stepExpectedRuns} done · Pending`);
    const stepDecisionMeta = decisionReady
        ? decisionTitle
        : countEvaluated > 0
            ? (locale === 'zh'
                ? `${countEvaluated}/${stepExecutionCaseIds.length || selectedSampleCount} 样本已评估`
                : `${countEvaluated}/${stepExecutionCaseIds.length || selectedSampleCount} samples evaluated`)
            : (locale === 'zh' ? '等待评估完成' : 'Waiting for evaluation');

    const getExecutionRecords = (side: 'a' | 'b') => {
        const targetIds = displayedResultCaseIds.length > 0
            ? displayedResultCaseIds
            : (activeCase?.id ? [activeCase.id] : []);
        return targetIds.flatMap(caseId => {
            const runs = caseStates[caseId]?.[side]?.runs || [];
            return runs.map(run => ({
                caseId,
                roundIndex: run.roundIndex || run.runIndex,
                executionTraceId: run.sessionId || '',
                evaluationTraceId: run.evaluationTraceId || '',
                evaluatorRunId: run.evaluatorRunId || '',
                evaluationResultId: run.evaluationResultId || '',
                evaluations: run.evaluations || [],
                status: run.status,
                score: run.score,
                // 失败相关字段一并透出, modal 显示双 badge + 错误详情用
                failureType: (run as RunResult & { failureType?: string }).failureType,
                failureDetail: (run as RunResult & { failureDetail?: string }).failureDetail,
                output: run.output,
            }));
        });
    };

    const renderExecutionRecordSection = (side: 'a' | 'b') => {
        const records = getExecutionRecords(side);
        const accent = side === 'a' ? '#BA7517' : '#1D9E75';
        const label = side === 'a'
            ? (locale === 'zh' ? 'A 对照组' : 'A Control')
            : (locale === 'zh' ? 'B 实验组' : 'B Experiment');
        return (
            <div style={{ border: '1px solid #E7E5E4', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#FAFAF7', borderBottom: '1px solid #E7E5E4' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#2C2C2A' }}>
                        <span style={{ width: 22, height: 22, borderRadius: 6, background: accent, color: 'white', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>
                            {side.toUpperCase()}
                        </span>
                        {label}
                    </div>
                    <span style={{ fontSize: 12, color: '#888780' }}>{records.length} traces</span>
                </div>
                {records.length === 0 ? (
                    <div style={{ padding: 14, color: '#888780', fontSize: 13 }}>
                        {locale === 'zh' ? '暂无执行记录' : 'No execution records yet'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 420, overflowY: 'auto' }}>
                        {/* 表头行: 列名只显示一次, 每行不再重复 label */}
                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '140px 1fr 1fr 90px 60px 70px',
                                gap: 12,
                                padding: '8px 12px',
                                background: '#FAFAF7',
                                borderBottom: '1px solid #E7E5E4',
                                fontSize: 11,
                                fontWeight: 700,
                                color: '#5F5E5A',
                                textTransform: 'none',
                                letterSpacing: 0,
                                position: 'sticky',
                                top: 0,
                                zIndex: 1,
                            }}
                        >
                            <div>{locale === 'zh' ? 'Case ID' : 'Case ID'}</div>
                            <div>{locale === 'zh' ? '执行 session id' : 'Execution session id'}</div>
                            <div>{locale === 'zh' ? '评估器' : 'Evaluators'}</div>
                            <div>{locale === 'zh' ? '评测结果' : 'Eval result'}</div>
                            <div style={{ textAlign: 'right' }}>{locale === 'zh' ? '分数' : 'Score'}</div>
                            <div style={{ textAlign: 'right' }}>{locale === 'zh' ? '操作' : 'Action'}</div>
                        </div>
                        {records.map((record, idx) => {
                            const hasExecFailure = !!record.failureType;
                            const baseEvalErrMsg = !hasExecFailure && record.status === 'fail'
                                ? (record.output || '评测失败')
                                : '';
                            const recordEvaluations: RunEvaluation[] = (record.evaluations && record.evaluations.length > 0)
                                ? record.evaluations
                                : (record.evaluatorRunId ? [{
                                    evaluatorId: selectedEvaluatorId,
                                    evaluatorName: evaluatorNameById.get(selectedEvaluatorId) || selectedEvaluatorId,
                                    status: record.status === 'pass' ? 'done' : record.status === 'fail' && !hasExecFailure ? 'failed' : record.status === 'evaluating' ? 'running' : 'pending',
                                    evaluatorRunId: record.evaluatorRunId,
                                    evaluationTraceId: record.evaluationTraceId,
                                    score: record.score,
                                    errorMessage: baseEvalErrMsg,
                                }] : []);
                            const { exec, evaluation } = deriveExecAndEval({
                                status: record.status,
                                hasExecFailure,
                                evaluations: recordEvaluations,
                                evaluatorRunId: record.evaluatorRunId,
                            });
                            const execErrMsg = hasExecFailure
                                ? `[${record.failureType}] ${record.failureDetail || record.output || '执行失败'}`
                                : '';
                            const evalErrMsg = (!hasExecFailure && (record.status === 'fail' || recordEvaluations.some(item => item.status === 'failed')))
                                ? (baseEvalErrMsg || recordEvaluations.find(item => item.status === 'failed')?.errorMessage || '评测失败')
                                : '';
                            const failedOrMissingEvaluatorIds = getFailedOrMissingEvaluatorIds({ evaluations: recordEvaluations }, selectedEvaluatorIds);
                            const caseItem = caseLookup.get(record.caseId);
                            const datasetId = caseItem?.datasetId || currentTask?.configJson?.selectedDatasetId;
                            const caseDetailUrl = caseItem?.sourceType === 'trace'
                                ? (caseItem.sourceExecutionSessionId
                                    ? `/trace?taskId=${encodeURIComponent(caseItem.sourceExecutionSessionId)}`
                                    : null)
                                : (datasetId && record.caseId
                                    ? `/dataset/${encodeURIComponent(datasetId)}?case=${encodeURIComponent(record.caseId)}`
                                    : null);
                            const boundEvaluation = pickBoundEvaluationResult(recordEvaluations);
                            const boundEvaluatorRunId = boundEvaluation?.evaluatorRunId || record.evaluatorRunId;
                            const boundEvaluationResultId = boundEvaluation?.evaluationResultId || record.evaluationResultId;
                            const evaluationDetailUrl = record.executionTraceId && boundEvaluatorRunId && boundEvaluationResultId
                                ? (() => {
                                    const qs = new URLSearchParams({
                                        runId: boundEvaluatorRunId,
                                        resultId: boundEvaluationResultId,
                                    });
                                    if (datasetId) qs.set('datasetId', datasetId);
                                    return `/eval/trajectory/${encodeURIComponent(record.executionTraceId)}?${qs.toString()}`;
                                })()
                                : '';
                            const hasScoredEvaluation = recordEvaluations.some(item => item.status === 'done' && typeof item.score === 'number')
                                || typeof record.score === 'number';
                            const caseDetailTitle = caseItem?.sourceType === 'trace'
                                ? [
                                    caseItem.sourceDatasetName ? `dataset: ${caseItem.sourceDatasetName}` : '',
                                    caseItem.sourceUploadId ? `upload: ${caseItem.sourceUploadId}` : '',
                                    caseItem.sourceExecutionSessionId ? `execution: ${caseItem.sourceExecutionSessionId}` : '',
                                ].filter(Boolean).join(' | ')
                                : `R${record.roundIndex || '-'} · ${record.caseId}`;
                            return (
                            <div
                                key={`${side}-${record.caseId}-${record.roundIndex}-${idx}`}
                                style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 90px 60px 70px', gap: 12, alignItems: 'center', padding: '10px 12px', borderTop: '1px solid #F1EFE8', fontSize: 12 }}
                            >
                                {/* Case ID 列: 可点击, 跳到 dataset 详情对应 case */}
                                <div
                                    style={{
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        minWidth: 0,
                                    }}
                                    title={caseDetailTitle}
                                >
                                    <span style={{ color: '#5F5E5A', fontWeight: 600, marginRight: 4 }}>R{record.roundIndex || '-'}</span>
                                    {caseDetailUrl ? (
                                        <a
                                            href={caseDetailUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#185FA5', textDecoration: 'none' }}
                                            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                        >
                                            {record.caseId}
                                        </a>
                                    ) : (
                                        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#5F5E5A' }}>{record.caseId}</span>
                                    )}
                                </div>

                                {/* 执行 session id 列 */}
                                <div style={{ minWidth: 0 }}>
                                    {exec.tone === 'fail' ? (
                                        <HoverTooltip
                                            trigger={<StatusText label={exec.label} tone="fail" />}
                                            content={execErrMsg}
                                        />
                                    ) : exec.tone === 'pending' || exec.tone === 'running' ? (
                                        <StatusText label={exec.label} tone={exec.tone} />
                                    ) : record.executionTraceId ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' }}
                                            onClick={() => window.open(`/trace?taskId=${encodeURIComponent(record.executionTraceId)}`, '_blank')}
                                        >
                                            {record.executionTraceId}
                                        </button>
                                    ) : (
                                        <span style={{ color: '#B8B6AE' }}>—</span>
                                    )}
                                </div>

                                {/* 评估器列: 多评估器摘要 + 折叠明细。明细只展示, 不放重试按钮。 */}
                                <div style={{ minWidth: 0 }}>
                                    {!evaluation ? (
                                        <span style={{ color: '#B8B6AE' }}>—</span>
                                    ) : evaluation.tone === 'fail' && recordEvaluations.length === 0 ? (
                                        <HoverTooltip
                                            trigger={<StatusText label={evaluation.label} tone="fail" />}
                                            content={evalErrMsg}
                                        />
                                    ) : (evaluation.tone === 'pending' || evaluation.tone === 'running') && recordEvaluations.length === 0 ? (
                                        <StatusText label={evaluation.label} tone={evaluation.tone} />
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                            {/* 去重: 移除了上面一排 "任务完成度 N / 轨迹质量 N" 摘要徽章——
                                                与下方明细行的 名称+分数 重复, 且明细已含全部评估器 + 可点击的评测 trace 链接。 */}
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: '#5F5E5A' }}>
                                                {recordEvaluations.map(item => {
                                                    const tone: BadgeTone = item.status === 'done' ? 'done' : item.status === 'failed' ? 'fail' : item.status === 'running' ? 'running' : 'pending';
                                                    return (
                                                        <div key={`${item.evaluatorId}-${item.evaluatorRunId || ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 1fr) minmax(80px, 1fr) 44px', gap: 6, alignItems: 'center' }}>
                                                                <span title={item.evaluatorName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.evaluatorName}</span>
                                                                {item.evaluationTraceId ? (
                                                                    <button
                                                                        className="v2-action-btn"
                                                                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' }}
                                                                        onClick={() => window.open(`/trace?taskId=${encodeURIComponent(item.evaluationTraceId || '')}`, '_blank')}
                                                                        title={item.evaluatorRunId ? `runId: ${item.evaluatorRunId}` : undefined}
                                                                    >
                                                                        {item.evaluationTraceId}
                                                                    </button>
                                                                ) : (
                                                                    <StatusText label={item.status === 'done' ? '已评测' : item.status === 'failed' ? '失败' : item.status === 'running' ? '评测中' : '待评'} tone={tone} />
                                                                )}
                                                                <span style={{ textAlign: 'right', fontWeight: 700, color: item.status === 'failed' ? '#B91C1C' : accent }}>
                                                                    {typeof item.score === 'number' ? item.score : '—'}
                                                                </span>
                                                            </div>
                                                            {item.status === 'failed' && item.errorMessage ? (
                                                                // 直接把失败原因显示出来(不再只藏在 hover):用户"完全看不到原因"的修复。
                                                                <div style={{ fontSize: 10.5, color: '#B91C1C', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.errorMessage}>
                                                                    ⚠ {item.errorMessage}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* 评测结果列: 只有绑定到明确的 TrajectoryEvalResult.id 时才允许跳转。 */}
                                <div>
                                    {evaluationDetailUrl && hasScoredEvaluation ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{
                                                fontSize: 11,
                                                padding: '3px 8px',
                                                background: '#EEF2FF',
                                                color: '#4F46E5',
                                                border: '1px solid rgba(79,70,229,.25)',
                                                borderRadius: 4,
                                                cursor: 'pointer',
                                                fontWeight: 600,
                                                whiteSpace: 'nowrap',
                                            }}
                                            title={`跳转到单条评测详情 runId=${boundEvaluatorRunId}, trace=${record.executionTraceId}, resultId=${boundEvaluationResultId}`}
                                            onClick={() => window.open(evaluationDetailUrl, '_blank')}
                                        >
                                            📋 {locale === 'zh' ? '查看' : 'View'}
                                        </button>
                                    ) : evaluation ? (
                                        // 没出分时不显示"查看"(避免误导:待评/评测中也能点进去却没结果),改显评测状态。
                                        <StatusText label={evaluation.label} tone={evaluation.tone} />
                                    ) : record.evaluatorRunId ? (
                                        <StatusText label={locale === 'zh' ? '结果未绑定' : 'Unbound'} tone="fail" />
                                    ) : (
                                        <span style={{ color: '#B8B6AE', fontSize: 11 }}>—</span>
                                    )}
                                </div>

                                <div style={{ textAlign: 'right', color: accent, fontWeight: 700, fontSize: 14 }}>
                                    {typeof record.score === 'number' ? record.score : '—'}
                                </div>

                                {/* 操作列: 失败行才显示重试按钮; in-flight 时显示"重试中"灰按钮 */}
                                <div style={{ textAlign: 'right' }}>
                                    {(() => {
                                        const ri = record.roundIndex || 1;
                                        const flightKey = retryKey(record.caseId, side, ri);
                                        // 读 state 而不是 ref —— 让 React 自己跟踪依赖, retry 状态变化
                                        // 立刻触发 re-render 切换 "重试中" 按钮显示。click handler 那边
                                        // 还要靠 inFlightRetriesRef 同步判重防止 React commit 前的双击。
                                        const isInFlight = inFlightRetries.has(flightKey);
                                        const isFailRow = exec.tone === 'fail' || (evaluation && evaluation.tone === 'fail');
                                        const isEvalFailRow = !hasExecFailure && Boolean(evaluation && evaluation.tone === 'fail');
                                        if (isInFlight) {
                                            return (
                                                <button
                                                    className="v2-action-btn"
                                                    disabled
                                                    style={{
                                                        fontSize: 11,
                                                        padding: '4px 8px',
                                                        background: '#E7E5E4',
                                                        color: '#78716C',
                                                        border: 'none',
                                                        borderRadius: 4,
                                                        cursor: 'not-allowed',
                                                        whiteSpace: 'nowrap',
                                                        opacity: 0.85,
                                                    }}
                                                    title={locale === 'zh'
                                                        ? '重试进行中, 请等待结果。如需打断, 点击顶部「终止」按钮。'
                                                        : 'Retry in progress; wait for result or use top Abort button to interrupt.'}
                                                >
                                                    ⏳ {locale === 'zh' ? '重试中' : 'Retrying'}
                                                </button>
                                            );
                                        }
                                        if (!isFailRow) {
                                            return <span style={{ color: '#B8B6AE', fontSize: 11 }}>—</span>;
                                        }
                                        return (
                                            <button
                                                className="v2-action-btn"
                                                style={{
                                                    fontSize: 11,
                                                    padding: '4px 8px',
                                                    background: '#1C1917',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: 4,
                                                    cursor: 'pointer',
                                                    whiteSpace: 'nowrap',
                                                }}
                                                title={hasExecFailure
                                                    ? (locale === 'zh' ? '执行失败 → 从执行重试 (会自动评测)' : 'Retry from execution (auto-evaluate)')
                                                    : (locale === 'zh' ? '评测失败 → 仅重新评失败或缺失的评估器 (复用现有 session)' : 'Retry failed or missing evaluators only')}
                                                onClick={() => {
                                                    if (hasExecFailure) {
                                                        void retryExecution(record.caseId, side, ri);
                                                    } else {
                                                        void retryEvaluation(record.caseId, side, ri, failedOrMissingEvaluatorIds);
                                                    }
                                                }}
                                            >
                                                🔁 {isEvalFailRow ? (locale === 'zh' ? '重评' : 'Re-evaluate') : (locale === 'zh' ? '重跑' : 'Rerun')}
                                            </button>
                                        );
                                    })()}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    // Stepper state
    const getStepStatus = (step: number) => {
        if (step === 1) {
            return 'done';
        }
        if (step === 2) {
            return countExecuted > 0 || hasActiveCaseRun ? 'done' : 'active';
        }
        if (step === 3) {
            return countEvaluated > 0 || hasActiveCaseRun ? 'active' : 'pending';
        }
        return 'pending';
    };

    // ── Hi-fi task-row derived values (only meaningful when `hifi` is true).
    // Kept tight: a single state mapping + a couple of formatted strings.
    // The status pill uses the same decision/decisionReady the verdict card uses,
    // so the two never disagree.
    const hifiTimeLabel = currentTask?.createdAt
        ? new Date(currentTask.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
        : (locale === 'zh' ? '未保存' : 'Unsaved');
    let hifiStateClass = '';
    let hifiStateLabel: string = locale === 'zh' ? '草稿' : 'Draft';
    if (isTaskRunInFlight) {
        hifiStateClass = 'is-running';
        hifiStateLabel = locale === 'zh' ? '运行中' : 'Running';
    } else if (decisionReady) {
        if (abScoring.decision === 'direct-release') {
            hifiStateClass = 'is-done';
            hifiStateLabel = locale === 'zh' ? '已通过' : 'Pass';
        } else if (abScoring.decision === 'reject') {
            hifiStateClass = 'is-reject';
            hifiStateLabel = locale === 'zh' ? '打回' : 'Reject';
        } else if (abScoring.decision === 'insufficient') {
            hifiStateClass = 'is-warn';
            hifiStateLabel = locale === 'zh' ? '样本不足' : 'Insufficient';
        } else {
            hifiStateClass = 'is-warn';
            hifiStateLabel = locale === 'zh' ? '需关注' : 'Review';
        }
    } else if (currentTask) {
        hifiStateLabel = locale === 'zh' ? '待执行' : 'Pending';
    }
    const allEvaluatorOptions = useMemo(
        () => BUILT_IN_EVALUATORS,
        [],
    );
    const evaluatorNameById = useMemo(
        () => new Map(allEvaluatorOptions.map(ev => [ev.id, ev.name] as [string, string])),
        [allEvaluatorOptions],
    );
    const selectedEvaluatorIsBuiltIn = selectedEvaluatorIds.every(id => BUILT_IN_EVALUATORS.some(ev => ev.id === id));
    useEffect(() => {
        if (!hifi || hasManualHifiCollapseOverride) return;
        setHifiCollapsed(prev => (
            prev.config === derivedHifiCollapsed.config
            && prev.exec === derivedHifiCollapsed.exec
            && prev.result === derivedHifiCollapsed.result
        ) ? prev : derivedHifiCollapsed);
    }, [derivedHifiCollapsed, hasManualHifiCollapseOverride, hifi]);
    useEffect(() => {
        if (!hifi) return;
        setHasManualHifiCollapseOverride(false);
    }, [currentTask?.id, hifi]);
    const repeatRoundOptions = useMemo(() => ([
        { value: '1', label: locale === 'zh' ? '1 轮' : '1 round' },
        { value: '2', label: locale === 'zh' ? '2 轮' : '2 rounds' },
        { value: '3', label: locale === 'zh' ? '3 轮' : '3 rounds' },
        { value: '5', label: locale === 'zh' ? '5 轮' : '5 rounds' },
        { value: '10', label: locale === 'zh' ? '10 轮' : '10 rounds' },
    ]), [locale]);
    const evaluatorSummary = selectedEvaluatorIds.length === 0
        ? (locale === 'zh' ? '请选择评估器' : 'Select evaluators')
        : selectedEvaluatorIds.length <= 2
            ? selectedEvaluatorIds.map(id => evaluatorNameById.get(id) || id).join('、')
            : `${selectedEvaluatorIds.slice(0, 2).map(id => evaluatorNameById.get(id) || id).join('、')} ${locale === 'zh' ? `等 ${selectedEvaluatorIds.length} 项` : `and ${selectedEvaluatorIds.length - 2} more`}`;
    const setEvaluatorSelection = (ids: string[]) => {
        const next = normalizeEvaluatorIds(ids);
        setSelectedEvaluatorIds(next);
        setSelectedEvaluatorId(next[0] || '');
        if (currentTask) {
            persistTaskUpdate(currentTask.id, {
                ...currentConfigRef.current,
                evaluatorId: next[0] || '',
                evaluators: next,
            });
        }
    };
    const toggleEvaluatorSelection = (id: string) => {
        if (!id) return;
        const next = selectedEvaluatorIds.includes(id)
            ? selectedEvaluatorIds.filter(item => item !== id)
            : [...selectedEvaluatorIds, id];
        setEvaluatorSelection(next);
    };
    const datasetSummary = activeLinkedDatasetIds.length === 0
        ? (locale === 'zh' ? '请选择数据集' : 'Select datasets')
        : activeLinkedDatasetIds.length <= 2
            ? activeLinkedDatasetIds
                .map(id => datasets.find(ds => ds.id === id)?.name || id)
                .join('、')
            : `${activeLinkedDatasetIds.slice(0, 2).map(id => datasets.find(ds => ds.id === id)?.name || id).join('、')} ${locale === 'zh' ? `等 ${activeLinkedDatasetIds.length} 项` : `and ${activeLinkedDatasetIds.length - 2} more`}`;
    const setDatasetSelection = (ids: string[]) => {
        const next = uniqueIds(ids);
        const primaryDatasetId = next[0] || '';
        setLinkedDatasetIds(next);
        setSelectedDatasetId(primaryDatasetId);
        setCheckedCaseIds([]);
        if (currentTask) {
            persistTaskUpdate(currentTask.id, {
                ...currentConfigRef.current,
                selectedDatasetId: primaryDatasetId,
                linkedDatasetIds: next,
                selectedCaseIds: [],
                checkedCaseIds: [],
                selectedCaseId: '',
            });
        }
    };
    const toggleDatasetSelection = (id: string) => {
        if (!id) return;
        const next = activeLinkedDatasetIds.includes(id)
            ? activeLinkedDatasetIds.filter(item => item !== id)
            : [...activeLinkedDatasetIds, id];
        setDatasetSelection(next);
    };
    const controlVersionOptions = useMemo(
        () => [
            { value: NONE_VERSION_ID, label: locale === 'zh' ? '无 Skill' : 'No Skill' },
            ...versions.map(v => ({ value: v.id, label: `v${v.semanticVersion || v.version}` })),
        ],
        [NONE_VERSION_ID, locale, versions],
    );
    const controlVersionHint = versionAId === NONE_VERSION_ID
        ? (locale === 'zh' ? '默认对照组不加载 Skill，也可选择同 Skill 的历史版本' : 'Control runs without Skill by default; a previous version is optional')
        : `${locale === 'zh' ? '对照组加载' : 'Control loads'} ${selectedSkill?.name || 'Skill'} ${getVersionLabel(versionA || versionAId)}`;
    const getAbAgentName = (versionId: string) => versionId === NONE_VERSION_ID
        ? 'grayscale-baseline-agent'
        : 'grayscale-skill-agent';
    const getAbAgentLabel = (versionId: string) => versionId === NONE_VERSION_ID
        ? (locale === 'zh' ? '基线 Agent' : 'Baseline Agent')
        : (locale === 'zh' ? 'Skill Agent' : 'Skill Agent');
    const getAbAgentHint = (versionId: string) => `${getAbAgentLabel(versionId)} · ${getAbAgentName(versionId)}`;
    const agentHintA = getAbAgentHint(versionAId || NONE_VERSION_ID);
    const repeatRoundsHint = repeatRounds > 1
        ? (locale === 'zh' ? '多轮运行可观察波动和稳定性' : 'Multiple rounds reveal variance and stability')
        : (locale === 'zh' ? '单轮适合快速试跑与校验配置' : 'One round is best for quick validation');
    const selectedDatasetCaseCount = activeLinkedDatasetIds.reduce((sum, id) => {
        const dataset = datasets.find(ds => ds.id === id);
        return sum + (Array.isArray(dataset?.cases) ? dataset.cases.length : 0);
    }, 0);
    const datasetHint = activeLinkedDatasetIds.length > 0
        ? `${locale === 'zh' ? '当前共选择' : 'Selected'} ${activeLinkedDatasetIds.length} ${locale === 'zh' ? '个数据集，合计' : 'datasets with'} ${selectedDatasetCaseCount} ${locale === 'zh' ? '条样本' : 'cases'}`
        : (locale === 'zh' ? '先选择数据集，再勾选要执行的样本' : 'Choose datasets before selecting cases');
    const evaluatorHint = selectedEvaluatorIsBuiltIn
        ? (locale === 'zh' ? '使用预置评估器，适合直接开始评测' : 'Built-in evaluator for a quick start')
        : (locale === 'zh' ? '使用自定义评估器，适合特定业务规则' : 'Custom evaluator for domain-specific scoring');

    return (
        <div className={`ab-page-v2${hifi ? ' gray-hifi' : ''}`} style={{ paddingBottom: 60 }}>
            {/* Stepper & Header Block */}
            <div style={{ padding: '24px 28px 12px 28px' }}>
                {hifi && (
                    <div className="gh-task-row">
                        <div className="gh-task-title-row">
                            {isEditingTask ? (
                                <input
                                    ref={taskTitleInputRef}
                                    className="gh-task-title"
                                    value={taskNameInput}
                                    onChange={e => setTaskNameInput(e.target.value)}
                                    onBlur={finishTaskTitleEdit}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            finishTaskTitleEdit();
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            setTaskNameInput(currentTask?.taskName || '');
                                            setIsEditingTask(false);
                                        }
                                    }}
                                    placeholder={taskTitlePlaceholder}
                                    spellCheck={false}
                                    aria-label={locale === 'zh' ? '任务名称' : 'Task name'}
                                />
                            ) : (
                                <button
                                    type="button"
                                    className={`gh-task-title-trigger${taskTitleIsPlaceholder ? ' is-placeholder' : ''}`}
                                    onClick={beginTaskTitleEdit}
                                    aria-label={locale === 'zh' ? '编辑任务名称' : 'Edit task name'}
                                >
                                    {taskTitleDisplay}
                                </button>
                            )}
                            <span className={`gh-task-state ${hifiStateClass}`}>{hifiStateLabel}</span>
                            <span className="gh-task-cat">A/B Compare</span>
                        </div>
                        <div className="gh-task-info-row">
                            <div className="gh-task-meta">
                                <span className="gh-task-meta-item">
                                    <span className="ico">⏱</span>{hifiTimeLabel}
                                </span>
                            </div>
                            <div className="gh-task-actions">
                                {/* 「新建任务」嵌入模式也显示(同 skill 版本可建多个不同名任务)。
                                    加 accent 边框/字色,跟普通灰按钮区分开,凸显新建。 */}
                                <button
                                    type="button"
                                    className="gh-btn"
                                    onClick={handleNewTask}
                                    style={{ borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }}
                                >
                                    + {locale === 'zh' ? '新建任务' : 'New Task'}
                                </button>
                                <button
                                    type="button"
                                    className="gh-btn"
                                    onClick={() => setShowHistoryDrawer(true)}
                                >
                                    {locale === 'zh' ? '历史任务' : 'History'}
                                </button>
                                <button type="button" className="gh-btn" onClick={handleSaveTask}>
                                    {locale === 'zh' ? '保存配置' : 'Save'}
                                </button>
                                <button
                                    type="button"
                                    className="gh-btn is-primary"
                                    onClick={runComparisonForCheckedCases}
                                    disabled={runButtonDisabled}
                                >
                                    ▶ {locale === 'zh' ? '复测' : 'Re-run'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {!onBack && (
                    <div className="sa-back-line" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 16px 0' }}>
                        <button
                            className="sa-back-btn"
                            onClick={() => router.push('/skill-eval')}
                        >
                            <span>←</span>
                            {locale === 'zh' ? '返回综合分析' : 'Back to Dashboard'}
                        </button>
                        <span>/</span>
                        <b>{locale === 'zh' ? 'A/B测试' : 'A/B Testing'}</b>
                    </div>
                )}

                {/* 新建任务草稿条:经典视图(非 hifi、独立模式)本来没有"命名 + 保存"的入口,
                    点了头部「新建任务」进入草稿态(currentTask=null)后,这条出现,让用户给新任务起名并创建。
                    复用 handleSaveTask(无 currentTask 时走 createTaskForBinding 建新任务)。 */}
                {!parentSkillId && !currentTask && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                        background: '#FAF5FF', border: '1px dashed var(--accent, #7E22CE)',
                        borderRadius: 12, padding: '14px 18px', marginBottom: 16,
                    }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#7E22CE', whiteSpace: 'nowrap' }}>
                            + {locale === 'zh' ? '新建 A/B 任务' : 'New A/B Task'}
                        </span>
                        <input
                            value={taskNameInput}
                            onChange={e => setTaskNameInput(e.target.value)}
                            placeholder={locale === 'zh' ? '给这个任务起个名字…' : 'Name this task…'}
                            spellCheck={false}
                            style={{
                                flex: 1, minWidth: 200, height: 34, borderRadius: 6,
                                border: '1px solid #E7E5E4', padding: '0 12px', fontSize: 13, outline: 'none',
                            }}
                        />
                        <button
                            type="button"
                            onClick={handleSaveTask}
                            disabled={!selectedSkillId || !versionBId || versionBId === NONE_VERSION_ID || !taskNameInput.trim() || isCreatingTask}
                            style={{
                                height: 34, padding: '0 18px', borderRadius: 6, border: 'none',
                                background: '#7E22CE', color: '#fff', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                                cursor: (!selectedSkillId || !versionBId || versionBId === NONE_VERSION_ID || !taskNameInput.trim() || isCreatingTask) ? 'not-allowed' : 'pointer',
                                opacity: (!selectedSkillId || !versionBId || versionBId === NONE_VERSION_ID || !taskNameInput.trim() || isCreatingTask) ? 0.5 : 1,
                            }}
                        >
                            {locale === 'zh' ? '创建任务' : 'Create'}
                        </button>
                        <span style={{ fontSize: 11, color: '#A1A1AA', whiteSpace: 'nowrap' }}>
                            {locale === 'zh' ? '先在下方选好 Skill 与 B 实验版本' : 'Pick a skill & B version below'}
                        </span>
                    </div>
                )}

                {/* Active Skill Summary White Card */}
                <div className="gh-skill-summary" style={{
                    background: 'white',
                    borderRadius: 12,
                    padding: '20px 24px',
                    color: '#1C1917',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 20,
                    marginBottom: 16,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.05)',
                    border: '1px solid rgba(0,0,0,0.08)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{
                            width: 44,
                            height: 44,
                            borderRadius: 8,
                            background: '#3730A3',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 14,
                            fontWeight: 700,
                            color: 'white',
                            fontFamily: 'ui-monospace, monospace'
                        }}>
                            {selectedSkill?.name ? selectedSkill.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() : 'SKL'}
                        </div>
                        <div>
                            {/* Target Skill & Version Selectors */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                                
                                {/* Skill Selector */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <span style={{ fontSize: 9, color: '#78716C', fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>评测 Skill 对象</span>
                                    <select
                                        value={selectedSkillId}
                                        onChange={e => {
                                            if (currentTask) return;
                                            setSelectedSkillId(e.target.value);
                                        }}
                                        disabled={Boolean(currentTask)}
                                        style={{
                                            background: '#F5F5F4',
                                            border: '1px solid #E7E5E4',
                                            color: '#1C1917',
                                            borderRadius: 6,
                                            padding: '6px 12px',
                                            fontSize: 14,
                                            fontWeight: 700,
                                            cursor: currentTask ? 'not-allowed' : 'pointer',
                                            opacity: currentTask ? 0.75 : 1,
                                            outline: 'none',
                                            minWidth: 160,
                                            height: 34
                                        }}
                                    >
                                        {skills.map(s => (
                                            <option key={s.id} value={s.id} style={{ background: 'white', color: '#1C1917' }}>
                                                {s.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Version A Selector */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <span style={{ fontSize: 9, color: '#78716C', fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>A 对照版本</span>
                                    <select
                                        value={versionAId}
                                        onChange={e => setVersionAId(e.target.value)}
                                        style={{
                                            background: '#F5F5F4',
                                            border: '1px solid #E7E5E4',
                                            color: '#1C1917',
                                            borderRadius: 6,
                                            padding: '6px 12px',
                                            fontSize: 13,
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            outline: 'none',
                                            minWidth: 120,
                                            height: 34
                                        }}
                                    >
                                        <option value={NONE_VERSION_ID} style={{ background: 'white', color: '#1C1917' }}>
                                            {locale === 'zh' ? '无 Skill' : 'No Skill'}
                                        </option>
                                        {versions.map(v => (
                                            <option key={v.id} value={v.id} style={{ background: 'white', color: '#1C1917' }}>
                                                v{v.semanticVersion || v.version}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Version B Selector */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <span style={{ fontSize: 9, color: '#78716C', fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>B 实验版本</span>
                                    <select
                                        value={versionBId}
                                        onChange={e => {
                                            if (currentTask) return;
                                            setVersionBId(e.target.value);
                                        }}
                                        disabled={Boolean(currentTask)}
                                        style={{
                                            background: '#F5F5F4',
                                            border: '1px solid #E7E5E4',
                                            color: '#1C1917',
                                            borderRadius: 6,
                                            padding: '6px 12px',
                                            fontSize: 13,
                                            fontWeight: 600,
                                            cursor: currentTask ? 'not-allowed' : 'pointer',
                                            opacity: currentTask ? 0.75 : 1,
                                            outline: 'none',
                                            minWidth: 120,
                                            height: 34
                                        }}
                                    >
                                        <option value={NONE_VERSION_ID} style={{ background: 'white', color: '#1C1917' }}>
                                            {locale === 'zh' ? '无 Skill' : 'No Skill'}
                                        </option>
                                        {versions.map(v => (
                                            <option key={v.id} value={v.id} style={{ background: 'white', color: '#1C1917' }}>
                                                v{v.semanticVersion || v.version}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {hifi && (() => {
                    // Hi-fi stepper — single connected line with an origin pill on the left.
                    // Fills the connector based on how many steps are 'done'; an 'active' step
                    // does not advance the line further (it pulses on its own circle).
                    const stepStatuses = [getStepStatus(1), getStepStatus(2), getStepStatus(3)] as const;
                    const doneCount = stepStatuses.filter(s => s === 'done').length;
                    const ghDonePct = doneCount === 0 ? 0 : doneCount >= 2 ? 100 : 50;
                    const stepNames = locale === 'zh'
                        ? ['配置', '运行 · A/B 评测', '测评结果']
                        : ['Config · Cases', 'Run · A/B Eval', 'Result · Analysis'];
                    const stepMetas = [stepConfigMeta, stepExecutionMeta, stepDecisionMeta];
                    return (
                        <div
                            className="gh-stepper"
                            style={{ ['--gh-done-pct' as string]: `${ghDonePct}%` } as React.CSSProperties}
                        >
                            <div className="gh-stepper-row">
                                <div className="gh-step gh-step-origin">
                                    <div className="gh-step-circle" />
                                    <div className="gh-step-body">
                                        <div className="gh-step-name">
                                            {locale === 'zh' ? 'A/B 测试' : 'A/B Testing'}
                                        </div>
                                        <div className="gh-step-sub">
                                            {locale === 'zh' ? '启用 vs 未启用 Skill 的差异对照' : 'Skill on vs off comparison'}
                                        </div>
                                    </div>
                                </div>
                                {([1, 2, 3] as const).map(n => {
                                    const status = stepStatuses[n - 1];
                                    const cls = status === 'done' ? 'is-done' : status === 'active' ? 'is-active' : 'is-idle';
                                    return (
                                        <div key={n} className={`gh-step ${cls}`}>
                                            <div className="gh-step-circle">
                                                {status === 'done' ? null : <span>{n}</span>}
                                            </div>
                                            <div className="gh-step-body">
                                                <div className="gh-step-name">{stepNames[n - 1]}</div>
                                                <div className="gh-step-sub">{stepMetas[n - 1]}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {/* Progress Stepper — design: foundations.md §P.2 (no backdrop-blur outside AppTopBar), tokens only. */}
                <div
                    className="v2-stepper"
                    style={{
                        position: 'sticky',
                        top: 16,
                        zIndex: 40,
                        background: 'var(--card-bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                    }}
                >
                    <div className={`v2-step ${getStepStatus(1)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(1) === 'done' ? <CheckIcon /> : '1'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 1 · CONFIG</span>
                            <span className="v2-step-name">{locale === 'zh' ? '准备: 配置实验参数' : 'Config params'}</span>
                            <span className="v2-step-meta" style={{ color: 'var(--success)' }}>{stepConfigMeta}</span>
                        </div>
                    </div>
                    <div className={`v2-step ${getStepStatus(2)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(2) === 'done' ? <CheckIcon /> : '2'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 2 · EXECUTION</span>
                            <span className="v2-step-name">{locale === 'zh' ? '执行: 运行 A/B 测试' : 'Run A/B Testing'}</span>
                            <span className="v2-step-meta" style={{ color: 'var(--success)' }}>{stepExecutionMeta}</span>
                        </div>
                    </div>
                    <div className={`v2-step ${getStepStatus(3)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(3) === 'done' ? <CheckIcon /> : '3'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 3 · DECISION</span>
                            <span className="v2-step-name">{locale === 'zh' ? '决策: 综合判定 & 上线' : 'Decision verdict'}</span>
                            <span className="v2-step-meta" style={{ color: 'var(--primary)', fontWeight: 600 }}>{stepDecisionMeta}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* CARD 1: 实验配置 */}
                <div
                    className="v2-stage-card config"
                    style={{ background: 'white', border: '0.5px solid rgba(0,0,0,0.08)' }}
                    data-collapsible={hifi ? '1' : undefined}
                    data-collapsed={hifi ? (hifiCollapsed.config ? '1' : '0') : undefined}
                >
                    <div
                        className="v2-stage-card-header"
                        style={{ borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}
                        onClick={hifi ? () => toggleHifiCard('config') : undefined}
                    >
                        <div className="v2-stage-num-badge">
                            <GearIcon />
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title">
                                {locale === 'zh' ? '配置' : 'Config'}
                                <span className={`v2-stage-pill ${configReady ? 'done' : 'pending'}`} style={{ background: configReady ? '#E1F5EE' : '#F5F4EE', color: configReady ? '#0F6E56' : '#5F5E5A', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                                    {configPillLabel}
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">{locale === 'zh' ? '设置参数 · 实验版本由 Skill 分析决定，对照版本由本配置决定' : 'Set up parameters · Experiment version comes from Skill analysis, control version from this config'}</div>
                        </div>
                        {hifi && (
                            <button
                                type="button"
                                className="gh-card-chev"
                                aria-label={hifiCollapsed.config ? (locale === 'zh' ? '展开' : 'Expand') : (locale === 'zh' ? '折叠' : 'Collapse')}
                                onClick={e => { e.stopPropagation(); toggleHifiCard('config'); }}
                            />
                        )}
                    </div>
                    <div className="v2-stage-card-body">
                        <div className="v2-config-grid">
                            <div className="v2-config-item v2-config-item--compact">
                                <span className="v2-config-item-label">
                                    {locale === 'zh' ? '重复轮次' : 'Repeat rounds'} <span className="req">*</span>
                                </span>
                                <Select
                                    aria-label={locale === 'zh' ? '选择重复轮次' : 'Select repeat rounds'}
                                    value={String(repeatRounds)}
                                    onChange={value => {
                                        const v = Number(value);
                                        setRepeatRounds(v);
                                        if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, repeatRounds: v });
                                    }}
                                    options={repeatRoundOptions}
                                    active={repeatRounds > 1}
                                    size="sm"
                                    className="v2-config-select"
                                />
                                <span className="v2-config-item-hint">{repeatRoundsHint}</span>
                            </div>

                            <div className="v2-config-item v2-config-item--compact">
                                <span className="v2-config-item-label">{locale === 'zh' ? '数据集' : 'Dataset'}</span>
                                <div style={{ position: 'relative' }}>
                                    <button
                                        type="button"
                                        aria-label={locale === 'zh' ? '选择数据集' : 'Select datasets'}
                                        className="v2-config-select"
                                        onClick={() => setShowDatasetDropdown(open => !open)}
                                        style={{
                                            width: '100%',
                                            minHeight: 34,
                                            border: activeLinkedDatasetIds.length > 0 ? '1px solid var(--primary)' : '1px solid var(--border)',
                                            borderRadius: 6,
                                            background: 'var(--background)',
                                            color: activeLinkedDatasetIds.length > 0 ? 'var(--foreground)' : 'var(--foreground-muted)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            padding: '0 10px',
                                            fontSize: 13,
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {datasetSummary}
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                            {activeLinkedDatasetIds.length > 0 && (
                                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-subtle)', borderRadius: 99, padding: '0 6px' }}>
                                                    {activeLinkedDatasetIds.length}
                                                </span>
                                            )}
                                            <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>{showDatasetDropdown ? '▲' : '▼'}</span>
                                        </span>
                                    </button>
                                    {showDatasetDropdown && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: 'calc(100% + 4px)',
                                                left: 0,
                                                right: 0,
                                                zIndex: 60,
                                                background: 'var(--background)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 8,
                                                boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                                                maxHeight: 240,
                                                overflowY: 'auto',
                                                padding: 4,
                                            }}
                                        >
                                            {datasets.map(dataset => {
                                                const checked = activeLinkedDatasetIds.includes(dataset.id);
                                                return (
                                                    <button
                                                        key={dataset.id}
                                                        type="button"
                                                        onClick={() => toggleDatasetSelection(dataset.id)}
                                                        style={{
                                                            width: '100%',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 8,
                                                            padding: '7px 9px',
                                                            border: 'none',
                                                            borderRadius: 5,
                                                            background: checked ? 'var(--primary-subtle)' : 'transparent',
                                                            color: 'var(--foreground)',
                                                            cursor: 'pointer',
                                                            fontSize: 12.5,
                                                            textAlign: 'left',
                                                        }}
                                                    >
                                                        <span
                                                            style={{
                                                                width: 15,
                                                                height: 15,
                                                                borderRadius: 4,
                                                                border: checked ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                                background: checked ? 'var(--primary)' : 'var(--background)',
                                                                color: 'var(--primary-foreground)',
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                fontSize: 10,
                                                                fontWeight: 700,
                                                                flexShrink: 0,
                                                            }}
                                                        >
                                                            {checked ? '✓' : ''}
                                                        </span>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dataset.name}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                                <span className="v2-config-item-hint">{datasetHint}</span>
                            </div>

                            <div className="v2-config-item v2-config-item--compact">
                                <span className="v2-config-item-label">{locale === 'zh' ? '评估器' : 'Evaluator'}</span>
                                <div style={{ position: 'relative' }}>
                                    <button
                                        type="button"
                                        aria-label={locale === 'zh' ? '选择评估器' : 'Select evaluators'}
                                        className="v2-config-select"
                                        onClick={() => setShowEvalDropdown(open => !open)}
                                        style={{
                                            width: '100%',
                                            minHeight: 34,
                                            border: selectedEvaluatorIds.length > 0 ? '1px solid var(--primary)' : '1px solid var(--border)',
                                            borderRadius: 6,
                                            background: 'var(--background)',
                                            color: selectedEvaluatorIds.length > 0 ? 'var(--foreground)' : 'var(--foreground-muted)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            padding: '0 10px',
                                            fontSize: 13,
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {evaluatorSummary}
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                            {selectedEvaluatorIds.length > 0 && (
                                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-subtle)', borderRadius: 99, padding: '0 6px' }}>
                                                    {selectedEvaluatorIds.length}
                                                </span>
                                            )}
                                            <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>{showEvalDropdown ? '▲' : '▼'}</span>
                                        </span>
                                    </button>
                                    {showEvalDropdown && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: 'calc(100% + 4px)',
                                                left: 0,
                                                right: 0,
                                                zIndex: 60,
                                                background: 'var(--background)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 8,
                                                boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                                                maxHeight: 240,
                                                overflowY: 'auto',
                                                padding: 4,
                                            }}
                                        >
                                            {allEvaluatorOptions.map(option => {
                                                const checked = selectedEvaluatorIds.includes(option.id);
                                                return (
                                                    <button
                                                        key={option.id}
                                                        type="button"
                                                        onClick={() => toggleEvaluatorSelection(option.id)}
                                                        style={{
                                                            width: '100%',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 8,
                                                            padding: '7px 9px',
                                                            border: 'none',
                                                            borderRadius: 5,
                                                            background: checked ? 'var(--primary-subtle)' : 'transparent',
                                                            color: 'var(--foreground)',
                                                            cursor: 'pointer',
                                                            fontSize: 12.5,
                                                            textAlign: 'left',
                                                        }}
                                                    >
                                                        <span
                                                            style={{
                                                                width: 15,
                                                                height: 15,
                                                                borderRadius: 4,
                                                                border: checked ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                                background: checked ? 'var(--primary)' : 'var(--background)',
                                                                color: 'var(--primary-foreground)',
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                fontSize: 10,
                                                                fontWeight: 700,
                                                                flexShrink: 0,
                                                            }}
                                                        >
                                                            {checked ? '✓' : ''}
                                                        </span>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.name}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                                <span className="v2-config-item-hint">{evaluatorHint}</span>
                            </div>

                            <div className="v2-config-item v2-config-item--compact">
                                <span className="v2-config-item-label">{locale === 'zh' ? '对照组 Skill 版本' : 'Control Skill version'}</span>
                                <Select
                                    aria-label={locale === 'zh' ? '选择对照组 Skill 版本' : 'Select control Skill version'}
                                    value={versionAId || NONE_VERSION_ID}
                                    onChange={v => {
                                        setVersionAId(v);
                                        if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, versionAId: v });
                                    }}
                                    options={controlVersionOptions}
                                    active={Boolean(versionAId && versionAId !== NONE_VERSION_ID)}
                                    size="sm"
                                    className="v2-config-select"
                                />
                                <span className="v2-config-item-hint">{controlVersionHint}</span>
                                <span className="v2-config-item-hint ab-agent-hint">{agentHintA}</span>
                            </div>

                        </div>

                        {/* Separator line */}
                        <div style={{ borderTop: '1px dotted rgba(0, 0, 0, 0.15)', margin: '16px 0' }} />

                        {/* Input Source inside Experiment Config */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#2C2C2A', marginBottom: 12 }}>
                            <FolderIcon />
                            <span>{locale === 'zh' ? '输入来源' : 'Input Source'}</span>
                        </div>

                        <div className="v2-tabs" style={{ marginBottom: 12 }}>
                            <button
                                className={`v2-tab ${sourceMode === 'dataset' ? 'active' : ''}`}
                                onClick={() => {
                                    setSourceMode('dataset');
                                    if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, sourceMode: 'dataset' });
                                }}
                            >
                                {locale === 'zh' ? '从数据集发起' : 'From dataset'}
                            </button>
                            {/* 「从执行链路发起」入口已下线: 该模式后端不支持(走 action='start' 撞 dataset 校验 →
                                静默失败), 暂时移除。trace 相关 state/effect/渲染仍在但已不可达
                                (sourceMode 被锁死为 'dataset', 见 useState 默认值 + 加载时强制归一)。 */}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: 360, overflowY: 'auto', marginBottom: 12, paddingRight: 4 }}>
                            {filteredCases.map((c, idx) => {
                                const isActive = selectedCaseId === c.id;
                                const isChecked = checkedCaseIds.includes(c.id);
                                return (
                                    <div
                                        key={c.id}
                                        className={`v2-dataset-row ${isActive ? 'current' : ''}`}
                                        onClick={() => {
                                            setSelectedCaseId(c.id);
                                            if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, selectedCaseId: c.id });
                                        }}
                                        style={{ 
                                            cursor: 'pointer', 
                                            display: 'flex', 
                                            alignItems: 'center', 
                                            gap: 12, 
                                            padding: '10px 14px',
                                            borderRadius: 8,
                                            border: isActive ? '1px solid #185FA5' : '1px solid #E7E5E4',
                                            background: isActive ? '#F0F7FF' : 'white',
                                            marginBottom: 6,
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        <input 
                                            type="checkbox"
                                            checked={isChecked}
                                            onClick={e => e.stopPropagation()} // Prevent toggling active case on checkbox click
                                            onChange={() => {
                                                setCheckedCaseIds(prev => {
                                                    const next = prev.includes(c.id)
                                                        ? prev.filter(id => id !== c.id)
                                                        : [...prev, c.id];
                                                    if (currentTask) {
                                                        persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, selectedCaseIds: next, checkedCaseIds: next });
                                                    }
                                                    return next;
                                                });
                                            }}
                                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#185FA5' }}
                                        />
                                        {isActive ? (
                                            <span className="idx" style={{ background: '#185FA5', color: 'white', borderColor: '#185FA5', fontWeight: 600, fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                                                {locale === 'zh' ? '当前' : 'Current'}
                                            </span>
                                        ) : (
                                            <span className="idx" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                                                {String(idx + 1).padStart(2, '0')}
                                            </span>
                                        )}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {c.input}
                                            </div>
                                            {c.sourceType === 'trace' && (
                                                <div style={{ marginTop: 4, fontSize: 11, color: '#78716C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {[
                                                        c.sourceDatasetName ? `dataset ${c.sourceDatasetName}` : '',
                                                        c.sourceUploadId ? `upload ${c.sourceUploadId}` : '',
                                                        c.sourceExecutionSessionId ? `exec ${c.sourceExecutionSessionId}` : '',
                                                    ].filter(Boolean).join(' · ')}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {filteredCases.length === 0 && (
                                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#888780' }}>
                                    {locale === 'zh' ? '暂无数据用例' : 'No cases found'}
                                </div>
                            )}
                        </div>

                        {/* Selection summary indicator */}
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: selectedSampleCount > 0 ? '#E1F5EE' : '#FEF2F2',
                            border: selectedSampleCount > 0 ? '1px solid #0F6E56' : '1px solid #FCA5A5',
                            padding: '8px 16px',
                            borderRadius: 8,
                            marginBottom: 12,
                            fontSize: 12,
                            fontWeight: 600,
                            color: selectedSampleCount > 0 ? '#0F6E56' : '#991B1B',
                            transition: 'all 0.2s'
                        }}>
                            <span>
                                {locale === 'zh'
                                    ? `已选样本数：${selectedSampleCount} 个`
                                    : `Selected Samples: ${selectedSampleCount}`}
                            </span>
                            <span>
                                {selectedSampleCount > 0
                                    ? (locale === 'zh' ? '✓ 将按已选样本执行' : '✓ Ready to run selected samples')
                                    : (locale === 'zh' ? '⚠️ 请先选择至少 1 条样本' : '⚠️ Select at least one sample')}
                            </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                            <Button
                                variant="default"
                                size="default"
                                onClick={runComparisonForCheckedCases}
                                disabled={runButtonDisabled}
                            >
                                <Play /> {runButtonLabel}
                            </Button>
                            <button
                                type="button"
                                className="ab-stop-run-btn"
                                onClick={abortCurrentRun}
                                aria-label={locale === 'zh' ? '终止' : 'Abort'}
                                title={locale === 'zh' ? '终止当前 A/B 测试' : 'Abort current A/B test'}
                                disabled={!runButtonBusy}
                            >
                                <span>{locale === 'zh' ? '终止' : 'Abort'}</span>
                            </button>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>
                                <span>{locale === 'zh' ? 'Agent 最大并发数' : 'Max agent concurrency'}</span>
                                <select
                                    value={agentMaxConcurrency}
                                    onChange={e => {
                                        const v = Math.max(1, Number(e.target.value));
                                        setAgentMaxConcurrency(v);
                                        if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, agentMaxConcurrency: v });
                                    }}
                                    style={{ height: 32, minWidth: 72, border: '1px solid var(--border-dark)', borderRadius: 6, padding: '0 8px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'var(--card-bg)', color: 'var(--foreground)' }}
                                >
                                    {[1, 2, 4, 8, 16, 32].map(n => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </label>
                            <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', lineHeight: 1.4 }}>
                                {locale === 'zh'
                                    ? `当前配置：${selectedSampleCount} 样本 * 2 组 * ${repeatRounds} 轮 = ${selectedSampleCount * 2 * repeatRounds} 次执行 | 最大并发：${agentMaxConcurrency}`
                                    : `Current Config: ${selectedSampleCount} samples * 2 groups * ${repeatRounds} rounds = ${selectedSampleCount * 2 * repeatRounds} runs | Max concurrency: ${agentMaxConcurrency}`}
                            </div>
                        </div>

                    </div>
                </div>

                {/* CARD 2: 执行对照 (Comparison Columns Panel - Full Width) */}
                <div
                    className="v2-stage-card s1"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', marginBottom: 0 }}
                    data-collapsible={hifi ? '1' : undefined}
                    data-collapsed={hifi ? (hifiCollapsed.exec ? '1' : '0') : undefined}
                >
                    <div
                        className="v2-stage-card-header"
                        style={{ borderBottom: '1px solid var(--border)' }}
                        onClick={hifi ? () => toggleHifiCard('exec') : undefined}
                    >
                        <div
                            className="v2-stage-num-badge"
                            style={{
                                background: 'var(--primary)',
                                color: 'var(--primary-foreground)',
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}
                        >
                            <PlayIcon />
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title">
                                <span>
                                    {locale === 'zh' ? '执行 A/B 测试' : 'Execute A/B Testing'}
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">
                                {locale === 'zh'
                                    ? `对照组 (${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}) vs 实验组 (${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}) · 每次执行的过程数据`
                                    : `Control (${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}) vs Experiment (${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}) · Exposing raw execution steps`}
                            </div>
                        </div>
                        {hifi && (
                            <button
                                type="button"
                                className="gh-card-chev"
                                aria-label={hifiCollapsed.exec ? (locale === 'zh' ? '展开' : 'Expand') : (locale === 'zh' ? '折叠' : 'Collapse')}
                                onClick={e => { e.stopPropagation(); toggleHifiCard('exec'); }}
                            />
                        )}
                    </div>
                    <div className="v2-stage-card-body" style={{ padding: 18 }}>
                        <div className="v2-compare-grid" style={{ gridTemplateColumns: '1fr 20px 1fr' }}>
                            
                            {/* Baseline Column (A) — design: Sky palette (slot 2, foundations.md §B.6.1). */}
                            <div className="v2-compare-col baseline ab-col-a">
                                <div className="v2-col-header">
                                    <div className="v2-col-tag a">A</div>
                                    <div className="v2-col-name-block">
                                        <div className="v2-col-name">{locale === 'zh' ? `对照组: ${getAbAgentLabel(versionAId || NONE_VERSION_ID)}` : `Control: ${getAbAgentLabel(versionAId || NONE_VERSION_ID)}`}</div>
                                        <div className="v2-col-variant-line">
                                            <span className={`v2-skill-state ${versionAId === NONE_VERSION_ID ? 'off' : 'on'} ab-skill-state`}>
                                                Skill: {versionAId === NONE_VERSION_ID
                                                    ? (locale === 'zh' ? '无 Skill' : 'No Skill')
                                                    : `${selectedSkill?.name || 'cpu-model-query'} ${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}`}
                                            </span>
                                            <span className="ab-agent-state" title={getAbAgentName(versionAId || NONE_VERSION_ID)}>
                                                Agent: {getAbAgentName(versionAId || NONE_VERSION_ID)}
                                            </span>
                                        </div>
                                    </div>
                                    <StatusBadge
                                        status={
                                            isCompletedA ? 'success'
                                            : isFailedA ? 'error'
                                            : isEvaluatingA ? 'running'
                                            : simA.status === 'running' ? 'running'
                                            : 'pending'
                                        }
                                        label={
                                            isCompletedA ? (locale === 'zh' ? '完成' : 'Done')
                                            : isFailedA ? (locale === 'zh' ? '失败' : 'Failed')
                                            : isEvaluatingA ? (locale === 'zh' ? '评估中' : 'Evaluating')
                                            : simA.status === 'running' ? (locale === 'zh' ? '执行中' : 'Running')
                                            : (locale === 'zh' ? '未执行' : 'Pending')
                                        }
                                    />
                                </div>
                                <div className="v2-col-body" style={{ padding: 16 }}>
                                    <div className="v2-exec-result" style={{ paddingBottom: 12 }}>
                                        {isCompletedA ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: 'var(--success)', background: 'var(--success-subtle)', width: 44, height: 44, fontSize: 20 }}>✓</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">平均耗时 {simA.timeCost} · {displayedRepeatRounds}轮重复</div>
                                            </>
                                        ) : isFailedA ? (
                                            <>
                                                <div className="v2-result-icon" style={{ color: 'var(--error)', background: 'var(--error-subtle)', width: 44, height: 44, fontSize: 20 }}>!</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '存在未完整执行的记录' : 'Some runs did not finish'}</div>
                                            </>
                                        ) : simA.status === 'running' ? (
                                            <>
                                                <div className="v2-result-icon ab-icon-running" style={{ width: 44, height: 44, fontSize: 20 }}>⚡</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '执行记录生成中...' : 'Generating execution records...'}</div>
                                            </>
                                        ) : isEvaluatingA ? (
                                            <>
                                                <div className="v2-result-icon ab-icon-eval" style={{ width: 44, height: 44, fontSize: 20 }}>◌</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '评估记录生成中...' : 'Generating evaluation records...'}</div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="v2-result-icon ab-icon-pending" style={{ width: 44, height: 44, fontSize: 20 }}>⏳</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '等待执行评测' : 'Awaiting execution'}</div>
                                            </>
                                        )}
                                    </div>

                                    <div className="v2-process-data">
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? 'Skill 触发' : 'Skill triggers'}</span>
                                            <span className="v2-process-value text-foreground-muted">{simA.triggerRate}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '工具调用' : 'Tool calls'}</span>
                                            <span className="v2-process-value font-mono text-[11px] bg-background-secondary rounded px-1.5 py-0.5">{simA.toolCall}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '答案准确性' : 'Accuracy'}</span>
                                            <span className="v2-process-value text-[var(--error)] font-bold">{simA.accuracy}</span>
                                        </div>
                                    </div>

                                    <div className="v2-metric-row" style={{ borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
                                        <div className="v2-metric-cell">
                                            <div className="label">{locale === 'zh' ? '耗时' : 'Cost'}</div>
                                            <div className="value"><MetricValue value={simA.timeCost} size="md" /></div>
                                        </div>
                                        <div className="v2-metric-cell">
                                            <div className="label">TOKEN</div>
                                            <div className="value"><MetricValue value={simA.tokenUsage} format="compact" size="md" /></div>
                                        </div>
                                        <div className={`v2-metric-cell text-center ${typeof simA.score === 'number' ? 'ab-score-highlight' : ''}`}>
                                            <div className="label">{locale === 'zh' ? '评分' : 'Score'}</div>
                                            <div className="value"><MetricValue value={typeof simA.score === 'number' ? simA.score : null} size="md" tone={typeof simA.score === 'number' ? 'default' : 'muted'} /></div>
                                        </div>
                                    </div>
                                  </div>
                                  <div className="v2-col-actions" style={{ background: 'var(--background-secondary)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                                      <Button variant="ghost" size="sm" onClick={() => setRecordModal({ title: locale === 'zh' ? 'A 对照组执行记录' : 'A Control Records', side: 'a' })}>
                                          <ExternalLink /> {locale === 'zh' ? '执行记录' : 'Records'}
                                      </Button>
                                      <Button variant="default" size="sm" onClick={() => evaluateCaseSide(selectedCaseId, 'a')}>
                                          {locale === 'zh' ? '✓ 评测' : 'Evaluate'}
                                      </Button>
                                      <span className="v2-trace-id">{simA.sessionId}</span>
                                  </div>
                            </div>

                            {/* VS Divider */}
                            <div className="v2-compare-vs">
                                <span>VS</span>
                            </div>

                            {/* Candidate Column (B) — design: Violet palette (slot 6, foundations.md §B.6.1). */}
                            <div className="v2-compare-col candidate ab-col-b">
                                <div className="v2-col-header">
                                    <div className="v2-col-tag b">B</div>
                                    <div className="v2-col-name-block">
                                        <div className="v2-col-name">{locale === 'zh' ? `实验组: ${getAbAgentLabel(versionBId || NONE_VERSION_ID)}` : `Experiment: ${getAbAgentLabel(versionBId || NONE_VERSION_ID)}`}</div>
                                        <div className="v2-col-variant-line">
                                            <span className={`v2-skill-state ${versionBId === NONE_VERSION_ID ? 'off' : 'on'} ab-skill-state`}>
                                                Skill: {versionBId === NONE_VERSION_ID
                                                    ? (locale === 'zh' ? '无 Skill' : 'No Skill')
                                                    : `${selectedSkill?.name || 'cpu-model-query'} ${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}`}
                                            </span>
                                            <span className="ab-agent-state" title={getAbAgentName(versionBId || NONE_VERSION_ID)}>
                                                Agent: {getAbAgentName(versionBId || NONE_VERSION_ID)}
                                            </span>
                                        </div>
                                    </div>
                                    <StatusBadge
                                        status={
                                            isCompletedB ? 'success'
                                            : isFailedB ? 'error'
                                            : isEvaluatingB ? 'running'
                                            : simB.status === 'running' ? 'running'
                                            : 'pending'
                                        }
                                        label={
                                            isCompletedB ? (locale === 'zh' ? '完成' : 'Done')
                                            : isFailedB ? (locale === 'zh' ? '失败' : 'Failed')
                                            : isEvaluatingB ? (locale === 'zh' ? '评估中' : 'Evaluating')
                                            : simB.status === 'running' ? (locale === 'zh' ? '执行中' : 'Running')
                                            : (locale === 'zh' ? '未执行' : 'Pending')
                                        }
                                    />
                                </div>
                                <div className="v2-col-body" style={{ padding: 16 }}>
                                    <div className="v2-exec-result" style={{ paddingBottom: 12 }}>
                                        {isCompletedB ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: 'var(--success)', background: 'var(--success-subtle)', width: 44, height: 44, fontSize: 20 }}>✓</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">平均耗时 {simB.timeCost} · {displayedRepeatRounds}轮重复</div>
                                            </>
                                        ) : isFailedB ? (
                                            <>
                                                <div className="v2-result-icon" style={{ color: 'var(--error)', background: 'var(--error-subtle)', width: 44, height: 44, fontSize: 20 }}>!</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '存在未完整执行的记录' : 'Some runs did not finish'}</div>
                                            </>
                                        ) : simB.status === 'running' ? (
                                            <>
                                                <div className="v2-result-icon ab-icon-running" style={{ width: 44, height: 44, fontSize: 20 }}>⚡</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '执行记录生成中...' : 'Generating execution records...'}</div>
                                            </>
                                        ) : isEvaluatingB ? (
                                            <>
                                                <div className="v2-result-icon ab-icon-eval" style={{ width: 44, height: 44, fontSize: 20 }}>◌</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '评估记录生成中...' : 'Generating evaluation records...'}</div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="v2-result-icon ab-icon-pending" style={{ width: 44, height: 44, fontSize: 20 }}>⏳</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '等待执行评测' : 'Awaiting execution'}</div>
                                            </>
                                        )}
                                    </div>

                                    <div className="v2-process-data">
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? 'Skill 触发' : 'Skill triggers'}</span>
                                            <span className="v2-process-value text-[var(--success)] font-bold">{simB.triggerRate}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '工具调用' : 'Tool calls'}</span>
                                            <span className="v2-process-value font-mono text-[11px] bg-background-secondary rounded px-1.5 py-0.5">{simB.toolCall}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '答案准确性' : 'Accuracy'}</span>
                                            <span className="v2-process-value text-[var(--success)] font-bold">{simB.accuracy}</span>
                                        </div>
                                    </div>

                                    <div className="v2-metric-row" style={{ borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
                                        <div className="v2-metric-cell">
                                            <div className="label">{locale === 'zh' ? '耗时' : 'Cost'}</div>
                                            <div className="value"><MetricValue value={simB.timeCost} size="md" /></div>
                                        </div>
                                        <div className="v2-metric-cell">
                                            <div className="label">TOKEN</div>
                                            <div className="value"><MetricValue value={simB.tokenUsage} format="compact" size="md" /></div>
                                        </div>
                                        <div className={`v2-metric-cell text-center ${typeof simB.score === 'number' ? 'ab-score-highlight' : ''}`}>
                                            <div className="label">{locale === 'zh' ? '评分' : 'Score'}</div>
                                            <div className="value"><MetricValue value={typeof simB.score === 'number' ? simB.score : null} size="md" tone={typeof simB.score === 'number' ? 'success' : 'muted'} /></div>
                                        </div>
                                    </div>
                                </div>
                                <div className="v2-col-actions" style={{ background: 'var(--background-secondary)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                                    <Button variant="ghost" size="sm" onClick={() => setRecordModal({ title: locale === 'zh' ? 'B 实验组执行记录' : 'B Experiment Records', side: 'b' })}>
                                        <ExternalLink /> {locale === 'zh' ? '执行记录' : 'Records'}
                                    </Button>
                                    <Button variant="default" size="sm" onClick={() => evaluateCaseSide(selectedCaseId, 'b')}>
                                        {locale === 'zh' ? '✓ 评测' : 'Evaluate'}
                                    </Button>
                                    <span className="v2-trace-id">{simB.sessionId}</span>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                {/* CARD 3: STEP 2 综合判定 & 决策 */}
                <div
                    className="v2-stage-card s3"
                    style={{ background: 'white', border: '0.5px solid rgba(0,0,0,0.08)', marginBottom: 0, borderLeft: '4px solid #BA7517' }}
                    data-collapsible={hifi ? '1' : undefined}
                    data-collapsed={hifi ? (hifiCollapsed.result ? '1' : '0') : undefined}
                >
                    <div
                        className="v2-stage-card-header"
                        style={{ borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}
                        onClick={hifi ? () => toggleHifiCard('result') : undefined}
                    >
                        <div
                            className="v2-stage-num-badge"
                            style={{
                                background: '#BA7517',
                                color: 'white',
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}
                        >
                            <TrophyIcon />
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                                <span>{locale === 'zh' ? '测评结果' : 'Evaluation Result'}</span>
                                <span className="v2-stage-pill active" style={{ background: decisionReady ? '#E1F5EE' : '#FAEEDA', color: decisionReady ? '#0F6E56' : '#854F0B', fontSize: 11 }}>
                                    {decisionReady ? (locale === 'zh' ? '✓ 可决策' : 'Ready') : (locale === 'zh' ? '⚡ 等待决策' : 'Waiting')}
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">{decisionSubtitle}</div>
                        </div>
                        {hifi && (
                            <button
                                type="button"
                                className="gh-card-chev"
                                aria-label={hifiCollapsed.result ? (locale === 'zh' ? '展开' : 'Expand') : (locale === 'zh' ? '折叠' : 'Collapse')}
                                onClick={e => { e.stopPropagation(); toggleHifiCard('result'); }}
                            />
                        )}
                    </div>

                    <div className="v2-stage-card-body" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {hifi ? (() => {
                            // Hi-fi verdict block. Layout mirrors the prototype:
                            //   ① result-context line (skill + A/B + policy version)
                            //   ② DECISION card (大字判决 + 综合短板分 + headline + 下一步 + 操作)
                            //   ③ 3 维度行（能力/成本/稳定性 · 分数 · 进度条 · 关键证据）
                            //   ④ 原始数据折叠区（4 张公式 mini-card）
                            // All numerics come straight from `abScoring.*` — no
                            // recalculation, no formatting that the lib hasn't already done.
                            const toneClass = (t: AbTone): string =>
                                t === 'green' ? 'good' : t === 'amber' ? 'warn' : t === 'red' ? 'fail' : 'idle';
                            const decClass =
                                abScoring.decision === 'direct-release' ? 'pass'
                                : abScoring.decision === 'reject' ? 'reject'
                                : abScoring.decision === 'monitor-release' ? 'warn'
                                : 'idle';
                            const fmt = (n: number | null | undefined, digits = 1): string =>
                                typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits).replace(/\.0$/, '') : '—';
                            const fmtPct = (n: number | null | undefined, digits = 1): string =>
                                typeof n === 'number' && Number.isFinite(n)
                                    ? (n >= 0 ? '+' : '') + n.toFixed(digits).replace(/\.0$/, '') + '%'
                                    : '—';
                            const signed = (n: number | null | undefined, digits = 1): string =>
                                typeof n === 'number' && Number.isFinite(n)
                                    ? (n > 0 ? '+' : '') + n.toFixed(digits).replace(/\.0$/, '')
                                    : '—';
                            const bVerObj = versions.find(v => v.id === versionBId);
                            const skillVerLabel = bVerObj ? `v${bVerObj.semanticVersion || bVerObj.version}` : '';
                            const aLabel = versionAId === NONE_VERSION_ID
                                ? (locale === 'zh' ? '无 Skill' : 'No Skill')
                                : `v${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}`;
                            const bLabel = versionBId === NONE_VERSION_ID
                                ? (locale === 'zh' ? '无 Skill' : 'No Skill')
                                : (locale === 'zh' ? '开 Skill' : 'With Skill');
                            const cap = abScoring.capability;
                            const cost = abScoring.cost;
                            const sta = abScoring.stability;
                            if (!decisionReady) {
                                return (
                                    <div className="gh-verdict-empty">
                                        <div className="gh-verdict-empty-title">
                                            ⚡ {locale === 'zh' ? '等待评分' : 'Waiting for scoring'}
                                        </div>
                                        <div className="gh-verdict-empty-sub">
                                            {locale === 'zh'
                                                ? `已收集 ${abScoring.sampleSize} 条 · 等待 A/B 两侧执行 + 评测全部完成`
                                                : `Collected ${abScoring.sampleSize} so far · waiting for both sides to finish`}
                                        </div>
                                    </div>
                                );
                            }
                            const dims = [
                                {
                                    key: 'capability' as const,
                                    label: locale === 'zh' ? '能力' : 'Capability',
                                    desc: locale === 'zh' ? 'Skill 让 Agent 多做成了多少事' : "How much the skill lifts the agent",
                                    data: cap,
                                },
                                {
                                    key: 'cost' as const,
                                    label: locale === 'zh' ? '成本' : 'Cost',
                                    desc: locale === 'zh' ? '多花了多少 token / 时间' : 'Extra tokens / time spent',
                                    data: cost,
                                },
                                {
                                    key: 'stability' as const,
                                    label: locale === 'zh' ? '稳定性' : 'Stability',
                                    desc: locale === 'zh' ? '该触发时触发了吗，结果稳吗' : 'Triggers correctly + stable output',
                                    data: sta,
                                },
                            ];
                            return (
                                <div className="gh-verdict-block">
                                    {/* ① context */}
                                    <div className="gh-rc">
                                        <span className="gh-rc-skill">
                                            {selectedSkill?.name || '—'}
                                            {skillVerLabel && <span className="gh-rc-ver">{skillVerLabel}</span>}
                                        </span>
                                        <span className="gh-rc-sep">·</span>
                                        <span className="gh-rc-ab">
                                            <span className="gh-rc-tag a">A</span>{aLabel}
                                            <span className="gh-rc-vs">{locale === 'zh' ? '对比' : 'vs'}</span>
                                            <span className="gh-rc-tag b">B</span>{bLabel}
                                        </span>
                                        <span className="gh-rc-policy">{abScoring.policyVersion}</span>
                                    </div>

                                    {/* ② DECISION card */}
                                    <div className={`gh-decision ${decClass}`}>
                                        <div className="gh-decision-verdict">
                                            <div className="gh-decision-score">
                                                {locale === 'zh' ? '综合' : 'Total'}{' '}
                                                <b>{fmt(abScoring.totalScore, 1)}</b> / 100
                                            </div>
                                        </div>
                                        <div className="gh-decision-body">
                                            <div className="gh-decision-headline">
                                                {abScoring.rejectCategory ? (
                                                    <>
                                                        {locale === 'zh' ? '短板在 ' : 'Bottleneck: '}
                                                        <span className="hl">
                                                            {abScoring.rejectCategory === 'capability' ? (locale === 'zh' ? '能力' : 'Capability')
                                                            : abScoring.rejectCategory === 'cost' ? (locale === 'zh' ? '成本' : 'Cost')
                                                            : (locale === 'zh' ? '稳定性' : 'Stability')}
                                                        </span>
                                                        {abScoring.rejectCategory === 'capability' && (
                                                            <>
                                                                {locale === 'zh' ? '：评测均分由 ' : ' — eval avg '}
                                                                <span className="num">{fmt(cap.avgEvalScoreA, 1)} → {fmt(cap.avgEvalScoreB, 1)}</span>
                                                                {locale === 'zh' ? '（Δ ' : ' (Δ '}
                                                                <span className="num">{signed(cap.deltaScore, 1)}</span>
                                                                {locale === 'zh' ? '）' : ')'}
                                                            </>
                                                        )}
                                                        {abScoring.rejectCategory === 'cost' && (
                                                            <>
                                                                {locale === 'zh' ? '：ΔToken ' : ' — ΔToken '}
                                                                <span className="num">{fmtPct(cost.deltaTokenPct, 1)}</span>
                                                                {locale === 'zh' ? '，耗时 ' : ', duration '}
                                                                <span className="num">{fmtPct(cost.deltaDurationPct, 1)}</span>
                                                            </>
                                                        )}
                                                        {abScoring.rejectCategory === 'stability' && (
                                                            <>
                                                                {locale === 'zh' ? '：触发率 ' : ' — invoke '}
                                                                <span className="num">{fmt(sta.invokeRate, 0)}%</span>
                                                            </>
                                                        )}
                                                    </>
                                                ) : (
                                                    <span>
                                                        {locale === 'zh'
                                                            ? `全维通过 · 综合 ${fmt(abScoring.totalScore, 1)} / 100`
                                                            : `All dims pass · total ${fmt(abScoring.totalScore, 1)} / 100`}
                                                    </span>
                                                )}
                                            </div>
                                            {decisionAdvice && (
                                                <div className="gh-decision-next">
                                                    <b>{locale === 'zh' ? '下一步' : 'Next'}</b> · {decisionAdvice}
                                                </div>
                                            )}
                                        </div>
                                        <div className="gh-decision-actions">
                                            <button
                                                type="button"
                                                className="gh-btn"
                                                onClick={() => setRecordModal({ title: locale === 'zh' ? 'B 实验组执行记录' : 'B Experiment Records', side: 'b' })}
                                            >
                                                {locale === 'zh' ? '查看 Trace' : 'View Trace'}
                                            </button>
                                            <button
                                                type="button"
                                                className="gh-btn is-dark"
                                                onClick={runComparisonForCheckedCases}
                                                disabled={runButtonDisabled}
                                            >
                                                {runButtonBusy ? (locale === 'zh' ? '执行中…' : 'Running…') : `▶ ${locale === 'zh' ? '复测' : 'Re-run'}`}
                                            </button>
                                        </div>
                                    </div>

                                    {/* ③ dims-table */}
                                    <div className="gh-dims">
                                        <div className="gh-dims-row gh-dims-head">
                                            <div>{locale === 'zh' ? '维度' : 'DIM'}</div>
                                            <div>{locale === 'zh' ? '分数' : 'SCORE'}</div>
                                            <div>0 · 50 · 75 · 100</div>
                                            <div>{locale === 'zh' ? '关键证据' : 'EVIDENCE'}</div>
                                        </div>
                                        {dims.map(d => {
                                            const cls = toneClass(d.data.tone);
                                            const scoreNum = typeof d.data.score === 'number' ? d.data.score : null;
                                            return (
                                                <div key={d.key} className="gh-dims-row">
                                                    <div className="gh-dim-name-cell">
                                                        <div className="gh-dim-name-row">
                                                            <span className="gh-dim-name">{d.label}</span>
                                                            <span className={`gh-dim-pill ${cls}`}>
                                                                {locale === 'zh' && d.data.label === '拒绝' ? '高风险' : d.data.label}
                                                            </span>
                                                        </div>
                                                        <span className="gh-dim-desc">{d.desc}</span>
                                                    </div>
                                                    <div className={`gh-dim-score ${cls}`}>
                                                        {scoreNum == null ? '—' : fmt(scoreNum, 1)}
                                                        <span className="gh-dim-outof">/ 100</span>
                                                    </div>
                                                    <div className="gh-dim-bar-cell">
                                                        <div className="gh-dim-bar-track">
                                                            <div
                                                                className={`gh-dim-bar-fill ${cls}`}
                                                                style={{ width: `${Math.max(0, Math.min(100, scoreNum ?? 0))}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                    <div className="gh-dim-evidence">
                                                        {d.key === 'capability' && (
                                                            <>
                                                                <span className="row">A <span className="num">{fmt(cap.avgEvalScoreA, 1)}</span> <span className="arrow">→</span> B <span className="num">{fmt(cap.avgEvalScoreB, 1)}</span></span>
                                                                <span className="row">{locale === 'zh' ? '评分变化' : 'Δscore'} <span className={`delta ${(cap.deltaScore ?? 0) >= 0 ? 'up' : 'down'}`}>{signed(cap.deltaScore, 1)}</span></span>
                                                            </>
                                                        )}
                                                        {d.key === 'cost' && (
                                                            <>
                                                                <span className="row">ΔToken <span className={`delta ${(cost.deltaTokenPct ?? 0) <= 0 ? 'up' : 'down'}`}>{fmtPct(cost.deltaTokenPct, 1)}</span> · {locale === 'zh' ? '耗时' : 'Duration'} <span className={`delta ${(cost.deltaDurationPct ?? 0) <= 0 ? 'up' : 'down'}`}>{fmtPct(cost.deltaDurationPct, 1)}</span></span>
                                                                {typeof cost.baseCost === 'number' && typeof cost.score === 'number' && (
                                                                    <span className="row">{locale === 'zh' ? '能力耦合' : 'Capability coupling'} <span className={`delta ${(cost.score - cost.baseCost) >= 0 ? 'up' : 'down'}`}>{signed(cost.score - cost.baseCost, 0)}</span></span>
                                                                )}
                                                            </>
                                                        )}
                                                        {d.key === 'stability' && (
                                                            <>
                                                                <span className="row">{locale === 'zh' ? '触发率' : 'Invoke'} <span className="num">{fmt(sta.invokeRate, 0)}%</span></span>
                                                                <span className="row">{locale === 'zh' ? '方差' : 'Variance'} {sta.varianceComputable ? <span className="num">{fmt(sta.variance, 2)}</span> : <>— (R={abScoring.repeatRounds})</>}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {/* ④ raw data accordion */}
                                    <div className={`gh-raw${hifiRawOpen ? '' : ' is-collapsed'}`}>
                                        <button
                                            type="button"
                                            className="gh-raw-head"
                                            onClick={() => setHifiRawOpen(v => !v)}
                                        >
                                            <span className="gh-raw-chev" />
                                            <span>{locale === 'zh' ? '原始数据与计算公式' : 'Raw data & formulas'}</span>
                                            <span className="gh-raw-formula">min(capability, cost, stability)</span>
                                        </button>
                                        <div className="gh-raw-body">
                                            <div className="gh-raw-grid">
                                                <div className="gh-raw-card">
                                                    <div className="gh-raw-card-head">
                                                        <span className="gh-raw-card-title">{locale === 'zh' ? '能力' : 'Capability'}</span>
                                                        <span className="gh-raw-card-tag">capability</span>
                                                    </div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '评测均分' : 'Eval avg'}</span><span className="a">{fmt(cap.avgEvalScoreA, 1)}</span><span className="b">{fmt(cap.avgEvalScoreB, 1)}</span></div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '通过率' : 'Pass rate'}</span><span className="a">{fmt(cap.passRateA, 1)}%</span><span className="b">{fmt(cap.passRateB, 1)}%</span></div>
                                                    <div className="delta"><span className="k">{locale === 'zh' ? '评分变化' : 'Δscore'}</span><span className={`v ${(cap.deltaScore ?? 0) >= 0 ? 'up' : 'down'}`}>{signed(cap.deltaScore, 1)}</span></div>
                                                    {cap.breakdown?.formula && <div className="formula">{cap.breakdown.formula}</div>}
                                                </div>
                                                <div className="gh-raw-card">
                                                    <div className="gh-raw-card-head">
                                                        <span className="gh-raw-card-title">{locale === 'zh' ? '成本' : 'Cost'}</span>
                                                        <span className="gh-raw-card-tag">cost</span>
                                                    </div>
                                                    <div className="kv"><span className="k">Token</span><span className="a">{fmt(cost.avgTokensA, 0)}</span><span className="b">{fmt(cost.avgTokensB, 0)}</span></div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '耗时' : 'Duration'}(s)</span><span className="a">{fmt(cost.avgDurationA, 1)}</span><span className="b">{fmt(cost.avgDurationB, 1)}</span></div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '步数' : 'Steps'}</span><span className="a">{fmt(cost.avgStepsA, 1)}</span><span className="b">{fmt(cost.avgStepsB, 1)}</span></div>
                                                    <div className="delta"><span className="k">ΔToken</span><span className={`v ${(cost.deltaTokenPct ?? 0) <= 0 ? 'up' : 'down'}`}>{fmtPct(cost.deltaTokenPct, 1)}</span></div>
                                                    {cost.breakdown?.formula && <div className="formula">{cost.breakdown.formula}</div>}
                                                </div>
                                                <div className="gh-raw-card">
                                                    <div className="gh-raw-card-head">
                                                        <span className="gh-raw-card-title">{locale === 'zh' ? '稳定性' : 'Stability'}</span>
                                                        <span className="gh-raw-card-tag">stability</span>
                                                    </div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '触发率' : 'Invoke rate'}</span><span className="a">—</span><span className="b">{fmt(sta.invokeRate, 0)}%</span></div>
                                                    <div className="kv"><span className="k">{locale === 'zh' ? '方差' : 'Variance'}</span><span className="a">—</span><span className="b">{sta.varianceComputable ? fmt(sta.variance, 3) : `— (R=${abScoring.repeatRounds})`}</span></div>
                                                    {sta.dataQualityIssue && <div className="delta"><span className="k">{locale === 'zh' ? '告警' : 'Warning'}</span><span className="v warn">{sta.dataQualityIssue}</span></div>}
                                                    {sta.breakdown?.formula && <div className="formula">{sta.breakdown.formula}</div>}
                                                </div>
                                                <div className="gh-raw-card">
                                                    <div className="gh-raw-card-head">
                                                        <span className="gh-raw-card-title">{locale === 'zh' ? '综合（短板原则）' : 'Verdict (min)'}</span>
                                                        <span className="gh-raw-card-tag">verdict</span>
                                                    </div>
                                                    <div className="kv"><span className="k">capability</span><span className="b" style={{ color: 'var(--gh-st-fail)' }}>{fmt(cap.score, 1)}</span></div>
                                                    <div className="kv"><span className="k">cost</span><span className="b" style={{ color: 'var(--gh-st-warn)' }}>{fmt(cost.score, 1)}</span></div>
                                                    <div className="kv"><span className="k">stability</span><span className="b" style={{ color: 'var(--gh-st-done)' }}>{fmt(sta.score, 1)}</span></div>
                                                    {abScoring.hardGates.length > 0 && (
                                                        <div className="delta"><span className="k">{locale === 'zh' ? '命中 hard gate' : 'Hard gates'}</span><span className="v down">{abScoring.hardGates.map(g => g.label).join('、')}</span></div>
                                                    )}
                                                    <div className="formula">verdict = min(capability, cost, stability) = {fmt(abScoring.totalScore, 1)} → {abScoring.gradeLabel || abScoring.grade}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })() : (
                            <DecisionVerdictCard
                                decisionReady={decisionReady}
                                abScoring={abScoring}
                                sampleSize={abScoring.sampleSize}
                                repeatRounds={abScoring.repeatRounds}
                                recommendedSampleSize={DEFAULT_AB_SCORING_POLICY.recommendedSampleSize}
                                policy={DEFAULT_AB_SCORING_POLICY}
                                decisionTitle={decisionTitle}
                                decisionAdvice={decisionAdvice}
                                onViewTrace={() => setRecordModal({ title: locale === 'zh' ? 'B 实验组执行记录' : 'B Experiment Records', side: 'b' })}
                                locale={locale}
                                toneColor={toneColor}
                                toneBg={toneBg}
                            />
                        )}
                    </div>
                </div>

            </div>

            {/* History Drawer */}
            {showHistoryDrawer && (
                <>
                    <div className="d-drawer-mask" onClick={() => setShowHistoryDrawer(false)} />
                    <div className="d-history-drawer">
                        <div className="d-history-panel">
                            <div className="d-history-head">
                                <div className="d-history-head-title">
                                    <HistoryIcon />
                                    {locale === 'zh' ? '历史任务' : 'Task History'}
                                    <span style={{ fontWeight: 400, color: 'var(--ink-4)', fontSize: 11, marginLeft: 6 }}>
                                        {visibleTaskHistory.length}{locale === 'zh' ? ' 条' : ' tasks'}
                                    </span>
                                </div>
                                <button className="d-drawer-close" onClick={() => setShowHistoryDrawer(false)}>×</button>
                            </div>
                            <div className="d-history-body">
                                {/* 新建固定在列表顶部(参考用例分析的任务选择器):有再多历史任务,新建依然第一眼可见。
                                    嵌入/独立模式都显示(同 skill 版本可建多个不同名任务)。 */}
                                <button
                                    type="button"
                                    onClick={() => { handleNewTask(); setShowHistoryDrawer(false); }}
                                    style={{
                                        width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                                        border: '1px dashed var(--accent)', background: 'var(--accent-soft)',
                                        color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                                        marginBottom: 10,
                                    }}
                                >
                                    + {locale === 'zh' ? '新建 A/B 任务' : 'New A/B Task'}
                                </button>
                                {visibleTaskHistory.length === 0 ? (
                                    <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-4)', fontSize: 12 }}>
                                        {locale === 'zh' ? '暂无历史任务' : 'No task history'}
                                    </div>
                                ) : visibleTaskHistory.slice().reverse().map(t => (
                                    <div
                                        key={t.id}
                                        className="d-history-item"
                                        style={currentTask?.id === t.id ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                                        onClick={() => { handleSelectHistoryTask(t); setShowHistoryDrawer(false); }}
                                    >
                                        <div className="d-history-item-top">
                                            <div className="d-history-item-title" style={currentTask?.id === t.id ? { color: 'var(--accent)' } : {}}>
                                                {t.taskName}
                                            </div>
                                            <span className="d-history-item-id">
                                                {new Date(t.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        {t.configJson?.taskDescription && (
                                            <div className="d-history-item-query">{t.configJson.taskDescription}</div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* New Dataset Modal */}
            {showNewDatasetModal && (
                <div className="d-modal-mask" onClick={() => setShowNewDatasetModal(false)}>
                    <div className="d-modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
                        <div className="d-modal-head">
                            <div className="d-modal-title">
                                {locale === 'zh' ? '新建数据集' : 'New Dataset'}
                            </div>
                            <button className="d-modal-close" onClick={() => setShowNewDatasetModal(false)}>×</button>
                        </div>
                        <div className="d-modal-body">
                            <div className="gray-field">
                                <div className="gray-field-label">{locale === 'zh' ? '数据集名称' : 'Dataset Name'}</div>
                                <input
                                    className="gray-input"
                                    value={newDatasetName}
                                    onChange={e => setNewDatasetName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCreateDataset(); if (e.key === 'Escape') setShowNewDatasetModal(false); }}
                                    placeholder={locale === 'zh' ? '请输入数据集名称…' : 'Enter dataset name…'}
                                    autoFocus
                                />
                            </div>
                            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                                {locale === 'zh'
                                    ? '创建后将自动关联到当前评测任务，可在数据集管理中添加测试用例。'
                                    : 'The dataset will be linked to the current task. Add test cases in Dataset Management.'}
                            </div>
                        </div>
                        <div className="d-modal-foot">
                            <button className="d-btn sm" onClick={() => setShowNewDatasetModal(false)}>
                                {locale === 'zh' ? '取消' : 'Cancel'}
                            </button>
                            <button
                                className="d-btn sm primary"
                                onClick={handleCreateDataset}
                                disabled={!newDatasetName.trim() || isCreatingDataset}
                            >
                                {isCreatingDataset ? (locale === 'zh' ? '创建中…' : 'Creating…') : (locale === 'zh' ? '创建' : 'Create')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 新增评测任务对话框 (跨视图浮窗, 跟其他 modal 同级渲染) */}
            <NewEvaluationBatchDialog
                open={newBatchDialogOpen}
                user={user || ''}
                defaultTitle={currentTask?.taskName}
                evaluators={selectedEvaluatorIds}
                onClose={() => setNewBatchDialogOpen(false)}
                onCreated={handleEvalBatchCreated}
            />

            {/* Output preview modal */}
            {outputModal && (
                <div className="output-modal-overlay" onClick={() => setOutputModal(null)}>
                    <div className="output-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="output-modal-header">
                            <span className="output-modal-title">{outputModal.title}</span>
                            <button className="output-modal-close" onClick={() => setOutputModal(null)} aria-label="close">×</button>
                        </div>
                        <pre className="output-modal-body">{outputModal.content || (locale === 'zh' ? '(空)' : '(empty)')}</pre>
                    </div>
                </div>
            )}

            {/* Execution record modal */}
            {recordModal && (
                <div className="output-modal-overlay" onClick={() => setRecordModal(null)}>
                    <div className="output-modal" style={{ width: 'min(980px, calc(100vw - 48px))', maxHeight: '82vh' }} onClick={(e) => e.stopPropagation()}>
                        <div className="output-modal-header">
                            <span className="output-modal-title">{recordModal.title}</span>
                            <button className="output-modal-close" onClick={() => setRecordModal(null)} aria-label="close">×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div style={{ color: '#5F5E5A', fontSize: 13 }}>
                                {locale === 'zh'
                                    ? '仅展示当前组所有轮次的执行 session id 与评估 session id。点击任一 session id 可跳转链路详情。'
                                    : 'Execution session ids and evaluation session ids for this group only. Click any session id to open its trace detail.'}
                            </div>
                            {renderExecutionRecordSection(recordModal.side)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
