'use client';

import React, { useState, useEffect, Suspense, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { calculateAbScoring, DEFAULT_AB_SCORING_POLICY, type AbScoringResult } from '@/lib/skill-analysis/ab-scoring';
import '../debug.css';
import '../skill-analysis.css';

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
}

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
    runIndex: number;
    roundIndex?: number;
    caseId?: string;
    traceIds?: string[];
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
}

function scoreTierFromComposite(score: number): ScoreTier {
    return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'poor';
}

function compositeScore(result: { trajectoryScore?: number | null; resultEvaluationScore?: number | null }): number {
    const traj = typeof result.trajectoryScore === 'number' ? result.trajectoryScore : null;
    const r = typeof result.resultEvaluationScore === 'number' ? result.resultEvaluationScore : null;
    const composite = (traj != null && r != null) ? (traj + r) / 2 : (traj ?? r ?? 0);
    return Math.round(composite * 100);
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
    evaluatorId: string;
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
        evaluatorId: config.evaluatorId,
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
const CASE_STATUS_DISPLAY: Record<CaseStatus, { label: string; bg: string; fg: string; icon?: string; pulse?: boolean }> = {
    pending:    { label: '排队中', bg: 'rgba(100,116,139,.10)', fg: '#475569' },
    running:    { label: '执行中', bg: 'rgba(37,99,235,.10)',   fg: '#2563EB', pulse: true },
    executed:   { label: '执行完成 · 待评测', bg: 'rgba(217,119,6,.10)', fg: '#B45309' },
    evaluating: { label: '评测中', bg: 'rgba(37,99,235,.10)',   fg: '#2563EB', pulse: true },
    pass:       { label: '已评测', bg: 'rgba(22,163,74,.10)',   fg: '#15803D', icon: '✓' },
    fail:       { label: '评测失败', bg: 'rgba(220,38,38,.10)', fg: '#B91C1C', icon: '⚠' },
};

function CaseStatusBadge({ status }: { status: CaseStatus | string | undefined }) {
    const cfg = CASE_STATUS_DISPLAY[status as CaseStatus] ?? CASE_STATUS_DISPLAY.pending;
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 99,
            background: cfg.bg,
            color: cfg.fg,
            whiteSpace: 'nowrap',
        }}>
            {cfg.pulse && (
                <span style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'currentColor',
                    animation: 'pulse 1.5s ease-in-out infinite',
                }} />
            )}
            {cfg.icon && <span>{cfg.icon}</span>}
            {cfg.label}
        </span>
    );
}

// ──────────────── caseStates side-state 修改助手 ────────────────
// 历史 bug：runCaseSide / evaluateCaseSide 在每次 setCaseStates 时
// 直接用 `[side]: { status: 'running' }` 这种方式整段替换 side state，
// 导致 runs[] 历史被擦光、执行记录 modal 表面无变化。下面两个 helper 把
// 「保留 runs[] + 顶层字段同步最新 run」的逻辑统一封一遍，所有 setCaseStates
// 改动一律走这里：
//
//   - appendNewRunningRun(side)：用户点「重跑」时调用。在 runs[] 末尾 push
//     一条 {status: 'running'} 占位 run，并把 side 顶层 status 切到 'running'。
//     records modal 就能立刻看到新一行 "running"。
//
//   - patchLatestRun(side, patch)：跑完 / 评测完 / 失败时调用。把 runs[] 最后
//     一条 run merge patch 字段，同时把 side 顶层的镜像字段(status/score/jobId
//     /sessionId/...)也同步过去，避免顶层和 runs 末尾分裂。

function appendNewRunningRun(side: PerVersionState | undefined): PerVersionState {
    const base: PerVersionState = side ?? { status: 'pending' };
    const prevRuns = base.runs ?? [];
    const nextIndex = prevRuns.length + 1;
    const newRun: RunResult = {
        status: 'running',
        runIndex: nextIndex,
        roundIndex: nextIndex,
    };
    return {
        ...base,
        status: 'running',
        // 顶层 score/output/jobId/sessionId 等先清掉，避免上一轮的残留干扰
        // 卡片汇总位置（顶层字段被当作"最新 run 的镜像"）。runs[] 里的旧值
        // 仍然完整保留在 modal 里可见。
        score: undefined,
        output: undefined,
        jobId: undefined,
        sessionId: undefined,
        timeCost: undefined,
        tokenUsage: undefined,
        evaluatorRunId: undefined,
        tier: undefined,
        runs: [...prevRuns, newRun],
    };
}

function patchLatestRun(side: PerVersionState | undefined, patch: Partial<RunResult>): PerVersionState {
    const base: PerVersionState = side ?? { status: 'pending' };
    const runs = base.runs ?? [];
    let updatedRuns: RunResult[];
    if (runs.length > 0) {
        updatedRuns = runs.map((r, i) => (i === runs.length - 1 ? { ...r, ...patch } : r));
    } else {
        // 极少见兜底：runs[] 为空（比如调用方没先走 appendNewRunningRun）。
        // 现造一条 run 把 patch 装进去，避免 patch 字段被静默吞掉。
        updatedRuns = [{
            runIndex: 1,
            roundIndex: 1,
            status: patch.status ?? base.status ?? 'running',
            ...patch,
        } as RunResult];
    }
    return {
        ...base,
        // side 顶层字段镜像最新 run，UI 任何地方读 side 顶层都拿到最新 run 状态
        status: patch.status ?? base.status,
        jobId: patch.jobId ?? base.jobId,
        output: patch.output ?? base.output,
        score: patch.score ?? base.score,
        tier: patch.tier ?? base.tier,
        sessionId: patch.sessionId ?? base.sessionId,
        timeCost: patch.timeCost ?? base.timeCost,
        tokenUsage: patch.tokenUsage ?? base.tokenUsage,
        evaluatorRunId: patch.evaluatorRunId ?? base.evaluatorRunId,
        runs: updatedRuns,
    };
}

// 跟 polling tick 的 setCaseStates(nextStates) 配合：如果本地某 case-side 正处于
// 「比 server 多了一条 in-flight running run」的状态（用户刚点了重跑还没回写到 DB
// 或者写完了但 server 那条记录还没进 caseStatesJson），polling 直接覆盖会把那条
// running run 抹掉。这里做 case-side 级别的 reconcile：只要本地 runs 长度 ≥ 远端
// 且本地末尾是非 finished 状态，就保留本地不动；否则采用远端。
function mergeServerCaseStates(
    local: Record<string, { a: PerVersionState; b: PerVersionState }>,
    remote: Record<string, { a: PerVersionState; b: PerVersionState }>,
): Record<string, { a: PerVersionState; b: PerVersionState }> {
    const FINISHED: CaseStatus[] = ['pass', 'fail', 'executed'];
    const mergeSide = (l?: PerVersionState, r?: PerVersionState): PerVersionState => {
        if (!l) return r ?? { status: 'pending' };
        if (!r) return l;
        const lRuns = l.runs ?? [];
        const rRuns = r.runs ?? [];
        const lLatest = lRuns[lRuns.length - 1];
        // 本地比远端多 run，且最新一条是 in-flight：远端还没看见，保留本地
        if (lRuns.length > rRuns.length && lLatest && !FINISHED.includes(lLatest.status)) {
            return l;
        }
        // 本地顶层是 running/evaluating 而远端不是 → 本地是更新的乐观状态
        if ((l.status === 'running' || l.status === 'evaluating') && !FINISHED.includes(l.status) && l.status !== r.status) {
            return l;
        }
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
            <AppTopBar
                title={locale === 'zh' ? '调测分析' : 'Debug & Analysis'}
                showDefaultActions={false}
            />
            <div className="d-page-tabs" style={{ marginBottom: 0 }}>
                <div className="d-page-tab active" onClick={() => {}}>
                    {locale === 'zh' ? 'AB测评' : 'A/B Eval'}
                </div>
                {/* "用例测评" tab 删——/skill-eval/batch 路由下线（已整合进 /skill-eval 用例分析卡）。
                    要从此页跳过去走 router.push('/skill-eval?view=trace') 或顶部 Skills 分析 → 用例分析 */}
                <button
                    className="d-btn sm d-page-tabs-action"
                    onClick={() => setHistoryPanelTrigger(c => c + 1)}
                >
                    <HistoryIcon />
                    {locale === 'zh' ? '历史任务' : 'History'}
                </button>
            </div>
            <div className="d-layout" style={{ background: '#F5F4EE' }}>
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
    const [selectedCaseId, setSelectedCaseId] = useState('');

    // Numbers
    const [repeatRounds, setRepeatRounds] = useState<number>(1);
    const [agentMaxConcurrency, setAgentMaxConcurrency] = useState<number>(4);
    const [autoEval, setAutoEval] = useState<boolean>(true);
    const [recordTriggerDetails, setRecordTriggerDetails] = useState<boolean>(true);

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
    const [userEvaluators, setUserEvaluators] = useState<Array<{id: string; name: string}>>([]);
    const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('preset-agent-task-completion');
    const [showEvalDropdown, setShowEvalDropdown] = useState(false);

    // Linked datasets
    const [linkedDatasetIds, setLinkedDatasetIds] = useState<string[]>([]);
    const [showNewDatasetModal, setShowNewDatasetModal] = useState(false);
    const [newDatasetName, setNewDatasetName] = useState('');
    const [isCreatingDataset, setIsCreatingDataset] = useState(false);
    const [showLinkDatasetDropdown, setShowLinkDatasetDropdown] = useState(false);

    // History drawer
    const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);

    // Modals
    const [showSkillModal, setShowSkillModal] = useState(false);

    // Multi-case states
    const [caseStates, setCaseStates] = useState<Record<string, { a: PerVersionState; b: PerVersionState }>>({});
    const [checkedCaseIds, setCheckedCaseIds] = useState<string[]>([]);
    const [isTaskRunInFlight, setIsTaskRunInFlight] = useState(false);
    const [lastRunConfigSignature, setLastRunConfigSignature] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [filterTab, setFilterTab] = useState<'all' | 'pending' | 'executed' | 'evaluated'>('all');

    const activePollsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

    const NONE_VERSION_ID = '__NONE__';

    const defaultTaskName = () => {
        const now = new Date();
        return `灰度测评 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`;
    };

    const resetToNewTaskDraft = (skillId: string) => {
        setCurrentTask(null);
        currentTaskRef.current = null;
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

    const applyTaskToState = (task: GrayscaleTask) => {
        setCurrentTask(task);
        setIsEditingTask(false);
        setTaskNameInput('');
        const cfg = task.configJson || {};
        const boundSkillId = cfg.skillId || task.skillId || '';
        if (boundSkillId) setSelectedSkillId(boundSkillId);
        setSourceMode((cfg.sourceMode === 'trace' ? 'trace' : 'dataset'));
        setRepeatRounds(cfg.repeatRounds || 1);
        setAgentMaxConcurrency(cfg.agentMaxConcurrency || 4);
        setAutoEval(cfg.autoEval !== false);
        setRecordTriggerDetails(cfg.recordTriggerDetails !== false);
        setSelectedEvaluatorId(cfg.evaluatorId || 'preset-agent-task-completion');
        setTaskDescInput(cfg.taskDescription || '');
        setSelectedDatasetId(cfg.selectedDatasetId || '');
        setSelectedCaseId(cfg.selectedCaseId || '');
        setLinkedDatasetIds(cfg.linkedDatasetIds || []);
        setCheckedCaseIds(Array.isArray(cfg.checkedCaseIds)
            ? cfg.checkedCaseIds
            : Array.isArray(cfg.selectedCaseIds) ? cfg.selectedCaseIds : []);
        setTraceTimeRange(cfg.traceTimeRange || '7d');
        setSelectedTraceAId(cfg.selectedTraceAId || '');
        setSelectedTraceBId(cfg.selectedTraceBId || '');
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
        setIsTaskRunInFlight(Boolean(task.activeRun) || hasRunningCaseStates(parsedStates) || (cfg.autoEval !== false && hasPendingAutoEvaluationCaseStates(parsedStates)));
        setLastRunConfigSignature(Object.keys(parsedStates).length > 0
            ? buildRunConfigSignature({
                skillId: boundSkillId,
                versionAId: cfg.versionAId || '',
                versionBId: cfg.versionBId || '',
                sourceMode: cfg.sourceMode === 'trace' ? 'trace' : 'dataset',
                selectedDatasetId: cfg.selectedDatasetId || '',
                linkedDatasetIds: cfg.linkedDatasetIds || [],
                selectedTraceAId: cfg.selectedTraceAId || '',
                selectedTraceBId: cfg.selectedTraceBId || '',
                repeatRounds: cfg.repeatRounds || 1,
                agentMaxConcurrency: cfg.agentMaxConcurrency || 4,
                autoEval: cfg.autoEval !== false,
                recordTriggerDetails: cfg.recordTriggerDetails !== false,
                evaluatorId: cfg.evaluatorId || 'preset-agent-task-completion',
                caseIds: Object.keys(parsedStates),
            })
            : ''
        );
    };

    // Load all tasks for history, then pick the task bound to the current Skill + B version.
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/debug/grayscale-tasks?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                    setTaskHistory(data);
                    const task = parentSkillId
                        ? data.find((item: GrayscaleTask) => taskMatchesBinding(item, parentSkillId, undefined, parentSkillVersion)) as GrayscaleTask | undefined
                        : data[0] as GrayscaleTask | undefined;
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
    const isTaskRunInFlightRef = useRef(isTaskRunInFlight);
    useEffect(() => { isTaskRunInFlightRef.current = isTaskRunInFlight; }, [isTaskRunInFlight]);
    const currentConfigRef = useRef({ skillId: selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, selectedCaseIds: checkedCaseIds, checkedCaseIds, taskDescription: taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, evaluatorId: selectedEvaluatorId });
    useEffect(() => {
        currentConfigRef.current = { skillId: selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, selectedCaseIds: checkedCaseIds, checkedCaseIds, taskDescription: taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, evaluatorId: selectedEvaluatorId };
    }, [selectedSkillId, versionAId, versionBId, sourceMode, selectedDatasetId, selectedCaseId, checkedCaseIds, taskDescInput, linkedDatasetIds, traceTimeRange, selectedTraceAId, selectedTraceBId, repeatRounds, agentMaxConcurrency, autoEval, recordTriggerDetails, selectedEvaluatorId]);

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
        evaluatorId: selectedEvaluatorId,
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
        selectedEvaluatorId,
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

    const createTaskForBinding = useCallback(async (skillId: string, boundVersionBId: string, taskName?: string) => {
        if (!user || !skillId || !boundVersionBId || boundVersionBId === NONE_VERSION_ID) return null;
        const name = (taskName || taskNameInput || defaultTaskName()).trim();
        const res = await apiFetch('/api/debug/grayscale-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user, taskName: name, skillId, versionBId: boundVersionBId }),
        });
        if (res.ok) {
            const newTask = await res.json();
            setTaskHistory(prev => prev.some(t => t.id === newTask.id) ? prev : [newTask, ...prev]);
            return newTask as GrayscaleTask;
        }
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            if (data.existingTask) {
                setTaskHistory(prev => prev.some(t => t.id === data.existingTask.id) ? prev : [data.existingTask, ...prev]);
                return data.existingTask as GrayscaleTask;
            }
        }
        return null;
    }, [user, taskNameInput]);

    useEffect(() => {
        if (!parentSkillId || !versionBId || versionBId === NONE_VERSION_ID) return;
        const current = currentTaskRef.current;
        if (current && taskMatchesBinding(current, parentSkillId, versionBId, parentSkillVersion)) return;
        const existing = taskHistory.find(task => taskMatchesBinding(task, parentSkillId, versionBId, parentSkillVersion));
        if (existing) {
            applyTaskToState(existing);
            return;
        }
        let cancelled = false;
        createTaskForBinding(parentSkillId, versionBId)
            .then(task => {
                if (!cancelled && task) applyTaskToState(task);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [parentSkillId, parentSkillVersion, versionBId, taskHistory, createTaskForBinding]);

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

    // Fetch datasets + skills + evaluators
    useEffect(() => {
        if (!user) return;
        Promise.all([
            apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`).then(r => r.json()),
            apiFetch(`/api/skills?user=${encodeURIComponent(user)}`).then(r => r.json()),
            apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`).then(r => r.json()).catch(() => []),
        ]).then(([ds, sk, ev]) => {
            if (Array.isArray(ds)) setDatasets(ds);
            if (Array.isArray(sk)) {
                const skillOptions = sk.map((s: any) => ({ id: s.id, name: s.name }));
                setSkills(skillOptions);
                setSelectedSkillId(prev => prev || skillOptions[0]?.id || '');
            }
            if (Array.isArray(ev)) setUserEvaluators(ev.map((e: any) => ({ id: e.id, name: e.name })));
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

    // Execute single side
    const runCaseSide = async (caseId: string, side: 'a' | 'b') => {
        const targetCase = allCases.find(c => c.id === caseId);
        const query = targetCase?.input || '';
        if (!query.trim()) return;

        const versionId = side === 'a' ? versionAId : versionBId;
        const isNone = versionId === NONE_VERSION_ID;
        const version = isNone ? null : versions.find(v => v.id === versionId);
        const selectedSkill = skills.find(s => s.id === selectedSkillId);

        // 1) 入口：往 runs[] push 一条 running 占位，让执行记录 modal 立刻
        //    看到「新一行 running」，同时把 side 顶层 status 切到 running。
        setCaseStates(prev => {
            const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
            const updated = {
                ...prev,
                [caseId]: {
                    ...current,
                    [side]: appendNewRunningRun(current[side]),
                }
            };
            persistCaseStates(updated);
            return updated;
        });

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
                    mode: 'grayscale',
                    // 把任务归属传给后端: 关掉浏览器/网断时, 后端 .then/.catch 会自己
                    // 把 caseStatesJson 的对应 side 从 running 推到 executed/fail。
                    // 不传或缺任一字段则跳过, 退化为旧的「前端独占写库」行为(兼容其它调用点)。
                    grayscaleTaskId: currentTask?.id,
                    caseId,
                    side,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.jobId) {
                // dispatch 失败：把刚刚 push 的占位 run 标 fail
                setCaseStates(prev => {
                    const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                    const updated = {
                        ...prev,
                        [caseId]: {
                            ...current,
                            [side]: patchLatestRun(current[side], { status: 'fail', output: data.error || 'dispatch failed' }),
                        }
                    };
                    persistCaseStates(updated);
                    return updated;
                });
                return;
            }
            jobId = data.jobId;
        } catch (err) {
            setCaseStates(prev => {
                const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                const updated = {
                    ...prev,
                    [caseId]: {
                        ...current,
                        [side]: patchLatestRun(current[side], { status: 'fail', output: String(err) }),
                    }
                };
                persistCaseStates(updated);
                return updated;
            });
            return;
        }

        // 2) dispatch 成功：把 jobId 装到刚 push 的占位 run 上
        setCaseStates(prev => {
            const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
            const updated = {
                ...prev,
                [caseId]: {
                    ...current,
                    [side]: patchLatestRun(current[side], { status: 'running', jobId }),
                }
            };
            persistCaseStates(updated);
            return updated;
        });

        const poll = async () => {
            try {
                const res = await apiFetch(`/api/debug/execute/${jobId}`);
                const data = await res.json();
                if (data.status === 'completed') {
                    const runPatch: Partial<RunResult> = {
                        status: 'executed',
                        jobId,
                        output: data.output ?? '',
                        timeCost: data.timeCost,
                        tokenUsage: data.tokenUsage ?? 0,
                        sessionId: data.sessionId,
                    };
                    let executedState: PerVersionState | null = null;
                    setCaseStates(prev => {
                        const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                        const nextSide = patchLatestRun(current[side], runPatch);
                        executedState = nextSide;
                        const updated = {
                            ...prev,
                            [caseId]: {
                                ...current,
                                [side]: nextSide,
                            }
                        };
                        persistCaseStates(updated);
                        return updated;
                    });
                    // autoEval 时把执行完整的最新 side state 喂给 evaluator
                    if (autoEval && executedState) {
                        evaluateCaseSide(caseId, side, executedState);
                    }
                    return true;
                } else if (data.status === 'failed' || !data.status || data.error) {
                    setCaseStates(prev => {
                        const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                        const updated = {
                            ...prev,
                            [caseId]: {
                                ...current,
                                [side]: patchLatestRun(current[side], { status: 'fail', jobId, output: data.error || 'agent failed' }),
                            }
                        };
                        persistCaseStates(updated);
                        return updated;
                    });
                    return false;
                }
                return null;
            } catch {
                return null;
            }
        };

        const pollKey = `${caseId}_${side}`;
        if (activePollsRef.current[pollKey]) clearInterval(activePollsRef.current[pollKey]);
        activePollsRef.current[pollKey] = setInterval(async () => {
            const done = await poll();
            if (done !== null) {
                clearInterval(activePollsRef.current[pollKey]);
                delete activePollsRef.current[pollKey];
            }
        }, 3000);
    };

    // Evaluate single side
    const evaluateCaseSide = async (caseId: string, side: 'a' | 'b', execState: PerVersionState) => {
        if (currentTask) {
            try {
                const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user: user || 'debug-user',
                        action: 'evaluate',
                        caseIds: checkedCaseIds.length > 0 ? checkedCaseIds : [caseId],
                        evaluatorId: selectedEvaluatorId,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    alert(data.error || (locale === 'zh' ? '评测提交失败' : 'Evaluation failed to start'));
                    return;
                }
                pollCurrentTask(currentTask.id);
            } catch (err) {
                alert(String(err));
            }
            return;
        }
        const sessionId = execState.sessionId;
        if (!sessionId) return;

        setCaseStates(prev => {
            const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
            const updated = {
                ...prev,
                [caseId]: {
                    ...current,
                    [side]: patchLatestRun(current[side], { status: 'evaluating' }),
                }
            };
            persistCaseStates(updated);
            return updated;
        });

        let evaluatorRunId: string;
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    datasetId: selectedDatasetId || undefined,
                    pairs: [{ caseId: caseId || sessionId, taskId: sessionId }],
                    evaluator: selectedEvaluatorId,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.evaluatorRunId) {
                setCaseStates(prev => {
                    const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                    const updated = {
                        ...prev,
                        [caseId]: {
                            ...current,
                            [side]: patchLatestRun(current[side], { status: 'fail', output: data.error || '评测提交失败' }),
                        }
                    };
                    persistCaseStates(updated);
                    return updated;
                });
                return;
            }
            evaluatorRunId = data.evaluatorRunId;
        } catch (err) {
            setCaseStates(prev => {
                const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                const updated = {
                    ...prev,
                    [caseId]: {
                        ...current,
                        [side]: patchLatestRun(current[side], { status: 'fail', output: String(err) }),
                    }
                };
                persistCaseStates(updated);
                return updated;
            });
            return;
        }

        setCaseStates(prev => {
            const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
            const updated = {
                ...prev,
                [caseId]: {
                    ...current,
                    [side]: patchLatestRun(current[side], { status: 'evaluating', evaluatorRunId }),
                }
            };
            persistCaseStates(updated);
            return updated;
        });

        const pollEval = async () => {
            try {
                const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user || '')}&runId=${encodeURIComponent(evaluatorRunId)}`);
                const data = await res.json();
                const results: any[] = data.results || [];
                const result = results.find((r: any) => r.caseId === caseId);
                if (!result) return null;
                if (result.status === 'done') {
                    const score = compositeScore(result);
                    const tier = scoreTierFromComposite(score);
                    setCaseStates(prev => {
                        const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                        const updated = {
                            ...prev,
                            [caseId]: {
                                ...current,
                                [side]: patchLatestRun(current[side], { status: 'pass', score, tier }),
                            }
                        };
                        persistCaseStates(updated);
                        return updated;
                    });
                    return true;
                } else if (result.status === 'failed') {
                    setCaseStates(prev => {
                        const current = prev[caseId] || { a: { status: 'pending' }, b: { status: 'pending' } };
                        const updated = {
                            ...prev,
                            [caseId]: {
                                ...current,
                                [side]: patchLatestRun(current[side], { status: 'fail', output: result.errorMessage || '评测失败' }),
                            }
                        };
                        persistCaseStates(updated);
                        return updated;
                    });
                    return false;
                }
                return null;
            } catch {
                return null;
            }
        };

        const pollKey = `${caseId}_${side}_eval`;
        if (activePollsRef.current[pollKey]) clearInterval(activePollsRef.current[pollKey]);
        activePollsRef.current[pollKey] = setInterval(async () => {
            const done = await pollEval();
            if (done !== null) {
                clearInterval(activePollsRef.current[pollKey]);
                delete activePollsRef.current[pollKey];
            }
        }, 2000);
    };

    const runCaseBoth = async (caseId: string) => {
        await Promise.all([
            runCaseSide(caseId, 'a'),
            runCaseSide(caseId, 'b')
        ]);
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
                // Polling 不要无脑覆盖本地：用户刚点过「重跑」可能还有 in-flight
                // 占位 run 在本地等 PATCH 落库；mergeServerCaseStates 会按
                // case-side 粒度保留本地更新的 in-flight 状态，避免被擦回老值。
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
        if (!taskNameInput.trim() || !user || !selectedSkillId || !versionBId || versionBId === NONE_VERSION_ID) return;
        setIsCreatingTask(true);
        try {
            if (currentTask) {
                const nextConfig = { ...currentConfigRef.current, taskDescription: taskDescInput.trim() };
                const res = await apiFetch(`/api/debug/grayscale-tasks/${currentTask.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, taskName: taskNameInput.trim(), configJson: nextConfig }),
                });
                if (res.ok) {
                    const updated = await res.json();
                    applyTaskToState(updated);
                    setTaskHistory(prev => prev.map(t => t.id === updated.id ? updated : t));
                }
            } else {
                const newTask = await createTaskForBinding(selectedSkillId, versionBId, taskNameInput.trim());
                if (newTask) {
                    const nextConfig = {
                        ...currentConfigRef.current,
                        ...(newTask.configJson || {}),
                        versionAId,
                        versionBId,
                        taskDescription: taskDescInput.trim(),
                    };
                    const res = await apiFetch(`/api/debug/grayscale-tasks/${newTask.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user, configJson: nextConfig }),
                    });
                    const taskToApply = res.ok ? await res.json() : { ...newTask, configJson: nextConfig };
                    applyTaskToState(taskToApply);
                    setTaskHistory(prev => prev.map(t => t.id === taskToApply.id ? taskToApply : t));
                }
            }
        } catch {}
        finally { setIsCreatingTask(false); }
    };

    const handleNewTask = () => {
        Object.entries(activePollsRef.current).forEach(([key, timer]) => {
            if (key.startsWith('task_')) {
                clearInterval(timer);
                delete activePollsRef.current[key];
            }
        });
        resetToNewTaskDraft(parentSkillId || selectedSkillId);
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
                setShowNewDatasetModal(false);
                setNewDatasetName('');
                if (currentTaskRef.current) {
                    persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, linkedDatasetIds: newLinked });
                }
            }
        } catch {}
        finally { setIsCreatingDataset(false); }
    };

    const handleLinkDataset = (dsId: string) => {
        if (linkedDatasetIds.includes(dsId)) return;
        const newLinked = [...linkedDatasetIds, dsId];
        setLinkedDatasetIds(newLinked);
        setShowLinkDatasetDropdown(false);
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, linkedDatasetIds: newLinked });
        }
    };

    const handleUnlinkDataset = (dsId: string) => {
        const newLinked = linkedDatasetIds.filter(id => id !== dsId);
        setLinkedDatasetIds(newLinked);
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, { ...currentConfigRef.current, linkedDatasetIds: newLinked });
        }
    };

    const getVersionLabel = (v: SkillVersionOption | string | undefined) => {
        if (v === NONE_VERSION_ID) return locale === 'zh' ? '无 Skill' : 'No Skill';
        return v && typeof v !== 'string' ? (v.semanticVersion || `v${v.version}`) : (typeof v === 'string' ? v : '--');
    };

    // Unified case list
    const activeLinkedDatasetIds = linkedDatasetIds.length > 0 ? linkedDatasetIds : (selectedDatasetId ? [selectedDatasetId] : []);
    const allCases = sourceMode === 'dataset'
        ? datasets
            .filter(ds => activeLinkedDatasetIds.includes(ds.id))
            .flatMap(ds => (ds.cases || []).map((c: any) => ({ ...c, datasetName: ds.name, datasetId: ds.id })))
        : traceRecords.map((r, idx) => ({
            id: r.upload_id || r.task_id || `trace_${idx}`,
            input: r.query || r.task_id || '',
            datasetName: 'Traces',
            datasetId: 'traces',
        }));

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
                accuracy: '—',
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
        const completedStates = allRuns.filter(s => s.status === 'executed' || s.status === 'evaluating' || s.status === 'pass' || s.status === 'fail');
        const terminalStates = allRuns.filter(s => s.status === 'pass' || s.status === 'fail');
        const executedCount = completedStates.length;
        const completedCount = terminalStates.length;

        // Determine Overall State
        let overallStatus: 'pending' | 'running' | 'evaluating' | 'completed' = 'pending';
        if (allRuns.length === 0) {
            overallStatus = 'pending';
        } else if (globalExecutionPending || executingCount > 0 || executedCount < totalCount) {
            overallStatus = 'running';
        } else if (completedCount === totalCount && totalCount > 0) {
            overallStatus = 'completed';
        } else if (evaluatingCount > 0 || executedCount === totalCount) {
            overallStatus = 'evaluating';
        }

        if (overallStatus === 'pending') {
            return {
                status: 'pending' as CaseStatus,
                runsCompleted: locale === 'zh' ? `0/${totalCount} 未执行` : `0/${totalCount} Pending`,
                timeCost: '—',
                tokenUsage: undefined as number | undefined,
                score: undefined as number | undefined,
                triggerRate: '—',
                toolCall: '—',
                accuracy: '—',
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
                triggerRate: '—',
                toolCall: '—',
                accuracy: '—',
                sessionId: '',
                output: ''
            };
        }

        if (overallStatus === 'evaluating') {
            return {
                status: 'evaluating' as CaseStatus,
                runsCompleted: locale === 'zh' ? `${completedCount}/${totalCount} 评估中` : `${completedCount}/${totalCount} Evaluating`,
                timeCost: '—',
                tokenUsage: undefined as number | undefined,
                score: undefined as number | undefined,
                triggerRate: '—',
                toolCall: '—',
                accuracy: '—',
                sessionId: '',
                output: ''
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
        const correctCount = terminalStates.filter(s => typeof s.score === 'number' && s.score >= 80).length;
        const accuracy = scoredCount > 0 ? `${correctCount}/${scoredCount} 正确` : '—';

        return {
            status: 'executed' as CaseStatus,
            runsCompleted: locale === 'zh' ? `${completedCount}/${totalCount} 执行完成` : `${completedCount}/${totalCount} Completed`,
            timeCost: avgTime,
            tokenUsage: avgTokens || undefined,
            score: avgScore,
            triggerRate,
            toolCall,
            accuracy,
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
    const runButtonDisabled = checkedCaseIds.length === 0 || runButtonBusy;
    const runButtonLabel = runButtonBusy
        ? (locale === 'zh' ? '执行中' : 'Running')
        : currentConfigHasRunResult
            ? (locale === 'zh' ? '重新执行' : 'Run Again')
            : (locale === 'zh' ? '开始执行' : 'Start Execution');
    const decisionReady = isCompletedA && isCompletedB;
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
        ? (locale === 'zh' ? '全部执行和评估完成后生成上线建议' : 'Launch advice appears after all runs and evaluations finish')
        : abScoring.totalScore == null
            ? (locale === 'zh' ? `样本 ${abScoring.sampleSize}/${DEFAULT_AB_SCORING_POLICY.minSampleSize}，暂不输出总分` : `Sample ${abScoring.sampleSize}/${DEFAULT_AB_SCORING_POLICY.minSampleSize}, no total score yet`)
            : (locale === 'zh' ? `${abScoring.gradeLabel} · ${abScoring.totalScore}/100` : `${abScoring.gradeLabel} · ${abScoring.totalScore}/100`);
    const decisionAdvice = !decisionReady
        ? (locale === 'zh' ? '等待所有执行记录评估完成后，再查看综合判定和上线动作。' : 'Wait for all execution records to finish evaluation before taking a release action.')
        : abScoring.decision === 'insufficient'
            ? (locale === 'zh' ? `当前只有 ${abScoring.sampleSize} 个完成配对样本；N < ${DEFAULT_AB_SCORING_POLICY.minSampleSize} 不输出发布结论，请补齐样本后复测。` : `Only ${abScoring.sampleSize} paired samples are complete; add samples before making a release decision.`)
            : abScoring.decision === 'reject'
                ? (locale === 'zh' ? `命中 hard gate：${abScoring.hardGates.map(g => g.label).join('、')}。建议先按打回类别修正后复测。` : `Hard gate hit: ${abScoring.hardGates.map(g => g.label).join(', ')}. Revise and retest first.`)
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
                status: run.status,
                score: run.score,
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
                        {records.map((record, idx) => (
                            <div
                                key={`${side}-${record.caseId}-${record.roundIndex}-${idx}`}
                                style={{ display: 'grid', gridTemplateColumns: '86px 1fr 1fr 82px', gap: 10, alignItems: 'center', padding: '10px 12px', borderTop: idx === 0 ? 'none' : '1px solid #F1EFE8', fontSize: 12 }}
                            >
                                <div style={{ color: '#5F5E5A', fontWeight: 600 }}>
                                    R{record.roundIndex || '-'} · {record.caseId}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: '#888780', marginBottom: 2 }}>{locale === 'zh' ? '执行 session id' : 'Execution session id'}</div>
                                    {record.executionTraceId ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' }}
                                            onClick={() => window.open(`/trace?taskId=${encodeURIComponent(record.executionTraceId)}`, '_blank')}
                                        >
                                            {record.executionTraceId}
                                        </button>
                                    ) : (
                                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', color: record.evaluatorRunId ? '#888780' : '#B8B6AE' }}>
                                            {record.evaluatorRunId || '—'}
                                        </span>
                                    )}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: '#888780', marginBottom: 2 }}>{locale === 'zh' ? '评估 session id' : 'Evaluation session id'}</div>
                                    {record.evaluationTraceId ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' }}
                                            onClick={() => window.open(`/trace?taskId=${encodeURIComponent(record.evaluationTraceId)}`, '_blank')}
                                            title={record.evaluatorRunId ? `runId: ${record.evaluatorRunId}` : undefined}
                                        >
                                            {record.evaluationTraceId}
                                        </button>
                                    ) : (
                                        <span style={{ color: '#B8B6AE' }}>—</span>
                                    )}
                                </div>
                                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                                    <CaseStatusBadge status={record.status} />
                                    <div style={{ color: accent, fontWeight: 700 }}>{typeof record.score === 'number' ? record.score : '—'}</div>
                                </div>
                            </div>
                        ))}
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

    return (
        <div className="ab-page-v2" style={{ paddingBottom: 60 }}>
            {/* Stepper & Header Block */}
            <div style={{ padding: '24px 28px 12px 28px' }}>
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

                {/* Active Skill Summary White Card */}
                <div style={{
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

                {/* Progress Stepper */}
                <div 
                    className="v2-stepper" 
                    style={{ 
                        position: 'sticky', 
                        top: 16, 
                        zIndex: 40, 
                        background: 'rgba(255, 255, 255, 0.95)', 
                        backdropFilter: 'blur(8px)',
                        border: '1px solid rgba(0,0,0,0.08)', 
                        borderRadius: 12,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.06)'
                    }}
                >
                    <div className={`v2-step ${getStepStatus(1)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(1) === 'done' ? <CheckIcon /> : '1'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 1 · CONFIG</span>
                            <span className="v2-step-name">{locale === 'zh' ? '准备: 配置实验参数' : 'Config params'}</span>
                            <span className="v2-step-meta" style={{ color: '#1D9E75' }}>{stepConfigMeta}</span>
                        </div>
                    </div>
                    <div className={`v2-step ${getStepStatus(2)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(2) === 'done' ? <CheckIcon /> : '2'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 2 · EXECUTION</span>
                            <span className="v2-step-name">{locale === 'zh' ? '执行: 运行 A/B 测试' : 'Run A/B Testing'}</span>
                            <span className="v2-step-meta" style={{ color: '#1D9E75' }}>{stepExecutionMeta}</span>
                        </div>
                    </div>
                    <div className={`v2-step ${getStepStatus(3)}`}>
                        <div className="v2-step-circle">
                            {getStepStatus(3) === 'done' ? <CheckIcon /> : '3'}
                        </div>
                        <div className="v2-step-info">
                            <span className="v2-step-label">STEP 3 · DECISION</span>
                            <span className="v2-step-name">{locale === 'zh' ? '决策: 综合判定 & 上线' : 'Decision verdict'}</span>
                            <span className="v2-step-meta" style={{ color: '#185FA5', fontWeight: 600 }}>{stepDecisionMeta}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* CARD 1: 实验配置 */}
                <div className="v2-stage-card config" style={{ background: 'white', border: '0.5px solid rgba(0,0,0,0.08)' }}>
                    <div className="v2-stage-card-header" style={{ borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
                        <div className="v2-stage-num-badge">
                            <GearIcon />
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title">
                                {locale === 'zh' ? '实验配置' : 'Experiment Config'}
                                <span className="v2-stage-pill done" style={{ background: '#E1F5EE', color: '#0F6E56', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                                    ✓ 配置完成
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">{locale === 'zh' ? '设置参数 · 唯一变量是 Skill 开/关' : 'Set up parameters · The only variable is Skill On/Off'}</div>
                        </div>
                    </div>
                    <div className="v2-stage-card-body">
                        <div className="v2-config-grid">
                            <div className="v2-config-item">
                                <span className="v2-callout-new">NEW</span>
                                <div className="v2-config-item-label">
                                    {locale === 'zh' ? '重复轮次' : 'Repeat rounds'} <span className="req">*</span>
                                </div>
                                <div className="v2-config-item-control">
                                    <select
                                        value={repeatRounds}
                                        onChange={e => {
                                            const v = Number(e.target.value);
                                            setRepeatRounds(v);
                                            if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, repeatRounds: v });
                                        }}
                                        style={{ fontSize: 14, fontWeight: 600, height: 28, cursor: 'pointer' }}
                                    >
                                        {[1, 2, 3, 5, 10].map(n => (
                                            <option key={n} value={n}>{n} 轮</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="v2-config-item-hint">{locale === 'zh' ? '多轮运行以计算方差' : 'Multiple rounds to calculate variance'}</div>
                            </div>

                            <div className="v2-config-item">
                                <div className="v2-config-item-label">{locale === 'zh' ? '数据集' : 'Dataset'}</div>
                                <div className="v2-config-item-control">
                                    <select
                                        value={selectedDatasetId}
                                        onChange={e => {
                                            const val = e.target.value;
                                            setSelectedDatasetId(val);
                                            setLinkedDatasetIds(val ? [val] : []);
                                            setCheckedCaseIds([]);

                                            if (currentTask) {
                                                persistTaskUpdate(currentTask.id, {
                                                    ...currentConfigRef.current,
                                                    selectedDatasetId: val,
                                                    linkedDatasetIds: val ? [val] : [],
                                                    selectedCaseIds: [],
                                                    selectedCaseId: ''
                                                });
                                            }
                                        }}
                                        style={{ fontSize: 13, fontWeight: 600, height: 28, cursor: 'pointer' }}
                                    >
                                        <option value="">{locale === 'zh' ? '-- 未选择 --' : '-- None --'}</option>
                                        {datasets.map(ds => (
                                            <option key={ds.id} value={ds.id}>{ds.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="v2-config-item-hint">
                                    {selectedDatasetId ? `${locale === 'zh' ? '共' : 'Total'} ${datasets.find(d => d.id === selectedDatasetId)?.cases?.length || 0} ${locale === 'zh' ? '条样本' : 'cases'}` : '共 0 条样本'}
                                </div>
                            </div>

                            <div className="v2-config-item">
                                <div className="v2-config-item-label">{locale === 'zh' ? '评估器' : 'Evaluator'}</div>
                                <div className="v2-config-item-control">
                                    <select
                                        value={selectedEvaluatorId}
                                        onChange={e => {
                                            const v = e.target.value;
                                            setSelectedEvaluatorId(v);
                                            if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, evaluatorId: v });
                                        }}
                                        style={{ fontSize: 13, fontWeight: 600, height: 28, cursor: 'pointer' }}
                                    >
                                        <optgroup label={locale === 'zh' ? '预置评估器' : 'Built-in Evaluators'}>
                                            {BUILT_IN_EVALUATORS.map(ev => (
                                                <option key={ev.id} value={ev.id}>{ev.name}</option>
                                            ))}
                                        </optgroup>
                                        {userEvaluators.length > 0 && (
                                            <optgroup label={locale === 'zh' ? '自定义评估器' : 'Custom Evaluators'}>
                                                {userEvaluators.map(ev => (
                                                    <option key={ev.id} value={ev.id}>{ev.name}</option>
                                                ))}
                                            </optgroup>
                                        )}
                                    </select>
                                </div>
                                <div className="v2-config-item-hint">{locale === 'zh' ? '预置或自定义评估器' : 'Preset or custom evaluator'}</div>
                            </div>

                            <div className="v2-config-item">
                                <div className="v2-config-item-label">{locale === 'zh' ? '附加选项' : 'Additional Options'}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                                    <label className="v2-config-checkbox-row">
                                        <input
                                            type="checkbox"
                                            checked={autoEval}
                                            onChange={e => {
                                                const v = e.target.checked;
                                                setAutoEval(v);
                                                if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, autoEval: v });
                                            }}
                                        />
                                        <span>{locale === 'zh' ? '自动评测' : 'Auto-evaluate'}</span>
                                    </label>
                                    <label className="v2-config-checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <input
                                            type="checkbox"
                                            checked={recordTriggerDetails}
                                            onChange={e => {
                                                const v = e.target.checked;
                                                setRecordTriggerDetails(v);
                                                if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, recordTriggerDetails: v });
                                            }}
                                        />
                                        <span>{locale === 'zh' ? '记录 Skill 触发详情' : 'Record Skill triggers'}</span>
                                    </label>
                                </div>
                                <div className="v2-config-item-hint" style={{ marginTop: 4, color: '#0F6E56', fontWeight: 500 }}>
                                    {locale === 'zh' ? '* 自动评估后返回准确评分与 Skill 是否调用' : '* Auto-evaluate on finish with scores & triggers'}
                                </div>
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
                            <button
                                className={`v2-tab ${sourceMode === 'trace' ? 'active' : ''}`}
                                onClick={() => {
                                    setSourceMode('trace');
                                    if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, sourceMode: 'trace' });
                                }}
                            >
                                {locale === 'zh' ? '从执行链路发起' : 'From trace'}
                            </button>
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

                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, paddingTop: 14, borderTop: '0.5px solid rgba(0,0,0,0.08)' }}>
                            <button
                                className="v2-btn-run-big"
                                style={{
                                    padding: '10px 24px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    background: runButtonBusy ? '#A8A29E' : '#1C1917',
                                    borderRadius: 8,
                                    height: 38,
                                    fontSize: 13,
                                    color: 'white',
                                    border: 'none',
                                    cursor: runButtonDisabled ? 'not-allowed' : 'pointer',
                                    opacity: runButtonDisabled && !runButtonBusy ? 0.6 : 1,
                                }}
                                onClick={runComparisonForCheckedCases}
                                disabled={runButtonDisabled}
                            >
                                <PlayIcon /> {runButtonLabel}
                            </button>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#2C2C2A' }}>
                                <span>{locale === 'zh' ? 'Agent 最大并发数' : 'Max agent concurrency'}</span>
                                <select
                                    value={agentMaxConcurrency}
                                    onChange={e => {
                                        const v = Math.max(1, Number(e.target.value));
                                        setAgentMaxConcurrency(v);
                                        if (currentTask) persistTaskUpdate(currentTask.id, { ...currentConfigRef.current, agentMaxConcurrency: v });
                                    }}
                                    style={{ height: 32, minWidth: 72, border: '1px solid #D6D3D1', borderRadius: 6, padding: '0 8px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'white' }}
                                >
                                    {[1, 2, 4, 8, 16, 32].map(n => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </label>
                            <div style={{ fontSize: 12, color: '#5F5E5A', lineHeight: 1.4 }}>
                                {locale === 'zh'
                                    ? `当前配置：${selectedSampleCount} 样本 * 2 组 * ${repeatRounds} 轮 = ${selectedSampleCount * 2 * repeatRounds} 次执行 | 最大并发：${agentMaxConcurrency}`
                                    : `Current Config: ${selectedSampleCount} samples * 2 groups * ${repeatRounds} rounds = ${selectedSampleCount * 2 * repeatRounds} runs | Max concurrency: ${agentMaxConcurrency}`}
                            </div>
                        </div>

                    </div>
                </div>

                {/* CARD 2: 执行对照 (Comparison Columns Panel - Full Width) */}
                <div className="v2-stage-card s1" style={{ background: 'white', border: '0.5px solid rgba(0,0,0,0.08)', marginBottom: 0 }}>
                    <div className="v2-stage-card-header" style={{ borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
                        <div className="v2-stage-num-badge" style={{ 
                            background: '#185FA5', 
                            color: 'white', 
                            flexDirection: 'column', 
                            lineHeight: 1.1,
                            padding: '4px 0',
                            justifyContent: 'center',
                            alignItems: 'center'
                        }}>
                            <span style={{ fontSize: 9, fontWeight: 800, opacity: 0.9, letterSpacing: '0.5px' }}>STEP</span>
                            <span style={{ fontSize: 18, fontWeight: 800 }}>1</span>
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title">
                                <span>
                                    {locale === 'zh' ? '执行 A/B 测试' : 'Execute A/B Testing'}
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">
                                {locale === 'zh'
                                    ? `对照组 (${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}) vs 实验组 (${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}) · 暴露每次执行的过程数据`
                                    : `Control (${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}) vs Experiment (${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}) · Exposing raw execution steps`}
                            </div>
                        </div>
                    </div>
                    <div className="v2-stage-card-body" style={{ padding: 18 }}>
                        <div className="v2-compare-grid" style={{ gridTemplateColumns: '1fr 20px 1fr' }}>
                            
                            {/* Baseline Column (A) */}
                            <div className="v2-compare-col baseline" style={{ borderTopColor: '#BA7517' }}>
                                <div className="v2-col-header" style={{ background: '#FAFAF7', borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
                                    <div className="v2-col-tag a" style={{ background: '#BA7517' }}>A</div>
                                    <div className="v2-col-name-block">
                                        <div className="v2-col-name">{locale === 'zh' ? '对照组: 基础 Agent' : 'Control Group'}</div>
                                        <div className="v2-col-variant-line">
                                            <span className={`v2-skill-state ${versionAId === NONE_VERSION_ID ? 'off' : 'on'}`} style={versionAId === NONE_VERSION_ID ? {} : { background: '#FEF3C7', color: '#BA7517' }}>
                                                Skill: {versionAId === NONE_VERSION_ID 
                                                    ? (locale === 'zh' ? '无 Skill' : 'No Skill') 
                                                    : `${selectedSkill?.name || 'cpu-model-query'} ${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}`}
                                            </span>
                                        </div>
                                    </div>
                                    <div className={`v2-col-status ${simA.status}`} style={{ 
                                        background: isCompletedA ? '#FDF6E2' : isEvaluatingA ? '#F5E8FF' : simA.status === 'running' ? '#E0F2FE' : '#F3F4F6',
                                        color: isCompletedA ? '#BA7517' : isEvaluatingA ? '#7E22CE' : simA.status === 'running' ? '#0369A1' : '#6B7280'
                                    }}>
                                        {isCompletedA 
                                            ? (locale === 'zh' ? '✓ 完成' : '✓ Done')
                                            : isEvaluatingA
                                                ? (locale === 'zh' ? '◌ 评估中' : 'Evaluating')
                                            : simA.status === 'running'
                                                ? (locale === 'zh' ? '⚡ 执行中' : 'Running')
                                                : (locale === 'zh' ? '⏳ 未执行' : 'Pending')}
                                    </div>
                                </div>
                                <div className="v2-col-body" style={{ padding: 16 }}>
                                    <div className="v2-exec-result" style={{ paddingBottom: 12 }}>
                                        {isCompletedA ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#BA7517', background: '#FDF6E2', width: 44, height: 44, fontSize: 20 }}>✓</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">平均耗时 {simA.timeCost} · {displayedRepeatRounds}轮重复</div>
                                            </>
                                        ) : simA.status === 'running' ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#0369A1', background: '#E0F2FE', width: 44, height: 44, fontSize: 20 }}>⚡</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '执行记录生成中...' : 'Generating execution records...'}</div>
                                            </>
                                        ) : isEvaluatingA ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#7E22CE', background: '#F5E8FF', width: 44, height: 44, fontSize: 20 }}>◌</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '评估记录生成中...' : 'Generating evaluation records...'}</div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#9CA3AF', background: '#F3F4F6', width: 44, height: 44, fontSize: 20 }}>⏳</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simA.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '等待执行评测' : 'Awaiting execution'}</div>
                                            </>
                                        )}
                                    </div>

                                    <div className="v2-process-data">
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? 'Skill 触发' : 'Skill triggers'}</span>
                                            <span className="v2-process-value" style={{ color: '#888780' }}>{simA.triggerRate}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '工具调用' : 'Tool calls'}</span>
                                            <span className="v2-process-value" style={{
                                                background: '#F1EFE8',
                                                padding: '2px 6px',
                                                borderRadius: 4,
                                                fontFamily: 'ui-monospace, monospace',
                                                fontSize: 11
                                            }}>{simA.toolCall}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '答案准确性' : 'Accuracy'}</span>
                                            <span className="v2-process-value" style={{ color: '#dc2626', fontWeight: 700 }}>{simA.accuracy}</span>
                                        </div>
                                    </div>

                                    <div className="v2-metric-row" style={{ borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
                                        <div className="v2-metric-cell">
                                            <div className="label">{locale === 'zh' ? '耗时' : 'Cost'}</div>
                                            <div className="value">{simA.timeCost}</div>
                                        </div>
                                        <div className="v2-metric-cell">
                                            <div className="label">TOKEN</div>
                                            <div className="value">{simA.tokenUsage}</div>
                                        </div>
                                        <div className="v2-metric-cell text-center" style={{ background: typeof simA.score === 'number' ? '#FDF6E2' : '#FAFAF7' }}>
                                            <div className="label" style={{ color: typeof simA.score === 'number' ? '#BA7517' : '#888780' }}>{locale === 'zh' ? '评分' : 'Score'}</div>
                                            <div className="value" style={{ color: '#BA7517' }}>{typeof simA.score === 'number' ? simA.score : '—'}</div>
                                        </div>
                                    </div>
                                  </div>
                                  <div className="v2-col-actions" style={{ background: '#FAFAF7', borderTop: '0.5px solid rgba(0,0,0,0.08)' }}>
                                      <button className="v2-action-btn" onClick={() => setRecordModal({ title: locale === 'zh' ? 'A 对照组执行记录' : 'A Control Records', side: 'a' })}>{locale === 'zh' ? '↗ 执行记录' : 'Records'}</button>
                                      <button className="v2-action-btn" onClick={() => runCaseSide(selectedCaseId, 'a')}>{locale === 'zh' ? '▶ 重跑' : 'Re-run'}</button>
                                      <button className="v2-action-btn primary" style={{ background: '#2C2C2A', color: 'white' }} onClick={() => evaluateCaseSide(selectedCaseId, 'a', simA)}>{locale === 'zh' ? '✓ 评测' : 'Evaluate'}</button>
                                      <span className="v2-trace-id">{simA.sessionId}</span>
                                  </div>
                            </div>

                            {/* VS Divider */}
                            <div className="v2-compare-vs">
                                <span>VS</span>
                            </div>

                            {/* Candidate Column (B) */}
                            <div className="v2-compare-col candidate" style={{ borderTopColor: '#1D9E75' }}>
                                <div className="v2-col-header" style={{ background: '#E6F1FB', borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
                                    <div className="v2-col-tag b" style={{ background: '#1D9E75' }}>B</div>
                                    <div className="v2-col-name-block">
                                        <div className="v2-col-name" style={{ color: '#0C447C' }}>{locale === 'zh' ? '实验组: 基础 Agent' : 'Experiment Group'}</div>
                                        <div className="v2-col-variant-line">
                                            <span className={`v2-skill-state ${versionBId === NONE_VERSION_ID ? 'off' : 'on'}`} style={versionBId === NONE_VERSION_ID ? {} : { background: '#D1FAE5', color: '#065F46' }}>
                                                Skill: {versionBId === NONE_VERSION_ID 
                                                    ? (locale === 'zh' ? '无 Skill' : 'No Skill') 
                                                    : `${selectedSkill?.name || 'cpu-model-query'} ${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}`}
                                            </span>
                                        </div>
                                    </div>
                                    <div className={`v2-col-status ${simB.status}`} style={{ 
                                        background: isCompletedB ? '#D1FAE5' : isEvaluatingB ? '#F5E8FF' : simB.status === 'running' ? '#E0F2FE' : '#F3F4F6',
                                        color: isCompletedB ? '#065F46' : isEvaluatingB ? '#7E22CE' : simB.status === 'running' ? '#0369A1' : '#6B7280'
                                    }}>
                                        {isCompletedB 
                                            ? (locale === 'zh' ? '✓ 完成' : '✓ Done')
                                            : isEvaluatingB
                                                ? (locale === 'zh' ? '◌ 评估中' : 'Evaluating')
                                            : simB.status === 'running'
                                                ? (locale === 'zh' ? '⚡ 执行中' : 'Running')
                                                : (locale === 'zh' ? '⏳ 未执行' : 'Pending')}
                                    </div>
                                </div>
                                <div className="v2-col-body" style={{ padding: 16 }}>
                                    <div className="v2-exec-result" style={{ paddingBottom: 12 }}>
                                        {isCompletedB ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#1D9E75', background: '#E1F5EE', width: 44, height: 44, fontSize: 20 }}>✓</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">平均耗时 {simB.timeCost} · {displayedRepeatRounds}轮重复</div>
                                            </>
                                        ) : simB.status === 'running' ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#0369A1', background: '#E0F2FE', width: 44, height: 44, fontSize: 20 }}>⚡</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '执行记录生成中...' : 'Generating execution records...'}</div>
                                            </>
                                        ) : isEvaluatingB ? (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#7E22CE', background: '#F5E8FF', width: 44, height: 44, fontSize: 20 }}>◌</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '评估记录生成中...' : 'Generating evaluation records...'}</div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="v2-result-icon success" style={{ color: '#9CA3AF', background: '#F3F4F6', width: 44, height: 44, fontSize: 20 }}>⏳</div>
                                                <div className="v2-result-text" style={{ fontSize: 14 }}>{simB.runsCompleted}</div>
                                                <div className="v2-result-sub">{locale === 'zh' ? '等待执行评测' : 'Awaiting execution'}</div>
                                            </>
                                        )}
                                    </div>

                                    <div className="v2-process-data">
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? 'Skill 触发' : 'Skill triggers'}</span>
                                            <span className="v2-process-value" style={{ color: '#1D9E75', fontWeight: 700 }}>{simB.triggerRate}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '工具调用' : 'Tool calls'}</span>
                                            <span className="v2-process-value" style={{
                                                background: '#F1EFE8',
                                                padding: '2px 6px',
                                                borderRadius: 4,
                                                fontFamily: 'ui-monospace, monospace',
                                                fontSize: 11
                                            }}>{simB.toolCall}</span>
                                        </div>
                                        <div className="v2-process-row">
                                            <span className="v2-process-label">{locale === 'zh' ? '答案准确性' : 'Accuracy'}</span>
                                            <span className="v2-process-value" style={{ color: '#1D9E75', fontWeight: 700 }}>{simB.accuracy}</span>
                                        </div>
                                    </div>

                                    <div className="v2-metric-row" style={{ borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
                                        <div className="v2-metric-cell">
                                            <div className="label">{locale === 'zh' ? '耗时' : 'Cost'}</div>
                                            <div className="value">{simB.timeCost}</div>
                                        </div>
                                        <div className="v2-metric-cell">
                                            <div className="label">TOKEN</div>
                                            <div className="value">{simB.tokenUsage}</div>
                                        </div>
                                        <div className="v2-metric-cell text-center" style={{ background: typeof simB.score === 'number' ? '#E1F5EE' : '#FAFAF7' }}>
                                            <div className="label" style={{ color: typeof simB.score === 'number' ? '#0F6E56' : '#888780' }}>{locale === 'zh' ? '评分' : 'Score'}</div>
                                            <div className="value" style={{ color: '#1D9E75' }}>{typeof simB.score === 'number' ? simB.score : '—'}</div>
                                        </div>
                                    </div>
                                </div>
                                <div className="v2-col-actions" style={{ background: '#FAFAF7', borderTop: '0.5px solid rgba(0,0,0,0.08)' }}>
                                    <button className="v2-action-btn" onClick={() => setRecordModal({ title: locale === 'zh' ? 'B 实验组执行记录' : 'B Experiment Records', side: 'b' })}>{locale === 'zh' ? '↗ 执行记录' : 'Records'}</button>
                                    <button className="v2-action-btn" onClick={() => runCaseSide(selectedCaseId, 'b')}>{locale === 'zh' ? '▶ 重跑' : 'Re-run'}</button>
                                    <button className="v2-action-btn primary" style={{ background: '#2C2C2A', color: 'white' }} onClick={() => evaluateCaseSide(selectedCaseId, 'b', simB)}>{locale === 'zh' ? '✓ 评测' : 'Evaluate'}</button>
                                    <span className="v2-trace-id">{simB.sessionId}</span>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                {/* CARD 3: STEP 2 综合判定 & 决策 */}
                <div className="v2-stage-card s3" style={{ background: 'white', border: '0.5px solid rgba(0,0,0,0.08)', marginBottom: 0, borderLeft: '4px solid #BA7517' }}>
                    <div className="v2-stage-card-header" style={{ borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
                        <div className="v2-stage-num-badge" style={{ background: '#BA7517', color: 'white', flexDirection: 'column', lineHeight: 1.1, padding: '4px 0', justifyContent: 'center', alignItems: 'center' }}>
                            <span style={{ fontSize: 9, fontWeight: 800, opacity: 0.9, letterSpacing: '0.5px' }}>STEP</span>
                            <span style={{ fontSize: 18, fontWeight: 800 }}>2</span>
                        </div>
                        <div className="v2-stage-title-block">
                            <div className="v2-stage-card-title" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                                <span>{locale === 'zh' ? '综合判定 & 决策' : 'Verdict & Decision'}</span>
                                <span className="v2-stage-pill active" style={{ background: decisionReady ? '#E1F5EE' : '#FAEEDA', color: decisionReady ? '#0F6E56' : '#854F0B', fontSize: 11 }}>
                                    {decisionReady ? (locale === 'zh' ? '✓ 可决策' : 'Ready') : (locale === 'zh' ? '⚡ 等待决策' : 'Waiting')}
                                </span>
                            </div>
                            <div className="v2-stage-card-subtitle">
                                {locale === 'zh' ? '基于「能力 · 成本 · 稳定性」三维框架，给出明确的上线建议' : 'A release recommendation based on capability, cost, and stability'}
                            </div>
                        </div>
                    </div>

                    <div style={{ background: '#FEF3C7', borderBottom: '0.5px solid #FDE68A', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px' }}>
                        <div style={{ color: '#854F0B', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                            💡 Skills 价值评估:A · {versionAId === NONE_VERSION_ID ? (locale === 'zh' ? '无 Skill(对照)' : 'No Skill control') : `${selectedSkill?.name || 'skill'} ${getVersionLabel(versions.find(v => v.id === versionAId) || versionAId)}(对照)`} vs B · {versionBId === NONE_VERSION_ID ? (locale === 'zh' ? '无 Skill(实验)' : 'No Skill experiment') : `${selectedSkill?.name || 'skill'} ${getVersionLabel(versions.find(v => v.id === versionBId) || versionBId)}(实验)`}
                        </div>
                        <div style={{ color: '#854F0B', border: '1px solid #BA7517', fontSize: 11, padding: '6px 12px', borderRadius: 4, background: 'white', fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>
                            SAMPLE N={abScoring.sampleSize} · 重复 {abScoring.repeatRounds} 轮 · 置信度: {abScoring.confidence === 'high' ? '高' : abScoring.confidence === 'medium' ? '中' : '低'}
                        </div>
                    </div>

                    <div className="v2-stage-card-body" style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
                        <div style={{ border: '2px solid #BA7517', background: 'linear-gradient(135deg, #FFF7D6 0%, #FFFFFF 58%)', borderRadius: 12, padding: 24 }}>
                            <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 18 }}>
                                <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#BA7517', boxShadow: '0 0 0 8px rgba(186,117,23,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 24 }}>●</div>
                                <div>
                                    <div style={{ fontSize: 11, color: '#888780', fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: 1 }}>综合结论 · DECISION</div>
                                    <div style={{ fontSize: 24, fontWeight: 800, color: '#111827', marginTop: 4 }}>
                                        {decisionTitle}
                                        <span style={{ fontSize: 14, color: '#5F5E5A', fontWeight: 600, marginLeft: 12 }}>{decisionSubtitle}</span>
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                                {[
                                    { icon: '📊', name: '能力 · CAPABILITY', value: decisionReady ? `${fmtPct(abScoring.capability.deltaPp, 'pp')} · ${fmtScore(abScoring.capability.score)}分` : '—', color: toneColor(abScoring.capability.tone), bg: toneBg(abScoring.capability.tone), dot: toneColor(abScoring.capability.tone) },
                                    { icon: '💰', name: '成本 · COST', value: decisionReady ? `${fmtPct(abScoring.cost.deltaTokenPct)} Token · ${fmtScore(abScoring.cost.score)}分` : '—', color: toneColor(abScoring.cost.tone), bg: toneBg(abScoring.cost.tone), dot: toneColor(abScoring.cost.tone) },
                                    { icon: '🎯', name: '稳定性 · STABILITY', value: decisionReady ? `触发率 ${fmtRate(abScoring.stability.invokeRate)} · ${fmtScore(abScoring.stability.score)}分` : '—', color: toneColor(abScoring.stability.tone), bg: toneBg(abScoring.stability.tone), dot: toneColor(abScoring.stability.tone) },
                                ].map(item => (
                                    <div key={item.name} style={{ background: 'white', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                                        <div style={{ width: 38, height: 38, borderRadius: 8, background: item.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{item.icon}</div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 10, color: '#888780', fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: 1 }}>{item.name}</div>
                                            <div style={{ fontSize: 16, fontWeight: 800, color: item.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</div>
                                        </div>
                                        <div style={{ width: 9, height: 9, borderRadius: '50%', background: item.dot }} />
                                    </div>
                                ))}
                            </div>

                            <div style={{ display: 'flex', gap: 12, alignItems: 'center', background: 'white', border: '1px solid rgba(0,0,0,0.1)', padding: '12px 16px', borderRadius: 8, marginTop: 16 }}>
                                <span style={{ background: '#1C1917', color: 'white', padding: '6px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>下一步建议</span>
                                <span style={{ fontSize: 14, color: '#2C2C2A', lineHeight: 1.55 }}>{decisionAdvice}</span>
                            </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div style={{ border: '1px solid rgba(0,0,0,0.1)', background: '#FAFAF7', borderRadius: 12, padding: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ width: 34, height: 34, borderRadius: 8, background: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📊</span>
                                        <div style={{ fontSize: 16, fontWeight: 800 }}>能力 <span style={{ color: '#A8A29E', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>这个 skill 让 agent 多做成了多少事?</span></div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 800 }}>{decisionReady ? fmtPct(abScoring.capability.deltaPp, 'pp') : '—'} <span style={{ background: toneBg(abScoring.capability.tone), color: toneColor(abScoring.capability.tone), borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>● {abScoring.capability.label}</span></div>
                                </div>
                                {[
                                    { label: '通过率', a: `${abScoring.capability.passRateA ?? '—'}%`, b: `${abScoring.capability.passRateB ?? '—'}%`, aw: abScoring.capability.passRateA ?? 0, bw: abScoring.capability.passRateB ?? 0, delta: decisionReady ? fmtPct(abScoring.capability.deltaPp, 'pp') : '—' },
                                    { label: '能力分', a: '—', b: fmtScore(abScoring.capability.score), aw: 0, bw: abScoring.capability.score ?? 0, delta: abScoring.capability.label },
                                ].map(row => (
                                    <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px 80px', gap: 14, alignItems: 'center', marginTop: 14 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: '#5F5E5A' }}>{row.label}</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 14, color: '#EA580C', fontWeight: 800 }}>A</span><div style={{ flex: 1, height: 6, background: '#E7E5E4', borderRadius: 999 }}><div style={{ width: `${Math.max(2, row.aw)}%`, height: '100%', background: '#EA580C', borderRadius: 999 }} /></div></div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 14, color: '#16A34A', fontWeight: 800 }}>B</span><div style={{ flex: 1, height: 6, background: '#E7E5E4', borderRadius: 999 }}><div style={{ width: `${Math.max(2, row.bw)}%`, height: '100%', background: '#16A34A', borderRadius: 999 }} /></div></div>
                                        </div>
                                        <div style={{ fontSize: 13, color: '#5F5E5A', lineHeight: 1.9 }}>{row.a}<br />{row.b}</div>
                                        <div style={{ color: toneColor(abScoring.capability.tone), fontWeight: 800 }}>{row.delta}</div>
                                    </div>
                                ))}
                                {abScoring.capability.dataQualityIssue && (
                                    <div style={{ color: '#BA7517', fontSize: 12, marginTop: 12 }}>{abScoring.capability.dataQualityIssue}</div>
                                )}
                            </div>

                            <div style={{ border: '1px solid rgba(0,0,0,0.1)', background: '#FAFAF7', borderRadius: 12, padding: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ width: 34, height: 34, borderRadius: 8, background: '#FAEEDA', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>💰</span>
                                        <div style={{ fontSize: 16, fontWeight: 800 }}>成本 <span style={{ color: '#A8A29E', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>多花了多少 token / 时间?</span></div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 800 }}>{fmtPct(abScoring.cost.deltaTokenPct)} Token · {fmtPct(abScoring.cost.deltaDurationPct)} 耗时 <span style={{ background: toneBg(abScoring.cost.tone), color: toneColor(abScoring.cost.tone), borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>● {abScoring.cost.label}</span></div>
                                </div>
                                {[
                                    { label: 'Token 消耗', a: abScoring.cost.avgTokensA == null ? '—' : String(abScoring.cost.avgTokensA), b: abScoring.cost.avgTokensB == null ? '—' : String(abScoring.cost.avgTokensB), aw: abScoring.cost.avgTokensA ?? 0, bw: abScoring.cost.avgTokensB ?? 0, delta: fmtPct(abScoring.cost.deltaTokenPct), warn: abScoring.cost.tone !== 'green' },
                                    { label: '响应耗时', a: abScoring.cost.avgDurationA == null ? '—' : `${abScoring.cost.avgDurationA}s`, b: abScoring.cost.avgDurationB == null ? '—' : `${abScoring.cost.avgDurationB}s`, aw: abScoring.cost.avgDurationA ?? 0, bw: abScoring.cost.avgDurationB ?? 0, delta: fmtPct(abScoring.cost.deltaDurationPct), warn: false },
                                    { label: '执行步数', a: abScoring.cost.avgStepsA == null ? '—' : String(abScoring.cost.avgStepsA), b: abScoring.cost.avgStepsB == null ? '—' : String(abScoring.cost.avgStepsB), aw: abScoring.cost.avgStepsA ?? 0, bw: abScoring.cost.avgStepsB ?? 0, delta: fmtPct(abScoring.cost.deltaStepsPct), warn: false },
                                ].map(row => {
                                    const max = Math.max(Number(row.aw) || 1, Number(row.bw) || 1);
                                    return (
                                        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px 80px', gap: 14, alignItems: 'center', marginTop: 14 }}>
                                            <div style={{ fontSize: 14, fontWeight: 700, color: '#5F5E5A' }}>{row.label}</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 14, color: '#EA580C', fontWeight: 800 }}>A</span><div style={{ flex: 1, height: 6, background: '#E7E5E4', borderRadius: 999 }}><div style={{ width: `${Math.max(4, Math.round((Number(row.aw) || 0) / max * 100))}%`, height: '100%', background: '#EA580C', borderRadius: 999 }} /></div></div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 14, color: '#16A34A', fontWeight: 800 }}>B</span><div style={{ flex: 1, height: 6, background: '#E7E5E4', borderRadius: 999 }}><div style={{ width: `${Math.max(4, Math.round((Number(row.bw) || 0) / max * 100))}%`, height: '100%', background: row.warn ? '#DC2626' : '#16A34A', borderRadius: 999 }} /></div></div>
                                            </div>
                                            <div style={{ fontSize: 13, color: '#5F5E5A', lineHeight: 1.9 }}>{row.a}<br />{row.b}</div>
                                            <div style={{ color: row.warn ? toneColor(abScoring.cost.tone) : '#BA7517', fontWeight: 800 }}>{row.delta}</div>
                                        </div>
                                    );
                                })}
                                {abScoring.cost.dataQualityIssue && (
                                    <div style={{ color: '#BA7517', fontSize: 12, marginTop: 12 }}>{abScoring.cost.dataQualityIssue}</div>
                                )}
                            </div>

                            <div style={{ border: '1px solid rgba(0,0,0,0.1)', background: '#FAFAF7', borderRadius: 12, padding: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ width: 34, height: 34, borderRadius: 8, background: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎯</span>
                                        <div style={{ fontSize: 16, fontWeight: 800 }}>稳定性 <span style={{ color: '#A8A29E', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>该触发的时候触发了吗?结果稳吗?</span></div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 800 }}>触发率 {fmtRate(abScoring.stability.invokeRate)} · 方差 {abScoring.stability.variance ?? '—'} <span style={{ background: toneBg(abScoring.stability.tone), color: toneColor(abScoring.stability.tone), borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>● {abScoring.stability.label}</span></div>
                                </div>
                                {[
                                    { label: 'Skill 触发率', value: fmtRate(abScoring.stability.invokeRate), width: abScoring.stability.invokeRate ?? 0 },
                                    { label: '多轮一致性', value: abScoring.stability.variance == null ? '方差不可计算' : `方差 ${abScoring.stability.variance}`, width: abScoring.stability.varianceScore ?? 0 },
                                ].map(row => (
                                    <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 110px 20px', gap: 14, alignItems: 'center', marginTop: 14 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: '#5F5E5A' }}>{row.label}</div>
                                        <div style={{ height: 7, background: '#E7E5E4', borderRadius: 999 }}><div style={{ width: `${Math.max(3, row.width)}%`, height: '100%', background: '#16A34A', borderRadius: 999 }} /></div>
                                        <div style={{ color: toneColor(abScoring.stability.tone), fontWeight: 800, textAlign: 'right' }}>{row.value}</div>
                                        <div style={{ width: 12, height: 12, borderRadius: '50%', background: toneColor(abScoring.stability.tone) }} />
                                    </div>
                                ))}
                                {abScoring.stability.dataQualityIssue && (
                                    <div style={{ color: '#BA7517', fontSize: 12, marginTop: 12 }}>{abScoring.stability.dataQualityIssue}</div>
                                )}
                            </div>
                        </div>
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
                                        {taskHistory.length}{locale === 'zh' ? ' 条' : ' tasks'}
                                    </span>
                                </div>
                                <button className="d-drawer-close" onClick={() => setShowHistoryDrawer(false)}>×</button>
                            </div>
                            <div className="d-history-body">
                                {taskHistory.length === 0 ? (
                                    <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-4)', fontSize: 12 }}>
                                        {locale === 'zh' ? '暂无历史任务' : 'No task history'}
                                    </div>
                                ) : taskHistory.slice().reverse().map(t => (
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
