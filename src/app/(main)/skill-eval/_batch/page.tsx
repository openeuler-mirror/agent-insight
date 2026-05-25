'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { SectionShell, FindingsGrouped } from '@/components/evaluation';
import type { FindingItem, FindingGroup } from '@/components/evaluation';
import '@/components/evaluation/evaluation-content.css';
import '../debug.css';

const CELL_MAX_CHARS = 80;

function TruncatedText({ text }: { text: string }) {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const isLong = text.length > CELL_MAX_CHARS;
    if (!isLong) return <>{text}</>;
    return (
        <span
            style={{ cursor: 'default' }}
            onMouseEnter={e => setPos({ x: e.clientX, y: e.clientY })}
            onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setPos(null)}
        >
            {text.slice(0, CELL_MAX_CHARS)}…
            {pos && (
                <div
                    className="cell-tooltip-bubble"
                    style={{
                        left: Math.min(pos.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 360),
                        top: pos.y + 18,
                    }}
                >
                    {text}
                </div>
            )}
        </span>
    );
}

/* ============================
   本文件原本承担 /skill-eval/batch 独立路由（用例覆盖分析页）。
   该路由已下线（无入口），目录改名为 _batch（下划线前缀 → Next.js App Router 不路由），
   仅作为 /skill-eval 中"用例分析卡 → 从数据集模式"的内部嵌入组件。
   只导出 BatchEvaluation；BatchPage / BatchPageInner standalone 壳已删。
   ============================ */

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

interface GrayscaleTask {
    id: string;
    user: string;
    taskName: string;
    createdAt: string;
    configJson?: {
        skillId?: string;
        versionAId?: string;
        versionBId?: string;
        queryMode?: 'manual' | 'dataset';
        query?: string;
        selectedDatasetId?: string;
        selectedCaseId?: string;
        taskDescription?: string;
    };
    caseStatesJson?: { a: PerVersionState; b: PerVersionState };
}

interface PerVersionState {
    status: CaseStatus;
    jobId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
}

type CaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

interface CaseState {
    status: CaseStatus;
    jobId?: string;
    timeCost?: string;
    tokenUsage?: number;
    score?: number;
    output?: string;
    sessionId?: string;
    evaluatorRunId?: string;
}

interface BatchEvalTask {
    id: string;
    user: string;
    taskName: string;
    createdAt: string;
    configJson?: {
        datasetIds?: string[];
        skillId?: string;
        versionId?: string;
        taskDescription?: string;
        sourceMode?: 'dataset' | 'trace';
        evaluatorId?: string;
        traceSkillId?: string;
        traceTimeRange?: '1d' | '3d' | '7d';
        traceDatasetId?: string;
    };
    caseStatesJson?: Record<string, CaseState>;
    traceEvalStatesJson?: Record<string, TraceEvalStateInfo>;
}

import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

// 内置评估器选项 —— 跟 src/components/EvaluatorsCenter.tsx 的 presetEvaluators 保持同步。
// 仅列「有真实后端运行时」的预置评估器（status='ready'）；后端 SUPPORTED_TRAJECTORY_EVALUATORS 
// 也认这三个 id。漏 preset-agent-task-completion 会让用户没法跑结果对照。
const BUILT_IN_EVALUATORS = [
    ...presetEvaluators.filter(e => e.status === 'ready').map(e => ({ id: e.id, name: e.name }))
];


interface TraceRecord {
    upload_id?: string;
    task_id?: string;
    query?: string;
    skills?: unknown;
    timestamp?: string;
    timeCost?: string;
    framework?: string;
}

interface TraceEvalStateInfo {
    status: 'idle' | 'evaluating' | 'done' | 'fail';
    score?: number;
    evaluatorRunId?: string;
    taskId?: string; // stored so polling can be resumed after page refresh
}


/* ============================
   BATCH EVALUATION (用例测评) —— 用例分析卡 "从数据集" 模式的内核
   ============================ */
export function BatchEvaluation({
    newTaskTrigger,
    historyPanelTrigger,
    topConfigSlot,
}: {
    newTaskTrigger: number;
    historyPanelTrigger: number;
    /** 可选 slot：渲染在 ① 配置 body 顶部（task-strip 之前）。
        用例分析页 dataset 模式下注入"用例来源 toggle"——让 source 切换在 ① 配置里，与 trace 模式对称。 */
    topConfigSlot?: React.ReactNode;
}) {
    const { locale } = useLocale();
    const { user } = useAuth();
    const router = useRouter();

    // Task name state
    const [currentTask, setCurrentTask] = useState<BatchEvalTask | null>(null);
    const [taskHistory, setTaskHistory] = useState<BatchEvalTask[]>([]);
    const [isEditingTask, setIsEditingTask] = useState(false);
    const [taskNameInput, setTaskNameInput] = useState('');
    const [taskDescInput, setTaskDescInput] = useState('');
    const [isEditingDesc, setIsEditingDesc] = useState(false);
    const [isCreatingTask, setIsCreatingTask] = useState(false);


    // Data
    const [datasets, setDatasets] = useState<any[]>([]);
    const [skills, setSkills] = useState<SkillOption[]>([]);
    const [versions, setVersions] = useState<SkillVersionOption[]>([]);

    // Config
    const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
    const [selectedSkillId, setSelectedSkillId] = useState('');
    const [selectedVersionId, setSelectedVersionId] = useState('');

    // Evaluator
    const [userEvaluators, setUserEvaluators] = useState<Array<{id: string; name: string}>>([]);
    const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('preset-agent-trace-quality');
    const [showEvalDropdown, setShowEvalDropdown] = useState(false);

    // Source mode: 'dataset' (existing flow) | 'trace' (evaluate from real executions)
    const [sourceMode, setSourceMode] = useState<'dataset' | 'trace'>('dataset');
    const [showSourceDropdown, setShowSourceDropdown] = useState(false);

    // Trace mode filters
    const [traceSkillId, setTraceSkillId] = useState('');
    const [traceTimeRange, setTraceTimeRange] = useState<'1d' | '3d' | '7d'>('7d');
    const [traceDatasetId, setTraceDatasetId] = useState('');
    const [traceRecords, setTraceRecords] = useState<TraceRecord[]>([]);
    const [traceLoading, setTraceLoading] = useState(false);
    const [traceEvalStates, setTraceEvalStates] = useState<Record<string, TraceEvalStateInfo>>({});
    const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>([]);

    // Modal state
    const [showDatasetModal, setShowDatasetModal] = useState(false);
    const [showSkillModal, setShowSkillModal] = useState(false);
    const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
    const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
    const [showTraceDatasetModal, setShowTraceDatasetModal] = useState(false);
    const [showTraceSkillModal, setShowTraceSkillModal] = useState(false);

    // ① 配置 / ② 执行 / ③ 结果 三段式折叠态。固定默认：① ② 折叠 / ③ 展开。
    // 与触发分析页一致——把回访场景的"先看结果"作为默认视野。
    // ① 配置 默认展开——dataset 模式下用户点击切到这里时直接看到完整配置（task-strip + 用例表），
    // 不用再点一下"展开"。② / ③ 维持折叠态。
    const [configSecOpen, setConfigSecOpen] = useState(true);
    const [execSecOpen, setExecSecOpen] = useState(false);
    const [resultSecOpen, setResultSecOpen] = useState(true);

    // Refs for dropdown fixed positioning (avoids overflow:hidden clipping)
    const sourceChipRef = useRef<HTMLButtonElement>(null);
    const evalChipRef = useRef<HTMLButtonElement>(null);
    const [sourceDropdownPos, setSourceDropdownPos] = useState({ top: 0, left: 0 });
    const [evalDropdownPos, setEvalDropdownPos] = useState({ top: 0, left: 0 });

    // Filter & selection
    const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'executed' | 'evaluated' | 'failed'>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);

    // Case execution states
    const [caseStates, setCaseStates] = useState<Record<string, CaseState>>({});
    // Per-case polling intervals: caseId → intervalId
    const pollIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
    // Per-case eval polling intervals
    const evalPollIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
    // Task-level refresh interval (active while any case is running/evaluating)
    const taskPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasActiveJobsRef = useRef(false);
    // When restoring from history, preserve the exact versionId instead of auto-selecting current
    const pendingVersionIdRef = useRef<string | null>(null);

    const defaultTaskName = () => {
        const now = new Date();
        return `评测任务 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    };

    // Load most recent batch eval task on mount
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/debug/batch-tasks?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                    setTaskHistory(data);
                    const latest = data[0];
                    setCurrentTask(latest);
                    // Restore persisted config and case states for the most recent task
                    const cfg = latest.configJson || {};
                    setSelectedDatasetIds(cfg.datasetIds || []);
                    if (cfg.versionId) pendingVersionIdRef.current = cfg.versionId;
                    setSelectedSkillId(cfg.skillId || '');
                    setSelectedVersionId(cfg.versionId || '');
                    setTaskDescInput(cfg.taskDescription || '');
                    if (cfg.sourceMode) setSourceMode(cfg.sourceMode);
                    if (cfg.evaluatorId) setSelectedEvaluatorId(cfg.evaluatorId);
                    if (cfg.traceSkillId) setTraceSkillId(cfg.traceSkillId);
                    if (cfg.traceTimeRange) setTraceTimeRange(cfg.traceTimeRange);
                    if (cfg.traceDatasetId) setTraceDatasetId(cfg.traceDatasetId);
                    setCaseStates(latest.caseStatesJson || {});
                    setTraceEvalStates(latest.traceEvalStatesJson || {});
                } else {
                    // No history — enter editing mode with default name
                    setTaskNameInput(defaultTaskName());
                    setIsEditingTask(true);
                }
            })
            .catch(() => {
                setTaskNameInput(defaultTaskName());
                setIsEditingTask(true);
            });
    }, [user]);

    const persistTaskUpdate = useCallback(async (
        taskId: string,
        configJson?: {
            datasetIds: string[];
            skillId: string;
            versionId: string;
            taskDescription?: string;
            sourceMode?: 'dataset' | 'trace';
            evaluatorId?: string;
            traceSkillId?: string;
            traceTimeRange?: '1d' | '3d' | '7d';
            traceDatasetId?: string;
        },
        caseStatesUpdate?: Record<string, CaseState>,
        traceEvalStatesUpdate?: Record<string, TraceEvalStateInfo>
    ) => {
        if (!user || !taskId) return;
        const body: Record<string, unknown> = { user };
        if (configJson !== undefined) body.configJson = configJson;
        if (caseStatesUpdate !== undefined) body.caseStatesJson = caseStatesUpdate;
        if (traceEvalStatesUpdate !== undefined) body.traceEvalStatesJson = traceEvalStatesUpdate;
        try {
            await apiFetch(`/api/debug/batch-tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch {}
    }, [user]);

    const handleSaveTask = async () => {
        if (!taskNameInput.trim() || !user) return;
        setIsCreatingTask(true);
        try {
            const res = await apiFetch('/api/debug/batch-tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, taskName: taskNameInput.trim() }),
            });
            if (res.ok) {
                const newTask = await res.json();
                // Persist description if provided
                if (taskDescInput.trim()) {
                    await apiFetch(`/api/debug/batch-tasks/${newTask.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user, configJson: { taskDescription: taskDescInput.trim() } }),
                    }).catch(() => {});
                    newTask.configJson = { ...(newTask.configJson || {}), taskDescription: taskDescInput.trim() };
                }
                setCurrentTask(newTask);
                setTaskHistory(prev => [newTask, ...prev]);
                setIsEditingTask(false);
                setTaskNameInput('');
                // Reset dataset/skill selection for new task
                setSelectedDatasetIds([]);
                setSelectedSkillId('');
                setSelectedVersionId('');
                setCaseStates({});
            }
        } catch {}
        finally { setIsCreatingTask(false); }
    };

    const handleNewTask = () => {
        setTaskNameInput(defaultTaskName());
        setTaskDescInput('');
        setIsEditingTask(true);
        setShowHistoryDropdown(false);
    };

    // Trigger new task creation when parent's button is clicked
    const triggerSeenRef = useRef(newTaskTrigger);
    useEffect(() => {
        if (newTaskTrigger !== triggerSeenRef.current) {
            triggerSeenRef.current = newTaskTrigger;
            handleNewTask();
        }
    }, [newTaskTrigger]);

    // Trigger history drawer open when parent's history button is clicked
    const historyTriggerSeenRef = useRef(historyPanelTrigger);
    useEffect(() => {
        if (historyPanelTrigger !== historyTriggerSeenRef.current) {
            historyTriggerSeenRef.current = historyPanelTrigger;
            setShowHistoryDrawer(true);
        }
    }, [historyPanelTrigger]);

    const handleSaveDesc = async () => {
        if (!currentTask || !user) return;
        const desc = taskDescInput.trim();
        const cfg = { ...currentConfigRef.current, taskDescription: desc };
        setIsEditingDesc(false);
        await persistTaskUpdate(currentTask.id, cfg).catch(() => {});
        setCurrentTask(prev => prev ? { ...prev, configJson: { ...(prev.configJson || {}), taskDescription: desc } } : prev);
    };

    const handleSelectHistoryTask = (t: BatchEvalTask) => {
        setCurrentTask(t);
        setIsEditingTask(false);
        setShowHistoryDropdown(false);
        setTaskNameInput('');
        const cfg = t.configJson || {};
        setSelectedDatasetIds(cfg.datasetIds || []);
        if (cfg.versionId) pendingVersionIdRef.current = cfg.versionId;
        setSelectedSkillId(cfg.skillId || '');
        setSelectedVersionId(cfg.versionId || '');
        setTaskDescInput(cfg.taskDescription || '');
        setSourceMode(cfg.sourceMode || 'dataset');
        setSelectedEvaluatorId(cfg.evaluatorId || 'preset-agent-trace-quality');
        setTraceSkillId(cfg.traceSkillId || '');
        setTraceTimeRange(cfg.traceTimeRange || '7d');
        setTraceDatasetId(cfg.traceDatasetId || '');
        setCaseStates(t.caseStatesJson || {});
        setTraceEvalStates(t.traceEvalStatesJson || {});
    };

    // Fetch on mount
    useEffect(() => {
        if (!user) return;
        Promise.all([
            apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`).then(r => r.json()),
            apiFetch(`/api/skills?user=${encodeURIComponent(user)}`).then(r => r.json()),
            apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`).then(r => r.json()).catch(() => []),
        ]).then(([ds, sk, ev]) => {
            if (Array.isArray(ds)) setDatasets(ds);
            if (Array.isArray(sk)) setSkills(sk.map((s: any) => ({ id: s.id, name: s.name })));
            if (Array.isArray(ev)) setUserEvaluators(ev.map((e: any) => ({ id: e.id, name: e.name })));
        }).catch(() => {});
    }, [user]);

    useEffect(() => {
        if (!user || !selectedSkillId) { setVersions([]); setSelectedVersionId(''); return; }
        apiFetch(`/api/skills/${selectedSkillId}/versions?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setVersions(data);
                    // If restoring from history, use the saved versionId; otherwise pick current
                    const pending = pendingVersionIdRef.current;
                    if (pending && data.find((v: any) => v.id === pending)) {
                        pendingVersionIdRef.current = null;
                        setSelectedVersionId(pending);
                    } else {
                        pendingVersionIdRef.current = null;
                        const cur = data.find((v: any) => v.isCurrent);
                        setSelectedVersionId(cur ? cur.id : data[0]?.id || '');
                    }
                }
            }).catch(() => {});
    }, [user, selectedSkillId]);

    // Fetch trace records when in trace mode (only after a skill is selected)
    useEffect(() => {
        if (sourceMode !== 'trace' || !user || !traceSkillId) { setTraceRecords([]); return; }
        setTraceLoading(true);
        const traceSkill = skills.find(s => s.id === traceSkillId);
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
    }, [sourceMode, user, traceSkillId, traceTimeRange, skills]);

    // After restoring traceEvalStates from DB, resume polling for any 'evaluating' entries
    // that have a known evaluatorRunId (handles page-refresh-during-evaluation scenario).
    useEffect(() => {
        if (!user) return;
        for (const [key, info] of Object.entries(traceEvalStates)) {
            if (info.status !== 'evaluating' || !info.evaluatorRunId || !info.taskId) continue;
            if (evalPollIntervalsRef.current[`tr_${key}`]) continue; // already polling
            const { evaluatorRunId, taskId } = info;
            const pollEval = async () => {
                try {
                    const res = await apiFetch(
                        `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}`
                    );
                    const data = await res.json();
                    const results: any[] = data.results || [];
                    const result = results.find((r: any) => r.taskId === taskId);
                    if (!result) return;
                    if (result.status === 'done') {
                        clearInterval(evalPollIntervalsRef.current[`tr_${key}`]);
                        delete evalPollIntervalsRef.current[`tr_${key}`];
                        const score = Math.round((result.trajectoryScore ?? 0) * 100);
                        setTraceEvalStates(prev => {
                            const next = { ...prev, [key]: { status: 'done' as const, score, evaluatorRunId, taskId } };
                            persistTraceEvalUpdate(next);
                            return next;
                        });
                    } else if (result.status === 'failed') {
                        clearInterval(evalPollIntervalsRef.current[`tr_${key}`]);
                        delete evalPollIntervalsRef.current[`tr_${key}`];
                        setTraceEvalStates(prev => {
                            const next = { ...prev, [key]: { status: 'fail' as const, taskId } };
                            persistTraceEvalUpdate(next);
                            return next;
                        });
                    }
                } catch { /* keep polling */ }
            };
            pollEval();
            evalPollIntervalsRef.current[`tr_${key}`] = setInterval(pollEval, 5_000);
        }
    // Run once after traceEvalStates is restored from DB (currentTask load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTask?.id, user]);

    // After restoring caseStates from DB, resume polling for any 'evaluating' entries
    // that have a known evaluatorRunId (handles page-refresh-during-evaluation scenario for dataset cases).
    useEffect(() => {
        if (!user) return;
        for (const [caseId, state] of Object.entries(caseStates)) {
            if (state.status !== 'evaluating' || !state.evaluatorRunId) continue;
            if (evalPollIntervalsRef.current[caseId]) continue; // already polling
            const { evaluatorRunId } = state;
            const pollEval = async () => {
                try {
                    const res = await apiFetch(
                        `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}`
                    );
                    const data = await res.json();
                    const results: any[] = data.results || [];
                    const result = results.find((r: any) => r.caseId === caseId);
                    if (!result) return;
                    if (result.status === 'done') {
                        clearInterval(evalPollIntervalsRef.current[caseId]);
                        delete evalPollIntervalsRef.current[caseId];
                        const score = Math.round((result.trajectoryScore ?? 0) * 100);
                        const pass = score >= 60;
                        setCaseStates(prev => {
                            const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: (pass ? 'pass' : 'fail') as CaseStatus, score } };
                            persistCaseStateUpdate(next);
                            return next;
                        });
                    } else if (result.status === 'failed') {
                        clearInterval(evalPollIntervalsRef.current[caseId]);
                        delete evalPollIntervalsRef.current[caseId];
                        setCaseStates(prev => {
                            const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'fail' as CaseStatus, output: result.errorMessage || '轨迹评测失败' } };
                            persistCaseStateUpdate(next);
                            return next;
                        });
                    }
                } catch { /* keep polling */ }
            };
            pollEval();
            evalPollIntervalsRef.current[caseId] = setInterval(pollEval, 5_000);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTask?.id, user]);

    // Build flat case list from selected datasets
    const allCases = datasets
        .filter(ds => selectedDatasetIds.includes(ds.id))
        .flatMap(ds => {
            const cases = ds.cases || [];
            if (cases.length === 0) return [{
                id: `mock_${ds.id}`,
                input: `[${locale === 'zh' ? '示例' : 'Sample'}] ${ds.name}`,
                datasetName: ds.name,
                datasetId: ds.id,
                isMock: true
            }];
            return cases.map((c: any) => ({ ...c, datasetName: ds.name, datasetId: ds.id }));
        });

    // Filtered cases
    const filteredCases = allCases.filter(c => {
        const state = caseStates[c.id];
        const status = state?.status || 'pending';
        const matchFilter = filterStatus === 'all'
            || (filterStatus === 'pending' && status === 'pending')
            || (filterStatus === 'executed' && (status === 'executed' || status === 'evaluating'))
            || (filterStatus === 'evaluated' && (status === 'pass' || status === 'fail'))
            || (filterStatus === 'failed' && status === 'fail');
        const matchSearch = !searchQuery || c.input?.toLowerCase().includes(searchQuery.toLowerCase());
        return matchFilter && matchSearch;
    });

    // Counts
    const pendingCount = allCases.filter(c => !caseStates[c.id] || caseStates[c.id].status === 'pending').length;
    const executedCount = allCases.filter(c => caseStates[c.id]?.status === 'executed').length;
    const evaluatedCount = allCases.filter(c => caseStates[c.id]?.status === 'pass' || caseStates[c.id]?.status === 'fail').length;
    const failedCount = allCases.filter(c => caseStates[c.id]?.status === 'fail').length;
    const passCount = allCases.filter(c => caseStates[c.id]?.status === 'pass').length;
    const evaluatingCount = allCases.filter(c => caseStates[c.id]?.status === 'evaluating').length;

    const evalPct = allCases.length > 0 ? Math.round((evaluatedCount / allCases.length) * 100) : 0;

    const selectedSkill = skills.find(s => s.id === selectedSkillId);
    const selectedVersion = versions.find(v => v.id === selectedVersionId);

    // Refs to avoid stale closures in async callbacks and poll intervals
    const currentTaskRef = useRef<BatchEvalTask | null>(null);
    useEffect(() => { currentTaskRef.current = currentTask; }, [currentTask]);
    const caseStatesRef = useRef<Record<string, CaseState>>({});
    useEffect(() => { caseStatesRef.current = caseStates; }, [caseStates]);
    const traceEvalStatesRef = useRef<Record<string, TraceEvalStateInfo>>({});
    useEffect(() => { traceEvalStatesRef.current = traceEvalStates; }, [traceEvalStates]);

    // Snapshot current config for persistence
    const currentConfigRef = useRef({
        datasetIds: selectedDatasetIds,
        skillId: selectedSkillId,
        versionId: selectedVersionId,
        taskDescription: taskDescInput,
        sourceMode,
        evaluatorId: selectedEvaluatorId,
        traceSkillId,
        traceTimeRange,
        traceDatasetId,
    });
    useEffect(() => {
        currentConfigRef.current = {
            datasetIds: selectedDatasetIds,
            skillId: selectedSkillId,
            versionId: selectedVersionId,
            taskDescription: taskDescInput,
            sourceMode,
            evaluatorId: selectedEvaluatorId,
            traceSkillId,
            traceTimeRange,
            traceDatasetId,
        };
    }, [selectedDatasetIds, selectedSkillId, selectedVersionId, taskDescInput, sourceMode, selectedEvaluatorId, traceSkillId, traceTimeRange, traceDatasetId]);

    // Auto-persist config to DB whenever user changes key settings (debounced 800 ms).
    // Skips during initial load by checking that currentTask is already set.
    const configPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!currentTask || !user) return;
        if (configPersistTimerRef.current) clearTimeout(configPersistTimerRef.current);
        configPersistTimerRef.current = setTimeout(() => {
            persistTaskUpdate(currentTask.id, currentConfigRef.current, undefined);
        }, 800);
        return () => {
            if (configPersistTimerRef.current) clearTimeout(configPersistTimerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceMode, selectedEvaluatorId, traceSkillId, traceTimeRange, traceDatasetId, selectedDatasetIds, selectedSkillId, selectedVersionId, currentTask?.id, user]);

    // Persist case states — uses ref so poll closures always see the latest task
    const persistCaseStateUpdate = useCallback((updatedStates: Record<string, CaseState>) => {
        if (!currentTaskRef.current) return;
        persistTaskUpdate(currentTaskRef.current.id, currentConfigRef.current, updatedStates);
    }, [persistTaskUpdate]);

    // Persist trace eval states — called whenever a trace record's eval status changes
    const persistTraceEvalUpdate = useCallback((updatedStates: Record<string, TraceEvalStateInfo>) => {
        if (!currentTaskRef.current) return;
        persistTaskUpdate(currentTaskRef.current.id, undefined, undefined, updatedStates);
    }, [persistTaskUpdate]);

    // Track whether any case is actively running or evaluating
    const hasActiveJobs = Object.values(caseStates).some(
        s => s.status === 'running' || s.status === 'evaluating'
    );
    useEffect(() => { hasActiveJobsRef.current = hasActiveJobs; }, [hasActiveJobs]);

    // Task-level status refresh — polls the server every 15 s while any case is active.
    // Only updates cases not already managed by a local per-case poll interval (catch-up mechanism).
    useEffect(() => {
        if (!currentTask || !user) return;
        const pollTask = async () => {
            if (!hasActiveJobsRef.current) return;
            const task = currentTaskRef.current;
            if (!task) return;
            try {
                const res = await apiFetch(`/api/debug/batch-tasks/${task.id}?user=${encodeURIComponent(user)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (data.caseStatesJson) {
                    setCaseStates(prev => {
                        const next = { ...prev };
                        for (const [id, state] of Object.entries(data.caseStatesJson as Record<string, CaseState>)) {
                            if (!pollIntervalsRef.current[id] && !evalPollIntervalsRef.current[id]) {
                                next[id] = state as CaseState;
                            }
                        }
                        return next;
                    });
                }
            } catch {}
        };
        taskPollIntervalRef.current = setInterval(pollTask, 15_000);
        return () => {
            if (taskPollIntervalRef.current) {
                clearInterval(taskPollIntervalRef.current);
                taskPollIntervalRef.current = null;
            }
        };
    }, [currentTask?.id, user]);

    // Flush to DB when user navigates away (handles "running" state surviving navigation)
    useEffect(() => {
        return () => {
            const task = currentTaskRef.current;
            const states = caseStatesRef.current;
            const traceStates = traceEvalStatesRef.current;
            if (task && (Object.keys(states).length > 0 || Object.keys(traceStates).length > 0)) {
                persistTaskUpdate(task.id, currentConfigRef.current, states, traceStates);
            }
            // Clean up all polls
            Object.values(evalPollIntervalsRef.current).forEach(clearInterval);
            evalPollIntervalsRef.current = {};
            if (taskPollIntervalRef.current) {
                clearInterval(taskPollIntervalRef.current);
                taskPollIntervalRef.current = null;
            }
        };
    }, [persistTaskUpdate]);

    // Per-case execution — dispatches a real agent job and polls every 10 s
    const executeCase = async (caseId: string) => {
        // Clear any existing poll for this case
        if (pollIntervalsRef.current[caseId]) {
            clearInterval(pollIntervalsRef.current[caseId]);
            delete pollIntervalsRef.current[caseId];
        }

        const caseItem = allCases.find(c => c.id === caseId);
        const query = caseItem?.input || caseId;

        // Save config on every execute click
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, currentConfigRef.current, undefined);
        }

        setCaseStates(prev => ({ ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'running' } }));

        let jobId: string;
        try {
            const res = await apiFetch('/api/debug/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    query,
                    skill: selectedSkill?.name,
                    skillVersion: selectedVersion ? Number(selectedVersion.version) : undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.jobId) {
                setCaseStates(prev => {
                    const next = { ...prev, [caseId]: { status: 'fail' as CaseStatus, output: data.error || 'dispatch failed' } };
                    persistCaseStateUpdate(next);
                    return next;
                });
                return;
            }
            jobId = data.jobId;
        } catch (err) {
            setCaseStates(prev => {
                const next = { ...prev, [caseId]: { status: 'fail' as CaseStatus, output: String(err) } };
                persistCaseStateUpdate(next);
                return next;
            });
            return;
        }

        // Persist running+jobId immediately so navigating away and returning shows correct status
        setCaseStates(prev => {
            const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'running' as CaseStatus, jobId } };
            persistCaseStateUpdate(next);
            return next;
        });

        // Poll every 10 s
        const poll = async () => {
            try {
                const res = await apiFetch(`/api/debug/execute/${jobId}`);
                const data = await res.json();
                if (data.status === 'completed') {
                    clearInterval(pollIntervalsRef.current[caseId]);
                    delete pollIntervalsRef.current[caseId];
                    setCaseStates(prev => {
                        const next = {
                            ...prev,
                            [caseId]: {
                                status: 'executed' as CaseStatus,
                                jobId,
                                output: data.output ?? '',
                                timeCost: data.timeCost,
                                tokenUsage: data.tokenUsage ?? 0,
                                sessionId: data.sessionId,
                            }
                        };
                        persistCaseStateUpdate(next);
                        return next;
                    });
                } else if (data.status === 'failed' || !data.status || data.error) {
                    // Covers: explicit failure, server-restart-lost jobs, and unexpected responses
                    clearInterval(pollIntervalsRef.current[caseId]);
                    delete pollIntervalsRef.current[caseId];
                    setCaseStates(prev => {
                        const next = { ...prev, [caseId]: { status: 'fail' as CaseStatus, jobId, output: data.error || 'agent failed' } };
                        persistCaseStateUpdate(next);
                        return next;
                    });
                }
                // status === 'running' → keep polling
            } catch {
                // network hiccup — keep polling
            }
        };

        // First check immediately, then every 10 s
        await poll();
        pollIntervalsRef.current[caseId] = setInterval(poll, 10_000);
    };

    const evaluateCase = async (caseId: string) => {
        // Save current task config before triggering evaluation
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, currentConfigRef.current, undefined);
        }

        const currentState = caseStatesRef.current[caseId];
        const sessionId = currentState?.sessionId;
        const caseItem = allCases.find(c => c.id === caseId);
        const datasetId = caseItem?.datasetId;

        if (!sessionId || !datasetId) {
            setCaseStates(prev => {
                const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'fail' as CaseStatus, output: '缺少执行记录或数据集，无法评测（需先执行）' } };
                persistCaseStateUpdate(next);
                return next;
            });
            return;
        }

        // Clear any previous eval poll
        if (evalPollIntervalsRef.current[caseId]) {
            clearInterval(evalPollIntervalsRef.current[caseId]);
            delete evalPollIntervalsRef.current[caseId];
        }

        setCaseStates(prev => {
            const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'evaluating' as CaseStatus } };
            persistCaseStateUpdate(next);
            return next;
        });

        let evaluatorRunId: string;
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    datasetId,
                    pairs: [{ caseId, taskId: sessionId }],
                    evaluator: selectedEvaluatorId,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.evaluatorRunId) {
                setCaseStates(prev => {
                    const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'fail' as CaseStatus, output: data.error || '评测提交失败' } };
                    persistCaseStateUpdate(next);
                    return next;
                });
                return;
            }
            evaluatorRunId = data.evaluatorRunId;
        } catch (err) {
            setCaseStates(prev => {
                const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'fail' as CaseStatus, output: String(err) } };
                persistCaseStateUpdate(next);
                return next;
            });
            return;
        }

        // Persist evaluatorRunId so polling can be resumed after a page refresh
        setCaseStates(prev => {
            const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'evaluating' as CaseStatus, evaluatorRunId } };
            persistCaseStateUpdate(next);
            return next;
        });

        // Poll eval results every 5 s
        const pollEval = async () => {
            try {
                const res = await apiFetch(
                    `/api/eval/trajectory/results?user=${encodeURIComponent(user || '')}&runId=${encodeURIComponent(evaluatorRunId)}`
                );
                const data = await res.json();
                const results: any[] = data.results || [];
                const result = results.find((r: any) => r.caseId === caseId);
                if (!result) return;

                if (result.status === 'done') {
                    clearInterval(evalPollIntervalsRef.current[caseId]);
                    delete evalPollIntervalsRef.current[caseId];
                    const raw = result.trajectoryScore ?? 0;
                    const score = Math.round(raw * 100);
                    const pass = score >= 60;
                    setCaseStates(prev => {
                        const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: (pass ? 'pass' : 'fail') as CaseStatus, score } };
                        persistCaseStateUpdate(next);
                        return next;
                    });
                    router.push(`/eval/trajectory/${encodeURIComponent(sessionId)}`);
                } else if (result.status === 'failed') {
                    clearInterval(evalPollIntervalsRef.current[caseId]);
                    delete evalPollIntervalsRef.current[caseId];
                    setCaseStates(prev => {
                        const next = { ...prev, [caseId]: { ...(prev[caseId] || {}), status: 'fail' as CaseStatus, output: result.errorMessage || '轨迹评测失败' } };
                        persistCaseStateUpdate(next);
                        return next;
                    });
                }
            } catch {
                // network hiccup — keep polling
            }
        };

        await pollEval();
        evalPollIntervalsRef.current[caseId] = setInterval(pollEval, 5_000);
    };

    // Bulk actions
    const bulkExecute = async () => {
        const toRun = selectedCaseIds.filter(id => {
            const s = caseStates[id]?.status;
            return !s || s === 'pending';
        });
        await Promise.all(toRun.map(executeCase));
    };

    const bulkEvaluate = async () => {
        const toEval = selectedCaseIds.filter(id => caseStates[id]?.status === 'executed');
        await Promise.all(toEval.map(evaluateCase));
    };

    // Evaluate a single trace record (trace mode)
    const evaluateTrace = async (record: TraceRecord) => {
        const taskId = record.task_id;
        if (!taskId) return;
        // Save current task config before triggering evaluation
        if (currentTaskRef.current) {
            persistTaskUpdate(currentTaskRef.current.id, currentConfigRef.current, undefined);
        }
        const key = record.upload_id || taskId;

        // Mark as evaluating and persist immediately so a refresh shows correct state
        setTraceEvalStates(prev => {
            const next = { ...prev, [key]: { status: 'evaluating' as const, taskId } };
            persistTraceEvalUpdate(next);
            return next;
        });

        let evaluatorRunId: string;
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'debug-user',
                    datasetId: traceDatasetId,
                    taskIds: [taskId],
                    evaluator: selectedEvaluatorId,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.evaluatorRunId) {
                setTraceEvalStates(prev => {
                    const next = { ...prev, [key]: { status: 'fail' as const, taskId } };
                    persistTraceEvalUpdate(next);
                    return next;
                });
                return;
            }
            evaluatorRunId = data.evaluatorRunId;
        } catch {
            setTraceEvalStates(prev => {
                const next = { ...prev, [key]: { status: 'fail' as const, taskId } };
                persistTraceEvalUpdate(next);
                return next;
            });
            return;
        }

        // Persist evaluatorRunId so polling can be resumed after a page refresh
        setTraceEvalStates(prev => {
            const next = { ...prev, [key]: { status: 'evaluating' as const, evaluatorRunId, taskId } };
            persistTraceEvalUpdate(next);
            return next;
        });

        const pollEval = async () => {
            try {
                const res = await apiFetch(
                    `/api/eval/trajectory/results?user=${encodeURIComponent(user || '')}&runId=${encodeURIComponent(evaluatorRunId)}`
                );
                const data = await res.json();
                const results: any[] = data.results || [];
                const result = results.find((r: any) => r.taskId === taskId);
                if (!result) return;
                if (result.status === 'done') {
                    clearInterval(evalPollIntervalsRef.current[`tr_${key}`]);
                    delete evalPollIntervalsRef.current[`tr_${key}`];
                    const score = Math.round((result.trajectoryScore ?? 0) * 100);
                    setTraceEvalStates(prev => {
                        const next = { ...prev, [key]: { status: 'done' as const, score, evaluatorRunId, taskId } };
                        persistTraceEvalUpdate(next);
                        return next;
                    });
                    router.push(`/eval/trajectory/${encodeURIComponent(taskId)}`);
                } else if (result.status === 'failed') {
                    clearInterval(evalPollIntervalsRef.current[`tr_${key}`]);
                    delete evalPollIntervalsRef.current[`tr_${key}`];
                    setTraceEvalStates(prev => {
                        const next = { ...prev, [key]: { status: 'fail' as const, taskId } };
                        persistTraceEvalUpdate(next);
                        return next;
                    });
                }
            } catch { /* keep polling */ }
        };
        await pollEval();
        evalPollIntervalsRef.current[`tr_${key}`] = setInterval(pollEval, 5_000);
    };

    const bulkEvaluateTraces = async () => {
        const toEval = selectedTraceIds
            .map(id => traceRecords.find(r => (r.upload_id || r.task_id) === id))
            .filter((r): r is TraceRecord => !!r && !traceEvalStates[(r.upload_id || r.task_id)!]?.status.match(/evaluating|done/));
        await Promise.all(toEval.map(evaluateTrace));
    };

    // Select all
    const allSelected = filteredCases.length > 0 && filteredCases.every(c => selectedCaseIds.includes(c.id));
    const toggleSelectAll = () => {
        if (allSelected) setSelectedCaseIds(prev => prev.filter(id => !filteredCases.find(c => c.id === id)));
        else setSelectedCaseIds(prev => [...new Set([...prev, ...filteredCases.map(c => c.id)])]);
    };
    const toggleSelectCase = (id: string) => {
        setSelectedCaseIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };

    const getStatusLabel = (status: CaseStatus) => {
        const m: Record<CaseStatus, string> = {
            pending: locale === 'zh' ? '○ 未执行' : '○ Pending',
            running: locale === 'zh' ? '⌛ 执行中' : '⌛ Running',
            executed: locale === 'zh' ? '● 待评测' : '● Executed',
            evaluating: locale === 'zh' ? '◷ 评测中' : '◷ Evaluating',
            pass: locale === 'zh' ? '✓ 已评测' : '✓ Evaluated',
            fail: locale === 'zh' ? '✗ 失败' : '✗ Failed',
        };
        return m[status];
    };

    const taskConfirmed = !!currentTask && !isEditingTask;

    // ──── 三段式 section 的 summary 行：折叠态下用一行简单字串表达「当前在哪个阶段、关键数 / 状态是什么」
    // 跟触发分析页的 ConfigSummary / ExecSummary / ResultSummary 同思路，避免过度嵌套组件。
    const datasetSummary = sourceMode === 'trace'
        ? (skills.find(s => s.id === traceSkillId)?.name || '未选 Skill')
        : (selectedDatasetIds.length === 0
            ? '未选数据集'
            : selectedDatasetIds.length === 1
                ? (datasets.find(d => d.id === selectedDatasetIds[0])?.name || '未选数据集')
                : `${selectedDatasetIds.length} 个数据集`);
    const evaluatorName = [...BUILT_IN_EVALUATORS, ...userEvaluators].find(e => e.id === selectedEvaluatorId)?.name || selectedEvaluatorId;
    const totalCount = sourceMode === 'trace' ? traceRecords.length : allCases.length;

    // ② 执行块 summary：已执行/已评测/通过率
    const passRatePct = evaluatedCount > 0 ? Math.round((passCount / evaluatedCount) * 100) : 0;

    // ③ 结果块 summary + Hero 数据
    const evaluatedCaseStates = allCases
        .map(c => caseStates[c.id])
        .filter((s): s is CaseState => s != null && (s.status === 'pass' || s.status === 'fail'));
    const scoredStates = evaluatedCaseStates.filter(s => typeof s.score === 'number');
    const avgScore = scoredStates.length > 0
        ? Math.round(scoredStates.reduce((sum, s) => sum + (s.score || 0), 0) / scoredStates.length)
        : null;
    const scoreColorKlass: 'good' | 'warn' | 'bad' = avgScore == null
        ? 'warn'
        : avgScore >= 80 ? 'good' : avgScore >= 60 ? 'warn' : 'bad';

    return (
        <>
            {/* ─────────── ① 配置 · 评测任务 ─────────── */}
            <SectionShell
                num={1}
                variant="config"
                title="配置 · 用例集 + 任务参数"
                desc="任务管理 + 数据集 / Skill / 评测器 + 全部用例列表（含未执行 / 已评测）"
                open={configSecOpen}
                onToggle={() => setConfigSecOpen(o => !o)}
                summary={
                    <>
                        <span>当前任务</span>
                        <code>{currentTask?.taskName || '未保存'}</code>
                        <span>· <code>{datasetSummary}</code></span>
                        <span>· skill <code>{selectedSkill?.name || '未选'}{selectedVersion ? ` ${selectedVersion.semanticVersion || `v${selectedVersion.version}`}` : ''}</code></span>
                        <span>· 共 <b>{totalCount}</b> 用例</span>
                    </>
                }
            >
            {topConfigSlot}
            {/* Task Strip */}
            <div className="task-strip">
                <div className="task-strip-top">
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="task-strip-eyebrow">{locale === 'zh' ? '当前评测任务' : 'CURRENT EVAL TASK'}</div>
                        {isEditingTask ? (
                            <div className="task-inline-edit" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <input
                                        className="task-inline-input"
                                        value={taskNameInput}
                                        onChange={e => setTaskNameInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSaveTask(); if (e.key === 'Escape' && currentTask) { setIsEditingTask(false); setTaskNameInput(''); } }}
                                        placeholder={locale === 'zh' ? '请输入评测名称…' : 'Enter task name…'}
                                        autoFocus
                                    />
                                    <button className="d-btn sm primary" onClick={handleSaveTask} disabled={!taskNameInput.trim() || isCreatingTask}>
                                        {isCreatingTask ? (locale === 'zh' ? '保存中…' : 'Saving…') : (locale === 'zh' ? '保存' : 'Save')}
                                    </button>
                                    {currentTask && (
                                        <button className="d-btn sm" onClick={() => { setIsEditingTask(false); setTaskNameInput(''); }}>
                                            {locale === 'zh' ? '取消' : 'Cancel'}
                                        </button>
                                    )}
                                </div>
                                <input
                                    className="task-inline-input"
                                    style={{ fontSize: 12, fontWeight: 400 }}
                                    value={taskDescInput}
                                    onChange={e => setTaskDescInput(e.target.value)}
                                    placeholder={locale === 'zh' ? '任务描述（可选）…' : 'Task description (optional)…'}
                                />
                            </div>
                        ) : (
                            <div>
                                <div className="task-strip-title">
                                    {currentTask?.taskName}
                                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ink-3)' }}>
                                        {currentTask && new Date(currentTask.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                {isEditingDesc ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                                        <input
                                            className="task-inline-input"
                                            style={{ fontSize: 12, fontWeight: 400 }}
                                            value={taskDescInput}
                                            onChange={e => setTaskDescInput(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSaveDesc(); if (e.key === 'Escape') { setIsEditingDesc(false); setTaskDescInput(currentTask?.configJson?.taskDescription || ''); } }}
                                            placeholder={locale === 'zh' ? '描述这个评测任务的目标…' : 'Describe the goal of this task…'}
                                            autoFocus
                                        />
                                        <button className="d-btn sm primary" onClick={handleSaveDesc}>{locale === 'zh' ? '确定' : 'OK'}</button>
                                        <button className="d-btn sm" onClick={() => { setIsEditingDesc(false); setTaskDescInput(currentTask?.configJson?.taskDescription || ''); }}>{locale === 'zh' ? '取消' : 'Cancel'}</button>
                                    </div>
                                ) : taskDescInput ? (
                                    <div className="task-strip-desc" onClick={() => setIsEditingDesc(true)} style={{ cursor: 'text' }}>{taskDescInput}</div>
                                ) : currentTask && (
                                    <div className="task-strip-desc task-strip-desc-placeholder" onClick={() => setIsEditingDesc(true)}>
                                        {locale === 'zh' ? '+ 添加任务描述' : '+ Add description'}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        className="d-btn sm"
                        onClick={() => setShowHistoryDrawer(true)}
                        title={locale === 'zh' ? '查看历史评测任务' : 'View history'}
                    >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                            <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
                            <path d="M5.5 3v2.5l1.8 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        {locale === 'zh' ? '历史任务' : 'History'}
                    </button>
                    <button className="d-btn sm primary" onClick={handleNewTask}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        {locale === 'zh' ? '新建评测' : 'New Task'}
                    </button>
                </div>
            </div>

            {/* Config Bar */}
            <div className={`config-bar ${!taskConfirmed ? 'config-bar-locked' : ''}`}>
                {!taskConfirmed && (
                    <div className="config-bar-lock-tip" style={{ cursor: 'default' }}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <rect x="2" y="5" width="8" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.2"/>
                            <path d="M4 5V3.5a2 2 0 114 0V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                        </svg>
                        {locale === 'zh' ? (isEditingTask ? '请先保存评测名称' : '请先新建评测任务') : (isEditingTask ? 'Save task name first' : 'Create a task first')}
                    </div>
                )}
                <div className="config-bar-filters">
                {/* 「用例来源」chip 已删——外层（用例分析页 ① 配置块）已有 source-mode toggle 控制 dataset/trace
                    选择，BE 再有一个是重复。BE 内部 sourceMode state 仍保留，默认 'dataset'，因为
                    BE 现在只在外层 dataset 模式下被嵌入；trace 模式走 TraceDeviationPanel 自己的流程。 */}

                {/* Dataset mode filters */}
                {sourceMode === 'dataset' && (<>
                    <div className="config-bar-section">
                        <span className="config-bar-label">{locale === 'zh' ? '数据集' : 'Dataset'}</span>
                        {selectedDatasetIds.map(id => {
                            const ds = datasets.find(d => d.id === id);
                            if (!ds) return null;
                            return (
                                <div key={id} className="config-chip filled" role="button" tabIndex={0} onClick={() => taskConfirmed && setShowDatasetModal(true)}>
                                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                        <ellipse cx="5.5" cy="2.5" rx="3.5" ry="1.5" stroke="currentColor" strokeWidth="1.2"/>
                                        <path d="M2 2.5v6c0 .8 1.6 1.5 3.5 1.5s3.5-.7 3.5-1.5v-6" stroke="currentColor" strokeWidth="1.2"/>
                                    </svg>
                                    <span>{ds.name}</span>
                                    <span className="config-chip-meta">{ds.cases?.length || 0} {locale === 'zh' ? '条' : 'cases'}</span>
                                    <button
                                        className="config-chip-remove"
                                        onClick={e => { e.stopPropagation(); setSelectedDatasetIds(prev => prev.filter(i => i !== id)); }}
                                    >×</button>
                                </div>
                            );
                        })}
                        {selectedDatasetIds.length === 0 && (
                            <button
                                className={`config-chip add ${!taskConfirmed ? 'config-chip-disabled' : ''}`}
                                onClick={() => taskConfirmed ? setShowDatasetModal(true) : undefined}
                            >
                                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                    <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                </svg>
                                {locale === 'zh' ? '添加数据集' : 'Add Dataset'}
                            </button>
                        )}
                    </div>

                    <div className="config-bar-divider" />

                    <div className="config-bar-section">
                        <span className="config-bar-label">Skill</span>
                        {selectedSkill ? (
                            <button className="config-chip filled" onClick={() => taskConfirmed && setShowSkillModal(true)}>
                                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                    <rect x="1.5" y="6" width="2" height="4" stroke="currentColor" strokeWidth="1.2"/>
                                    <rect x="4.5" y="4" width="2" height="6" stroke="currentColor" strokeWidth="1.2"/>
                                    <rect x="7.5" y="2" width="2" height="8" stroke="currentColor" strokeWidth="1.2"/>
                                </svg>
                                <span>{selectedSkill.name}</span>
                                <span className="config-chip-meta">{selectedVersion?.semanticVersion || `v${selectedVersion?.version || '?'}`}</span>
                            </button>
                        ) : (
                            <button
                                className={`config-chip add ${!taskConfirmed ? 'config-chip-disabled' : ''}`}
                                onClick={() => taskConfirmed ? setShowSkillModal(true) : undefined}
                            >
                                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                    <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                </svg>
                                {locale === 'zh' ? '选择 Skill & 版本' : 'Select Skill & Version'}
                            </button>
                        )}
                    </div>

                    <div className="config-bar-divider" />
                </>)}

                {/* Trace mode filters */}
                {sourceMode === 'trace' && (<>
                    <div className="config-bar-section">
                        <span className="config-bar-label">Skill</span>
                        {traceSkillId ? (
                            <div className="config-chip filled" role="button" tabIndex={0} onClick={() => taskConfirmed && setShowTraceSkillModal(true)}>
                                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                    <rect x="1.5" y="6" width="2" height="4" stroke="currentColor" strokeWidth="1.2"/>
                                    <rect x="4.5" y="4" width="2" height="6" stroke="currentColor" strokeWidth="1.2"/>
                                    <rect x="7.5" y="2" width="2" height="8" stroke="currentColor" strokeWidth="1.2"/>
                                </svg>
                                <span>{skills.find(s => s.id === traceSkillId)?.name}</span>
                                <button className="config-chip-remove" onClick={e => { e.stopPropagation(); setTraceSkillId(''); }}>×</button>
                            </div>
                        ) : (
                            <button
                                className={`config-chip add ${!taskConfirmed ? 'config-chip-disabled' : ''}`}
                                onClick={() => taskConfirmed ? setShowTraceSkillModal(true) : undefined}
                            >
                                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                    <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                </svg>
                                {locale === 'zh' ? '选择 Skill' : 'Select Skill'}
                            </button>
                        )}
                    </div>

                    <div className="config-bar-divider" />
                </>)}

                {/* Evaluator (shared between both modes) */}
                <div className="config-bar-section" style={{ position: 'relative' }}>
                    <span className="config-bar-label">{locale === 'zh' ? '评估器' : 'Evaluator'}</span>
                    <button
                        ref={evalChipRef}
                        className={`config-chip filled ${!taskConfirmed ? 'config-chip-disabled' : ''}`}
                        onClick={() => {
                            if (!taskConfirmed) return;
                            const rect = evalChipRef.current?.getBoundingClientRect();
                            if (rect) setEvalDropdownPos({ top: rect.bottom + 6, left: rect.left });
                            setShowEvalDropdown(v => !v);
                        }}
                    >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                            <path d="M1.5 5L4 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span>{[...BUILT_IN_EVALUATORS, ...userEvaluators].find(e => e.id === selectedEvaluatorId)?.name || (selectedEvaluatorId === 'trace-quality-evaluator' ? '轨迹质量评估器（旧版）' : selectedEvaluatorId)}</span>
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                            <path d="M1 2.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                        </svg>
                    </button>
                    {showEvalDropdown && (
                        <>
                            <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setShowEvalDropdown(false)} />
                            <div className="task-history-dropdown" style={{ minWidth: 200, position: 'fixed', top: evalDropdownPos.top, left: evalDropdownPos.left, right: 'auto' }}>
                                {[...BUILT_IN_EVALUATORS, ...userEvaluators].map(ev => (
                                    <div
                                        key={ev.id}
                                        className={`task-history-item ${selectedEvaluatorId === ev.id ? 'active' : ''}`}
                                        onClick={() => { setSelectedEvaluatorId(ev.id); setShowEvalDropdown(false); }}
                                    >
                                        <span className="task-history-name">{ev.name}</span>
                                    </div>
                                ))}
                                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 4, marginTop: 4 }}>
                                    <div
                                        className="task-history-item"
                                        onClick={() => { setShowEvalDropdown(false); router.push('/metrics'); }}
                                        style={{ color: 'var(--accent)' }}
                                    >
                                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginRight: 4 }}>
                                            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                                        </svg>
                                        {locale === 'zh' ? '创建评估器' : 'Create Evaluator'}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                </div>{/* /config-bar-filters */}
                <div className="config-bar-summary">
                    <span className="config-bar-summary-num">{sourceMode === 'trace' ? traceRecords.length : allCases.length}</span>
                    <span className="config-bar-summary-label">{locale === 'zh' ? '总用例' : 'Cases'}</span>
                </div>
            </div>

            {/* Work Table Card —— 全部用例列表（含未执行 / 运行中 / 已评测）。
                与 trace 模式架构对齐：case 列表归入 ① 配置块，方便用户先确认要评的范围。 */}
            <div className="work-table-card">
                {/* Toolbar */}
                <div className="table-toolbar">
                    <div className="table-toolbar-left">
                        {sourceMode === 'dataset' ? (
                            <label className="select-all-checkbox">
                                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                                <span className="checkbox-mark"></span>
                            </label>
                        ) : (
                            <label className="select-all-checkbox">
                                <input
                                    type="checkbox"
                                    checked={selectedTraceIds.length === traceRecords.length && traceRecords.length > 0}
                                    onChange={() => {
                                        const allIds = traceRecords.map(r => r.upload_id || r.task_id || '').filter(Boolean);
                                        setSelectedTraceIds(prev => prev.length === allIds.length ? [] : allIds);
                                    }}
                                />
                                <span className="checkbox-mark"></span>
                            </label>
                        )}
                        <span className="toolbar-status">
                            {sourceMode === 'dataset'
                                ? (selectedCaseIds.length > 0
                                    ? (locale === 'zh' ? `已选 ${selectedCaseIds.length} 条` : `${selectedCaseIds.length} selected`)
                                    : (locale === 'zh' ? `共 ${allCases.length} 条用例` : `${allCases.length} cases`))
                                : (selectedTraceIds.length > 0
                                    ? (locale === 'zh' ? `已选 ${selectedTraceIds.length} 条` : `${selectedTraceIds.length} selected`)
                                    : (locale === 'zh' ? `共 ${traceRecords.length} 条执行链路` : `${traceRecords.length} traces`))
                            }
                        </span>
                        {sourceMode === 'dataset' && selectedCaseIds.length > 0 && (
                            <div className="bulk-actions">
                                <div className="bulk-divider" />
                                <button className="d-btn sm dark" onClick={bulkExecute}>
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                        <path d="M2.5 1.5l5.5 3.5-5.5 3.5V1.5z" fill="currentColor"/>
                                    </svg>
                                    {locale === 'zh' ? '批量执行' : 'Batch Execute'}
                                </button>
                                <button className="d-btn sm" onClick={bulkEvaluate}>
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                        <path d="M1.5 5L4 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                    {locale === 'zh' ? '批量评测' : 'Batch Evaluate'}
                                </button>
                            </div>
                        )}
                        {sourceMode === 'trace' && selectedTraceIds.length > 0 && (
                            <div className="bulk-actions">
                                <div className="bulk-divider" />
                                <button
                                    className="d-btn sm dark"
                                    onClick={bulkEvaluateTraces}
                                >
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                        <path d="M1.5 5L4 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                    {locale === 'zh' ? '批量评测' : 'Batch Evaluate'}
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="table-toolbar-right">
                        {sourceMode === 'dataset' && (
                            <div className="filter-group">
                                <button className={`filter-btn ${filterStatus === 'all' ? 'active' : ''}`} onClick={() => setFilterStatus('all')}>
                                    {locale === 'zh' ? '全部' : 'All'} <span className="filter-count">{allCases.length}</span>
                                </button>
                                <button className={`filter-btn ${filterStatus === 'pending' ? 'active' : ''}`} onClick={() => setFilterStatus('pending')}>
                                    {locale === 'zh' ? '未执行' : 'Pending'} <span className="filter-count">{pendingCount}</span>
                                </button>
                                <button className={`filter-btn ${filterStatus === 'executed' ? 'active' : ''}`} onClick={() => setFilterStatus('executed')}>
                                    {locale === 'zh' ? '待评测' : 'Executed'} <span className="filter-count">{executedCount}</span>
                                </button>
                                <button className={`filter-btn ${filterStatus === 'evaluated' ? 'active' : ''}`} onClick={() => setFilterStatus('evaluated')}>
                                    {locale === 'zh' ? '已评测' : 'Evaluated'} <span className="filter-count">{evaluatedCount}</span>
                                </button>
                                {failedCount > 0 && (
                                    <button className={`filter-btn ${filterStatus === 'failed' ? 'active' : ''}`} onClick={() => setFilterStatus('failed')}>
                                        {locale === 'zh' ? '失败' : 'Failed'}
                                        <span className="filter-count" style={{ color: filterStatus === 'failed' ? undefined : 'var(--danger)' }}>{failedCount}</span>
                                    </button>
                                )}
                            </div>
                        )}
                        <input
                            className="table-search"
                            placeholder={locale === 'zh' ? '搜索用例…' : 'Search cases…'}
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                    </div>
                </div>

                {/* Table */}
                <div className="work-table-wrapper">
                    <table className="work-table">
                        <thead>
                            <tr>
                                <th style={{ width: 36, paddingRight: 0 }}></th>
                                <th style={{ width: 44 }}>#</th>
                                <th>{locale === 'zh' ? (sourceMode === 'trace' ? '用户输入 / Trace' : '测试用例') : (sourceMode === 'trace' ? 'Input / Trace' : 'Test Case')}</th>
                                <th style={{ width: 110 }}>{locale === 'zh' ? (sourceMode === 'trace' ? '来源 Skill' : '数据集') : (sourceMode === 'trace' ? 'Skill' : 'Dataset')}</th>
                                {sourceMode === 'dataset' && <th style={{ width: 100 }}>{locale === 'zh' ? '状态' : 'Status'}</th>}
                                {sourceMode === 'dataset' && <th style={{ width: 150 }}>{locale === 'zh' ? '执行' : 'Execute'}</th>}
                                {sourceMode === 'trace' && <th style={{ width: 100 }}>{locale === 'zh' ? '执行结果' : 'Result'}</th>}
                                <th style={{ width: 110 }}>{locale === 'zh' ? '评测' : 'Evaluate'}</th>
                                {sourceMode === 'trace' && <th style={{ width: 70 }}>{locale === 'zh' ? '耗时' : 'Time'}</th>}
                                <th style={{ width: 50 }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {/* Trace mode rows */}
                            {sourceMode === 'trace' && (traceLoading ? (
                                <tr><td colSpan={7}><div className="d-empty"><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />{locale === 'zh' ? ' 加载中…' : ' Loading…'}</div></td></tr>
                            ) : traceRecords.length === 0 ? (
                                <tr><td colSpan={7}><div className="d-empty"><div className="d-empty-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><polyline points="17 9 13 9 10.5 15 7 3 4.5 9 1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg></div>{locale === 'zh' ? (traceSkillId ? '该 Skill 在所选时间内暂无执行链路' : '请在上方选择 Skill 以加载执行链路') : (traceSkillId ? 'No traces found for this Skill in the selected time range' : 'Select a Skill above to load its execution traces')}</div></td></tr>
                            ) : traceRecords.filter(r => !searchQuery || r.query?.toLowerCase().includes(searchQuery.toLowerCase())).map((record, idx) => {
                                const key = record.upload_id || record.task_id || `trace_${idx}`;
                                const evalState = traceEvalStates[key];
                                const isEvaluating = evalState?.status === 'evaluating';
                                const isDone = evalState?.status === 'done';
                                const isFail = evalState?.status === 'fail';
                                const skillNames: string[] = (() => {
                                    try { const s = typeof record.skills === 'string' ? JSON.parse(record.skills) : record.skills; return Array.isArray(s) ? s.map((x: any) => typeof x === 'string' ? x : x?.name || '').filter(Boolean) : []; } catch { return []; }
                                })();
                                return (
                                    <tr key={key}>
                                        <td style={{ paddingRight: 0 }}>
                                            <label className="row-checkbox">
                                                <input type="checkbox" checked={selectedTraceIds.includes(key)} onChange={() => setSelectedTraceIds(prev => prev.includes(key) ? prev.filter(i => i !== key) : [...prev, key])} />
                                                <span className="checkbox-mark"></span>
                                            </label>
                                        </td>
                                        <td className="num-col">{String(idx + 1).padStart(3, '0')}</td>
                                        <td style={{ overflow: 'hidden' }}>
                                            <div className="case-cell-title">
                                                <TruncatedText text={record.query || record.task_id || '-'} />
                                            </div>
                                            <div className="case-cell-meta">
                                                {record.task_id && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{record.task_id.slice(0, 16)}…</span>}
                                                {record.timestamp && <> · {new Date(Number(record.timestamp) || record.timestamp).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</>}
                                            </div>
                                        </td>
                                        <td>
                                            {skillNames.length > 0
                                                ? skillNames.map(n => <span key={n} className="tag tag-blue" style={{ fontSize: 10, marginRight: 2 }}>{n.slice(0, 12)}</span>)
                                                : <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>—</span>}
                                        </td>
                                        <td><span className="row-status executed">{locale === 'zh' ? '● 已完成' : '● Done'}</span></td>
                                        <td>
                                            {isDone ? (
                                                <button className="row-action-btn done" onClick={() => record.task_id && router.push(`/eval/trajectory/${encodeURIComponent(record.task_id)}`)}>
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 5h5.5M5.5 3l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                    {locale === 'zh' ? `结果 · ${evalState?.score ?? ''}` : `Result · ${evalState?.score ?? ''}`}
                                                </button>
                                            ) : isEvaluating ? (
                                                <button className="row-action-btn loading" disabled><span className="spinner" />{locale === 'zh' ? '评测中' : 'Eval…'}</button>
                                            ) : isFail ? (
                                                <button className="row-action-btn" style={{ color: 'var(--danger)' }} onClick={() => evaluateTrace(record)}>
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M8 4.5a3.5 3.5 0 11-3.5-3.5c.97 0 1.85.39 2.48 1.02L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M8 1.5v2H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                    {locale === 'zh' ? '重试' : 'Retry'}
                                                </button>
                                            ) : (
                                                <button
                                                    className="row-action-btn primary"
                                                    onClick={() => evaluateTrace(record)}
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5L4 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                    {locale === 'zh' ? '发起评测' : 'Evaluate'}
                                                </button>
                                            )}
                                        </td>
                                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-2)' }}>
                                            {record.timeCost || '—'}
                                        </td>
                                        <td>
                                            <button className="row-more" onClick={() => record.task_id && router.push(`/trace?taskId=${encodeURIComponent(record.task_id)}`)}>→</button>
                                        </td>
                                    </tr>
                                );
                            }))}
                            {/* Dataset mode rows */}
                            {sourceMode === 'dataset' && (filteredCases.length === 0 ? (
                                <tr>
                                    <td colSpan={8}>
                                        <div className="d-empty">
                                            <div className="d-empty-icon">
                                                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                                                    <path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                                </svg>
                                            </div>
                                            {allCases.length === 0
                                                ? (locale === 'zh' ? '请在上方配置栏选择数据集' : 'Select datasets in the config bar above')
                                                : (locale === 'zh' ? '无匹配用例' : 'No matching cases')
                                            }
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredCases.map((c, idx) => {
                                const state = caseStates[c.id];
                                const status: CaseStatus = state?.status || 'pending';
                                const isRunning = status === 'running';
                                const isEvaluating = status === 'evaluating';
                                const isPass = status === 'pass';
                                const isFail = status === 'fail';
                                const isExecuted = status === 'executed';
                                const isDone = isPass || isFail;
                                const canExecute = status === 'pending';
                                // allow re-execute from completed states, but not while running or evaluating
                                const canReExecute = isExecuted || isDone;
                                const canEvaluate = isExecuted;

                                return (
                                    <tr key={c.id} className={isFail ? 'row-fail' : ''}>
                                        <td style={{ paddingRight: 0 }}>
                                            <label className="row-checkbox">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedCaseIds.includes(c.id)}
                                                    onChange={() => toggleSelectCase(c.id)}
                                                />
                                                <span className="checkbox-mark"></span>
                                            </label>
                                        </td>
                                        <td className="num-col">{String(idx + 1).padStart(3, '0')}</td>
                                        <td style={{ overflow: 'hidden' }}>
                                            <div className="case-cell-title">
                                                <TruncatedText text={c.input || c.id} />
                                            </div>
                                            <div className="case-cell-meta">
                                                {c.isMock ? (locale === 'zh' ? '模拟用例' : 'Mock case') : `${c.datasetName}`}
                                                {state?.timeCost && ` · ${state.timeCost}`}
                                                {state?.tokenUsage && ` · ${state.tokenUsage} tok`}
                                            </div>
                                        </td>
                                        <td>
                                            <span className="tag tag-blue" style={{ fontSize: 10 }}>
                                                {c.datasetName?.slice(0, 8) || '-'}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`row-status ${status}`}>
                                                {getStatusLabel(isRunning ? 'running' : status)}
                                            </span>
                                        </td>
                                        <td>
                                            {isRunning ? (
                                                <button className="row-action-btn loading" disabled>
                                                    <span className="spinner" />
                                                    {locale === 'zh' ? '执行中' : 'Running'}
                                                </button>
                                            ) : canReExecute || isEvaluating ? (
                                                <div style={{ display: 'inline-flex', gap: 4 }}>
                                                    <button
                                                        className={`row-action-btn ${isEvaluating ? 'disabled' : ''}`}
                                                        disabled={isEvaluating}
                                                        title={isEvaluating ? (locale === 'zh' ? '评测进行中，无法重新执行' : 'Evaluation in progress') : undefined}
                                                        onClick={() => !isEvaluating && executeCase(c.id)}
                                                    >
                                                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                                                            <path d="M8 4.5a3.5 3.5 0 11-3.5-3.5c.97 0 1.85.39 2.48 1.02L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                                            <path d="M8 1.5v2H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                        {locale === 'zh' ? '重新执行' : 'Re-run'}
                                                    </button>
                                                    <button
                                                        className="row-action-btn done"
                                                        onClick={() => state?.sessionId && router.push(`/trace?taskId=${encodeURIComponent(state.sessionId)}`)}
                                                        disabled={!state?.sessionId}
                                                        title={state?.sessionId ? 'Trace' : (locale === 'zh' ? '暂无 Trace' : 'No trace yet')}
                                                    >
                                                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                            <path d="M1 5h5.5M5.5 3l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                        Trace
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    className={`row-action-btn ${canExecute ? 'primary' : 'disabled'}`}
                                                    disabled={!canExecute}
                                                    onClick={() => canExecute && executeCase(c.id)}
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                        <path d="M2.5 1.5l5.5 3.5-5.5 3.5V1.5z" fill="currentColor"/>
                                                    </svg>
                                                    {locale === 'zh' ? '执行' : 'Execute'}
                                                </button>
                                            )}
                                        </td>
                                        <td>
                                            {isEvaluating ? (
                                                <button className="row-action-btn loading" disabled>
                                                    <span className="spinner" />
                                                    {locale === 'zh' ? '评测中' : 'Eval…'}
                                                </button>
                                            ) : isPass ? (
                                                <button
                                                    className="row-action-btn done"
                                                    title={locale === 'zh' ? '查看评测结果' : 'View eval result'}
                                                    onClick={() => state?.sessionId && router.push(`/eval/trajectory/${encodeURIComponent(state.sessionId)}`)}
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                        <path d="M1 5h5.5M5.5 3l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                                    </svg>
                                                    {locale === 'zh' ? '评测结果' : 'Eval Result'}
                                                </button>
                                            ) : isFail && state?.sessionId ? (
                                                <div style={{ display: 'inline-flex', gap: 4 }}>
                                                    <button
                                                        className="row-action-btn"
                                                        style={{ color: 'var(--danger)' }}
                                                        title={locale === 'zh' ? `使用「${[...BUILT_IN_EVALUATORS, ...userEvaluators].find(e => e.id === selectedEvaluatorId)?.name || (selectedEvaluatorId === 'trace-quality-evaluator' ? '轨迹质量评估器（旧版）' : selectedEvaluatorId)}」重新评测` : `Re-evaluate with ${selectedEvaluatorId}`}
                                                        onClick={() => evaluateCase(c.id)}
                                                    >
                                                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                                                            <path d="M8 4.5a3.5 3.5 0 11-3.5-3.5c.97 0 1.85.39 2.48 1.02L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                                            <path d="M8 1.5v2H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                        {locale === 'zh' ? '重新评测' : 'Re-eval'}
                                                    </button>
                                                    {state?.score !== undefined && (
                                                        <button
                                                            className="row-action-btn done"
                                                            title={locale === 'zh' ? '查看评测结果' : 'View eval result'}
                                                            onClick={() => router.push(`/eval/trajectory/${encodeURIComponent(state.sessionId!)}`)}
                                                        >
                                                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                                <path d="M1 5h5.5M5.5 3l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                                            </svg>
                                                            {locale === 'zh' ? '结果' : 'Result'}
                                                        </button>
                                                    )}
                                                </div>
                                            ) : (
                                                <button
                                                    className={`row-action-btn ${canEvaluate ? 'primary' : 'disabled'}`}
                                                    disabled={!canEvaluate}
                                                    onClick={() => canEvaluate && evaluateCase(c.id)}
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                        <path d="M1.5 5L4 7.5 8.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                                    </svg>
                                                    {locale === 'zh' ? '评测' : 'Evaluate'}
                                                </button>
                                            )}
                                        </td>
                                        <td>
                                            <button className="row-more">⋯</button>
                                        </td>
                                    </tr>
                                );
                            }))}
                        </tbody>
                    </table>
                </div>

                {/* Table Footer */}
                <div className="table-footer">
                    <div className="table-footer-summary">
                        {sourceMode === 'trace' ? (
                            <>{locale === 'zh' ? '共' : 'Total'} <b>{traceRecords.length}</b> {locale === 'zh' ? '条执行链路' : 'traces'}</>
                        ) : (
                            <>{locale === 'zh' ? '共' : 'Total'} <b>{allCases.length}</b> {locale === 'zh' ? '条用例' : 'cases'}
                            {passCount > 0 && (
                                <span style={{ marginLeft: 10, color: 'var(--success)', fontWeight: 600 }}>
                                    {locale === 'zh' ? `通过 ${passCount}` : `Passed ${passCount}`}
                                </span>
                            )}
                            {failedCount > 0 && (
                                <span style={{ marginLeft: 8, color: 'var(--danger)', fontWeight: 600 }}>
                                    {locale === 'zh' ? `失败 ${failedCount}` : `Failed ${failedCount}`}
                                </span>
                            )}</>
                        )}
                    </div>
                    {sourceMode === 'dataset' && (
                        <div className="table-footer-progress">
                            <span className="progress-mini-label">
                                {locale === 'zh' ? `已评测 ${evaluatedCount} / ${allCases.length}` : `Evaluated ${evaluatedCount} / ${allCases.length}`}
                            </span>
                            <div className="progress-mini-bar">
                                <div className="progress-mini-fill" style={{ width: `${evalPct}%` }} />
                            </div>
                            <span className="progress-mini-pct">{evalPct}%</span>
                        </div>
                    )}
                    {sourceMode === 'trace' && (() => {
                        const doneCount = Object.values(traceEvalStates).filter(s => s.status === 'done').length;
                        const tracePct = traceRecords.length > 0 ? Math.round(doneCount / traceRecords.length * 100) : 0;
                        return (
                            <div className="table-footer-progress">
                                <span className="progress-mini-label">
                                    {locale === 'zh' ? `已评测 ${doneCount} / ${traceRecords.length}` : `Evaluated ${doneCount} / ${traceRecords.length}`}
                                </span>
                                <div className="progress-mini-bar">
                                    <div className="progress-mini-fill" style={{ width: `${tracePct}%` }} />
                                </div>
                                <span className="progress-mini-pct">{tracePct}%</span>
                            </div>
                        );
                    })()}
                </div>
            </div>
            </SectionShell>{/* /① 配置（已并入 case 表） */}

            {/* ─────────── ② 执行 · 跑评测（已评测 case 紧凑表，点行钻取 ③） ─────────── */}
            <SectionShell
                num={2}
                variant="exec"
                title="执行 · 跑评测"
                desc="只列已评测 case（结果状态 pass / fail）；点行钻取 ③ 看完整分析"
                open={execSecOpen}
                onToggle={() => setExecSecOpen(o => !o)}
                summary={
                    <>
                        <span>已评测</span>
                        <code>{evaluatedCount} / {allCases.length}</code>
                        {evaluatedCount > 0 && (
                            <span>· 通过率 <b style={{ color: passRatePct >= 80 ? 'var(--ev-success)' : passRatePct >= 60 ? 'var(--ev-warning)' : 'var(--ev-error)' }}>{passRatePct}%</b></span>
                        )}
                    </>
                }
            >
                {evaluatedCount === 0 ? (
                    <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--ev-muted)', fontSize: 13, background: '#fafafa', border: '1px dashed var(--ev-line)', borderRadius: 8 }}>
                        还没有 case 跑过评测。在 ① 配置块上方的 work-table 里点「批量执行」/「批量评测」。
                    </div>
                ) : (
                    <div style={{ border: '1px solid var(--ev-line)', borderRadius: 8, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                                <tr style={{ background: '#fafafa', borderBottom: '1px solid var(--ev-line)' }}>
                                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600 }}>Case · query</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 70 }}>评分</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 70 }}>结果</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 60 }}>查看</th>
                                </tr>
                            </thead>
                            <tbody>
                                {allCases.filter(c => {
                                    const s = caseStates[c.id]?.status;
                                    return s === 'pass' || s === 'fail';
                                }).map(c => {
                                    const st = caseStates[c.id];
                                    const score = st?.score ?? null;
                                    const isPass = st?.status === 'pass';
                                    const scoreColor = score == null ? 'var(--ev-muted)'
                                        : score >= 80 ? 'var(--ev-success)'
                                        : score >= 60 ? 'var(--ev-warning)'
                                        : 'var(--ev-error)';
                                    return (
                                        <tr
                                            key={c.id}
                                            onClick={() => {
                                                // 跳到 ③ 结果块；BatchResultBlock 内部依据 caseStates 拿到该 case
                                                setResultSecOpen(true);
                                                // 主动 scroll
                                                requestAnimationFrame(() => {
                                                    document.querySelector('[data-result-section]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                                });
                                            }}
                                            style={{ cursor: 'pointer', borderBottom: '1px solid #f4f4f5' }}
                                            title="点行回到 ③ 结果块查看 Hero + 分组 case 详情"
                                        >
                                            <td style={{ padding: '10px 12px', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {c.input || c.id}
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: scoreColor }}>
                                                {score ?? '—'}
                                            </td>
                                            <td style={{ padding: '10px 12px' }}>
                                                <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700, background: isPass ? 'var(--ev-success-soft)' : 'var(--ev-error-soft)', color: isPass ? 'var(--ev-success)' : 'var(--ev-error)' }}>
                                                    {isPass ? '✓ pass' : '✗ fail'}
                                                </span>
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--ev-info)', fontSize: 12 }}>↓</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </SectionShell>{/* /② 执行 */}

            {/* ─────────── ③ 结果 · 用例分析 ─────────── */}
            <SectionShell
                num={3}
                variant="result"
                title="结果 · 用例分析"
                desc={evaluatedCount > 0
                    ? `已评测 ${evaluatedCount} / ${allCases.length} 用例 · 当前任务 ${currentTask?.taskName || ''}`
                    : '尚未评测'}
                open={resultSecOpen}
                onToggle={() => setResultSecOpen(o => !o)}
                summary={
                    evaluatedCount > 0 && avgScore != null ? (
                        <>
                            <span>总评分</span>
                            <code className={`score-${scoreColorKlass}`}>{avgScore} 分</code>
                            <span>· 通过 <b>{passCount}</b> / <b>{evaluatedCount}</b></span>
                        </>
                    ) : (
                        <span style={{ color: 'var(--ev-muted)' }}>未评测</span>
                    )
                }
            >
                <BatchResultBlock
                    allCases={allCases}
                    caseStates={caseStates}
                    avgScore={avgScore}
                    scoreColorKlass={scoreColorKlass}
                    evaluatedCount={evaluatedCount}
                    passCount={passCount}
                    failedCount={failedCount}
                    pendingCount={pendingCount}
                    evaluatingCount={evaluatingCount}
                    onDrillTrace={sessionId => router.push(`/eval/trajectory/${sessionId}`)}
                />
            </SectionShell>{/* /③ 结果 */}

            {/* Dataset Modal */}
            {showDatasetModal && (
                <div className="d-modal-mask" onClick={() => setShowDatasetModal(false)}>
                    <div className="d-modal" onClick={e => e.stopPropagation()}>
                        <div className="d-modal-head">
                            <div className="d-modal-title">{locale === 'zh' ? '选择评测数据集' : 'Select Datasets'}</div>
                            <button className="d-modal-close" onClick={() => setShowDatasetModal(false)}>×</button>
                        </div>
                        <div className="d-modal-body">
                            {datasets.length === 0 ? (
                                <div className="d-empty">
                                    {locale === 'zh' ? '暂无数据集，请先创建' : 'No datasets found. Create one first.'}
                                </div>
                            ) : (
                                <div className="dataset-grid">
                                    {datasets.map(ds => (
                                        <div
                                            key={ds.id}
                                            className={`dataset-card ${selectedDatasetIds.includes(ds.id) ? 'selected' : ''}`}
                                            onClick={() => setSelectedDatasetIds(prev =>
                                                prev.includes(ds.id) ? prev.filter(i => i !== ds.id) : [...prev, ds.id]
                                            )}
                                        >
                                            <input type="checkbox" readOnly checked={selectedDatasetIds.includes(ds.id)} />
                                            <div className="dataset-card-body">
                                                <div className="dataset-name">{ds.name}</div>
                                                <div className="dataset-stats">
                                                    <b>{ds.cases?.length || 0}</b> {locale === 'zh' ? '条用例' : 'cases'}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="d-modal-foot">
                            <button className="d-btn sm" onClick={() => { setShowDatasetModal(false); router.push('/dataset'); }}>
                                + {locale === 'zh' ? '新建数据集' : 'New Dataset'}
                            </button>
                            <button className="d-btn sm primary" onClick={() => setShowDatasetModal(false)}>
                                {locale === 'zh' ? '确定' : 'Confirm'} ({selectedDatasetIds.length})
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Skill/Version Modal */}
            {showSkillModal && (
                <div className="d-modal-mask" onClick={() => setShowSkillModal(false)}>
                    <div className="d-modal" onClick={e => e.stopPropagation()}>
                        <div className="d-modal-head">
                            <div className="d-modal-title">{locale === 'zh' ? '选择 Skill 和版本' : 'Select Skill & Version'}</div>
                            <button className="d-modal-close" onClick={() => setShowSkillModal(false)}>×</button>
                        </div>
                        <div className="d-modal-body">
                            <div className="gray-field" style={{ marginBottom: 16 }}>
                                <div className="gray-field-label">Skill</div>
                                <select
                                    className="gray-select"
                                    value={selectedSkillId}
                                    onChange={e => setSelectedSkillId(e.target.value)}
                                >
                                    <option value="">{locale === 'zh' ? '-- 请选择 Skill --' : '-- Select Skill --'}</option>
                                    {skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                            {selectedSkillId && (
                                <div>
                                    <div className="gray-field-label" style={{ marginBottom: 10 }}>{locale === 'zh' ? '版本' : 'Version'}</div>
                                    {versions.map(v => (
                                        <div
                                            key={v.id}
                                            className={`skill-version-row ${selectedVersionId === v.id ? 'selected' : ''}`}
                                            onClick={() => setSelectedVersionId(v.id)}
                                        >
                                            <div className="skill-version-radio" />
                                            <div className="skill-version-info">
                                                <div className="skill-version-name">
                                                    {v.semanticVersion || `v${v.version}`}
                                                    {v.isCurrent && <span className="tag tag-green" style={{ fontSize: 9 }}>Current</span>}
                                                </div>
                                                <div className="skill-version-meta">version {v.version}</div>
                                            </div>
                                        </div>
                                    ))}
                                    {versions.length === 0 && (
                                        <div className="d-empty" style={{ padding: '20px 0' }}>
                                            {locale === 'zh' ? '暂无版本' : 'No versions found'}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="d-modal-foot">
                            <button className="d-btn sm" onClick={() => setShowSkillModal(false)}>
                                {locale === 'zh' ? '取消' : 'Cancel'}
                            </button>
                            <button className="d-btn sm primary" onClick={() => setShowSkillModal(false)}>
                                {locale === 'zh' ? '确定' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Trace Skill Modal */}
            {showTraceSkillModal && (
                <div className="d-modal-mask" onClick={() => setShowTraceSkillModal(false)}>
                    <div className="d-modal" onClick={e => e.stopPropagation()}>
                        <div className="d-modal-head">
                            <div className="d-modal-title">{locale === 'zh' ? '选择 Skill' : 'Select Skill'}</div>
                            <button className="d-modal-close" onClick={() => setShowTraceSkillModal(false)}>×</button>
                        </div>
                        <div className="d-modal-body">
                            {skills.length === 0 ? (
                                <div className="d-empty">{locale === 'zh' ? '暂无 Skill，请先创建' : 'No skills found. Create one first.'}</div>
                            ) : (
                                <div className="dataset-grid">
                                    {skills.map(s => (
                                        <div
                                            key={s.id}
                                            className={`dataset-card ${traceSkillId === s.id ? 'selected' : ''}`}
                                            onClick={() => setTraceSkillId(s.id)}
                                        >
                                            <input type="radio" readOnly checked={traceSkillId === s.id} />
                                            <div className="dataset-card-body">
                                                <div className="dataset-name">{s.name}</div>
                                                <div className="dataset-stats">{locale === 'zh' ? '点击选择后查看关联执行链路' : 'Select to view associated traces'}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="d-modal-foot">
                            <button className="d-btn sm" onClick={() => setShowTraceSkillModal(false)}>
                                {locale === 'zh' ? '取消' : 'Cancel'}
                            </button>
                            <button className="d-btn sm primary" onClick={() => setShowTraceSkillModal(false)} disabled={!traceSkillId}>
                                {locale === 'zh' ? '确定' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Trace Eval Dataset Modal */}
            {showTraceDatasetModal && (
                <div className="d-modal-mask" onClick={() => setShowTraceDatasetModal(false)}>
                    <div className="d-modal" onClick={e => e.stopPropagation()}>
                        <div className="d-modal-head">
                            <div className="d-modal-title">{locale === 'zh' ? '选择评测集（轨迹数据集）' : 'Select Eval Dataset (Trajectory)'}</div>
                            <button className="d-modal-close" onClick={() => setShowTraceDatasetModal(false)}>×</button>
                        </div>
                        <div className="d-modal-body">
                            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 12, padding: '8px 10px', background: 'var(--bg-soft)', borderRadius: 6 }}>
                                {locale === 'zh' ? '评测集用于提供参考答案和评测标准。评测时系统会将 trace 输入与数据集 case 自动匹配。' : 'The eval dataset provides reference answers. The system auto-matches trace inputs to dataset cases during evaluation.'}
                            </div>
                            {datasets.length === 0 ? (
                                <div className="d-empty">{locale === 'zh' ? '暂无数据集' : 'No datasets found'}</div>
                            ) : (
                                <div className="dataset-grid">
                                    {datasets.map(ds => (
                                        <div
                                            key={ds.id}
                                            className={`dataset-card ${traceDatasetId === ds.id ? 'selected' : ''}`}
                                            onClick={() => setTraceDatasetId(ds.id)}
                                        >
                                            <input type="radio" readOnly checked={traceDatasetId === ds.id} />
                                            <div className="dataset-card-body">
                                                <div className="dataset-name">{ds.name}</div>
                                                <div className="dataset-stats"><b>{ds.cases?.length || 0}</b> {locale === 'zh' ? '条用例' : 'cases'}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="d-modal-foot">
                            <button className="d-btn sm" onClick={() => setShowTraceDatasetModal(false)}>{locale === 'zh' ? '取消' : 'Cancel'}</button>
                            <button className="d-btn sm primary" onClick={() => setShowTraceDatasetModal(false)} disabled={!traceDatasetId}>{locale === 'zh' ? '确定' : 'Confirm'}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* History Drawer */}
            {showHistoryDrawer && (
                <>
                    <div className="d-drawer-mask" onClick={() => setShowHistoryDrawer(false)} />
                    <div className="d-history-drawer">
                        <div className="d-history-panel">
                            <div className="d-history-head">
                                <div className="d-history-head-title">
                                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                                        <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.4"/>
                                        <path d="M6.5 3.5v3l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                    {locale === 'zh' ? '历史任务' : 'Task History'}
                                    <span style={{ fontWeight: 400, color: 'var(--ink-4)', fontSize: 11 }}>
                                        {taskHistory.length}{locale === 'zh' ? ' 条' : ''}
                                    </span>
                                </div>
                                <button className="d-drawer-close" onClick={() => setShowHistoryDrawer(false)}>
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                    </svg>
                                </button>
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
        </>
    );
}

/* =========================================================================
   BatchResultBlock —— ③ 结果块内核：Hero（avg 分 + 4 mini 指标）+ FindingsGrouped
   （按 case 通过状态分三组：通过 / 未通过 / 待评测）。

   设计：
   - 主分 = 已评测 case 的 score 平均。每个 case 只有一个 score（不像静态合规
     有维度分），所以 Hero mini 不展示「结果分析 / 轨迹分析双分」——除非将来 caseStates
     存两个分数才能落地。
   - 通过 / 未通过 / 待评测三组，分别走 passed / failed / notEvaluated。
   - per-case 钻取：点 IssueCard 右下角的「查看完整 trace →」跳 /eval/trajectory/{sessionId}
     去看单条 case 的 ResultAnalysisSection + TrajectoryAnalysisSection。
   ========================================================================= */
function BatchResultBlock({
    allCases,
    caseStates,
    avgScore,
    scoreColorKlass,
    evaluatedCount,
    passCount,
    failedCount,
    pendingCount,
    evaluatingCount,
    onDrillTrace,
}: {
    allCases: any[];
    caseStates: Record<string, CaseState>;
    avgScore: number | null;
    scoreColorKlass: 'good' | 'warn' | 'bad';
    evaluatedCount: number;
    passCount: number;
    failedCount: number;
    pendingCount: number;
    evaluatingCount: number;
    onDrillTrace: (sessionId: string) => void;
}) {
    const total = allCases.length;
    const passRatePct = evaluatedCount > 0 ? Math.round((passCount / evaluatedCount) * 100) : 0;
    const passRateTone: 'good' | 'bad' | null = evaluatedCount === 0
        ? null
        : passRatePct >= 80 ? 'good' : passRatePct < 50 ? 'bad' : null;

    if (total === 0) {
        return (
            <div className="recall-empty">
                <b>还没选数据集或 trace。</b>
                <div style={{ marginTop: 6 }}>先去 <b>① 配置</b> 选数据源 / Skill / 评测器。</div>
            </div>
        );
    }

    if (evaluatedCount === 0) {
        return (
            <div className="recall-empty">
                <b>用例已就绪，但还未跑评测。</b>
                <div style={{ marginTop: 6 }}>到 <b>② 执行</b> 块点「批量执行」或「批量评测」开始；评测完成后这里显示聚合结果。</div>
            </div>
        );
    }

    // 把 caseStates 映射成 FindingItem。query 来自 case.input；evidence = 评分行；
    // reasoning = 输出片段（截断 200 字）；suggestion 不展示（evaluator 没提供）。
    const toItem = (c: any): FindingItem | null => {
        const st = caseStates[c.id];
        if (!st) return null;
        const sessionId = st.sessionId;
        const query: string = c.input || c.id;
        const evidenceParts: string[] = [];
        if (typeof st.score === 'number') {
            evidenceParts.push(`评分 ${st.score} 分`);
        }
        if (st.timeCost) evidenceParts.push(`耗时 ${st.timeCost}`);
        if (typeof st.tokenUsage === 'number' && st.tokenUsage > 0) {
            evidenceParts.push(`tokens ${st.tokenUsage}`);
        }
        const evidence = evidenceParts.length > 0 ? evidenceParts.join(' · ') : null;
        const output = st.output ? (st.output.length > 240 ? st.output.slice(0, 240) + '…' : st.output) : null;
        const isPass = st.status === 'pass';
        const isFail = st.status === 'fail';
        const isPending = !isPass && !isFail;
        if (isPending) {
            return {
                id: c.id,
                summary: query,
                severity: 'low',
                evidence: st.status === 'evaluating' ? '评测中…' : st.status === 'executed' ? '已执行，待评测' : st.status === 'running' ? '执行中…' : '待执行',
                reasoning: null,
                passed: false,
                dimension: sessionId ? `trace ${sessionId.slice(0, 8)}` : undefined,
            };
        }
        return {
            id: c.id,
            summary: query,
            severity: isPass ? 'low' : (st.score != null && st.score < 50 ? 'high' : 'medium'),
            evidence,
            reasoning: output,
            suggestedFix: isFail ? '点击「查看完整 trace」看 evaluator 详细反馈与 trajectory 错点' : null,
            passed: isPass,
            dimension: sessionId ? `trace ${sessionId.slice(0, 8)}` : undefined,
        };
    };

    const passedItems: FindingItem[] = allCases
        .filter(c => caseStates[c.id]?.status === 'pass')
        .map(toItem)
        .filter((i): i is FindingItem => i != null);
    const failedItems: FindingItem[] = allCases
        .filter(c => caseStates[c.id]?.status === 'fail')
        .map(toItem)
        .filter((i): i is FindingItem => i != null);
    const pendingItems: FindingItem[] = allCases
        .filter(c => {
            const s = caseStates[c.id]?.status;
            return !s || s === 'pending' || s === 'running' || s === 'executed' || s === 'evaluating';
        })
        .map(toItem)
        .filter((i): i is FindingItem => i != null);

    const groups: FindingGroup[] = [
        {
            key: 'failed',
            title: '未通过',
            desc: '评测结果不达标。点击「查看完整 trace」可看 evaluator 详细反馈。',
            status: failedItems.length === 0 ? 'passed' : 'failed',
            scoreLabel: `${failedItems.length} 个问题`,
            items: failedItems,
        },
        {
            key: 'passed',
            title: '通过',
            desc: '评测达标的 case。',
            status: 'passed',
            scoreLabel: `${passedItems.length} 通过`,
            items: passedItems,
        },
        {
            key: 'pending',
            title: '待评测',
            desc: '还没执行或还没经过 evaluator 打分的 case；在 ② 执行块批量推进。',
            status: 'notEvaluated',
            scoreLabel: `${pendingItems.length} 待评测`,
            items: pendingItems,
        },
    ];

    // 给 IssueCard 注入点击钻取行为：sessionId → /eval/trajectory/{sessionId}
    // FindingItem 本身不带 onClick，所以我们包一层 onClick 监听 hover/click，
    // 用 dimension 字段编码 sessionId（前缀「trace 」）。简单但有效；后续可以
    // 把 onClick 提到 FindingItem 类型上让 IssueCard 原生支持。
    const handleClickItem = (item: FindingItem) => {
        if (item.dimension?.startsWith('trace ')) {
            const sid = item.dimension.slice(6);
            // 找回完整 sessionId（slice 后是前 8 位，从 caseStates 反查）
            const full = Object.values(caseStates).find(s => s.sessionId?.startsWith(sid))?.sessionId;
            if (full) onDrillTrace(full);
        }
    };

    return (
        <div className="ev-content">
            {/* Hero —— 总评分 + 4 mini 指标 */}
            <div className="ev-hero">
                <div className="ev-hero-main">
                    <div className={`ev-hero-num ${scoreColorKlass}`}>
                        {avgScore ?? '--'}
                        <span className="ev-hero-unit">分</span>
                    </div>
                    <div className="ev-hero-label">
                        总评分 · 已评测 {evaluatedCount} / {total} 用例
                    </div>
                </div>
                <div className="ev-hero-sub">
                    <div className="ev-hero-sub-item">
                        <div className={`ev-hero-sub-num ${passRateTone ?? ''}`}>{passRatePct}%</div>
                        <div className="ev-hero-sub-label">通过率</div>
                        <div className="ev-hero-sub-hint">已评测中达标比例</div>
                    </div>
                    <div className="ev-hero-sub-item">
                        <div className={`ev-hero-sub-num ${failedCount > 0 ? 'bad' : ''}`}>{failedCount}</div>
                        <div className="ev-hero-sub-label">未通过</div>
                        <div className="ev-hero-sub-hint">需要重点关注</div>
                    </div>
                    <div className="ev-hero-sub-item">
                        <div className={`ev-hero-sub-num ${passCount > 0 ? 'good' : ''}`}>{passCount}</div>
                        <div className="ev-hero-sub-label">通过</div>
                        <div className="ev-hero-sub-hint">评测达标 case</div>
                    </div>
                    <div className="ev-hero-sub-item">
                        <div className="ev-hero-sub-num">{pendingCount + evaluatingCount}</div>
                        <div className="ev-hero-sub-label">待 / 评测中</div>
                        <div className="ev-hero-sub-hint">尚未给分 case</div>
                    </div>
                </div>
            </div>

            {/* FindingsGrouped —— 未通过 / 通过 / 待评测 三组 */}
            <div onClickCapture={e => {
                // 简单事件代理：点击 .ev-issue → 找父 article 的 case id → 钻取
                const target = (e.target as HTMLElement);
                const issue = target.closest('.ev-issue') as HTMLElement | null;
                if (!issue) return;
                // 从 issue.querySelector('.ev-issue-head b').textContent 反查 case query 太麻烦；
                // 改成更直接的方式：用 onClick on the item.dimension 编码。这里先不接管，让
                // IssueCard 自身的 hover 揭示足够，drill 通过下面的「查看 trace」link 走。
                void handleClickItem;
            }}>
                <FindingsGrouped
                    groups={groups}
                    title="分场景结果"
                    hint="未通过排在最上 · 通过 / 待评测 默认折叠"
                    emptyMessage="本任务没有用例"
                />
            </div>
        </div>
    );
}
