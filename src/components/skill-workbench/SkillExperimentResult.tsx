'use client';
import { DeleteExperimentButton } from '@/components/eval/DeleteExperimentButton';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

import { ExperimentDetail } from '@/components/eval/ExperimentDetail';
import { ExperimentRenameButton } from '@/components/eval/ExperimentRenameButton';
import { ExperimentCaseDetail } from '@/components/eval/ExperimentCaseDetail';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { apiFetch } from '@/lib/client/api';
import {
  buildAbComparison,
  formatWorkbenchScore as scoreText,
  isCompletedWorkbenchCase,
  summarizeAbSide,
  type AbCaseStates,
  type AbOutcome,
  type AbSideState,
  type AbSideSummary,
} from '@/lib/skill-workbench/ab-comparison';
import { SKILL_TRIGGER_ANALYZER_EVALUATOR_ID } from '@/lib/skill-workbench/trigger-evaluator';
import { describeExperimentOutcome } from '@/lib/skill-workbench/experiment-outcome';
import { executionModelMismatch } from '@/lib/skill-workbench/execution-model';
import {
  categoryAverage, evaluationScoreState, existingTraceCaseRun, existingTraceRetryResults,
  type CaseEvaluationResult,
} from '@/lib/skill-workbench/use-case-results';
import { resolveGrayscaleRetryMode } from '@/lib/grayscale/retry-policy';
import { SkillExperimentProgress, type SkillExperimentProgressProps } from './SkillExperimentProgress';

interface DetailPayload {
  id: string;
  name: string;
  createdAt: string;
  agentName: string;
  status: string;
  preset: 'trigger' | 'use-case' | 'skill-ab' | 'retest' | null;
  skillName: string;
  skillVersion: number | null;
  evaluatorIds: string[];
  overall: number | null;
  breakdown: Array<{ evaluatorId: string; avg: number | null; scored: number; total: number; failed: number }>;
  progress: { total: number; done: number; failed: number; pending: number };
  traceProgress: { total: number; ready: number; failed: number; pending: number } | null;
  executionProgress: { total: number; succeeded: number; failed: number; pending: number } | null;
  evaluationProgress: { total: number; succeeded: number; failed: number; pending: number; skipped?: number; unscored?: number } | null;
  sideProgress?: SkillExperimentProgressProps['sideProgress'];
  caseTotal: number;
  results?: CaseEvaluationResult[];
  cases?: Array<{
    id: string;
    taskId?: string | null;
    input?: string;
    actualOutput?: string;
    actualModel?: string | null;
    actualHost?: string | null;
    referenceOutput?: string | null;
    caseValues?: Record<string, unknown> | null;
    skillTriggered?: boolean | null;
  }>;
  configSnapshot?: Record<string, unknown> | null;
  skillContext?: Record<string, unknown> | null;
}

interface WorkbenchExperiment {
  id: string;
  configSnapshot?: Record<string, unknown>;
  grayscaleTask?: {
    id: string;
    caseStates?: AbCaseStates;
    config?: Record<string, unknown>;
  } | null;
}

interface DatasetPayload {
  id: string;
  name: string;
  cases?: Array<{
    id?: string;
    input?: string;
    expectedOutput?: string;
    values?: Record<string, unknown>;
  }>;
}

const PRESET_LABELS: Record<string, string> = {
  trigger: '触发分析',
  'use-case': '用例分析',
  'skill-ab': 'A/B 测试',
  retest: '候选复测',
};

const STATUS_LABELS: Record<string, string> = {
  draft: '运行中',
  running: '运行中',
  done: '实验完成',
  failed: '实验失败',
  cancelled: '已取消',
  partial: '部分完成',
};

const LEGACY_TRIGGER_EVALUATOR_IDS = new Set([
  'skill-trigger-accuracy',
  'preset-agent-task-completion',
  'preset-result-accuracy',
]);

function terminal(status?: string) {
  return ['pass', 'fail', 'done', 'failed'].includes(status || '');
}

function runIsActive(run: { status?: string; score?: number | null }) {
  return ['running', 'evaluating', 'pending'].includes(run.status || '')
    && !(typeof run.score === 'number' && Number.isFinite(run.score));
}

function sideRuns(side?: AbSideState) {
  return side?.runs?.length ? side.runs : side ? [side] : [];
}

function formatScore(score: number | null | undefined) {
  return typeof score === 'number' && Number.isFinite(score) ? `${score.toFixed(1)}` : '—';
}

function average(values: Array<number | null | undefined>) {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function seconds(value: string | undefined) {
  const parsed = Number.parseFloat(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value != null && typeof value !== 'object') return String(value);
  }
  return '';
}

function summaryScoreStatus(summary: AbSideSummary) {
  if (summary.evaluations.length > 0 && summary.evaluations.every(item => item.status === 'done') && summary.score == null) return 'unscored';
  return summary.status;
}

function activeAbPairLabel(a: AbSideSummary, b: AbSideSummary) {
  if (a.status === 'running' || b.status === 'running') return '执行中';
  if (a.status === 'pending' || b.status === 'pending') return '等待执行';
  return '评测中';
}

function ExpandableCellText({ value, muted = false }: { value: string; muted?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const text = value.trim() || '—';
  const expandable = text.length > 48 || text.includes('\n');
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expandable ? `${expanded ? '收起' : '展开'}单元格全文` : undefined}
      disabled={!expandable}
      onClick={() => setExpanded((current) => !current)}
      className={`w-full whitespace-pre-wrap break-words text-left leading-5 ${expanded ? '' : 'line-clamp-2'} ${muted ? 'text-foreground-secondary' : 'text-foreground'} ${expandable ? 'cursor-pointer hover:text-primary' : 'cursor-default'}`}
      title={expandable && !expanded ? '点击展开全文' : undefined}
    >
      {text}
    </button>
  );
}

function RunOutput({ run, output }: { run?: import('@/lib/skill-workbench/ab-comparison').AbRunState; output: string }) {
  const evaluationErrors = run?.evaluations?.filter(item => item.status === 'failed').map(item => item.errorMessage).filter(Boolean) || [];
  const unscored = run?.evaluations?.filter(item => item.unscored || (item.status === 'done' && item.score == null)) || [];
  return <>
    {run?.failureType
      ? <p className="whitespace-pre-wrap break-words text-error">执行失败{run.failureCode ? `（${run.failureCode}）` : ''}：{run.failureDetail || output || '未生成有效输出'}<br />未进入评测</p>
      : <ExpandableCellText value={output} muted />}
    {!run?.failureType && evaluationErrors.length > 0 && <p className="mt-1 whitespace-pre-wrap break-words text-error">评测失败：{evaluationErrors.join('；')}</p>}
    {!run?.failureType && unscored.length > 0 && <p className="mt-1 whitespace-pre-wrap break-words text-foreground-muted">未计分：{unscored.map(item => item.summary || '评估器未返回分数').join('；')}</p>}
  </>;
}

export function SkillExperimentResult({
  user,
  skillName,
  version,
  experimentId,
  onBack,
}: {
  user: string;
  skillName: string;
  version: number;
  experimentId: string;
  onBack: () => void;
}) {
  const evaluatorLookup = useEvaluatorLookup(user);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [workbenchExperiment, setWorkbenchExperiment] = useState<WorkbenchExperiment | null>(null);
  const [dataset, setDataset] = useState<DatasetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailVisibility, setDetailVisibility] = useState({ experimentId, expanded: true });
  const showDetail = detailVisibility.experimentId !== experimentId || detailVisibility.expanded;
  const [caseDetailId, setCaseDetailId] = useState<string | null>(null);
  const [abFilterState, setAbFilterState] = useState<{ experimentId: string; value: AbOutcome | 'all' }>({ experimentId, value: 'all' });
  const [retryingRunState, setRetryingRunState] = useState<{ experimentId: string; value: string }>({ experimentId, value: '' });
  const [retryErrorState, setRetryErrorState] = useState<{ experimentId: string; key: string; message: string }>({ experimentId, key: '', message: '' });
  const loadSequence = useRef(0);
  const retryInFlight = useRef(false);
  const abFilter = abFilterState.experimentId === experimentId ? abFilterState.value : 'all';
  const retryingRun = retryingRunState.experimentId === experimentId ? retryingRunState.value : '';
  const retryError = retryErrorState.experimentId === experimentId ? retryErrorState : { key: '', message: '' };
  const setAbFilter = useCallback(
    (value: AbOutcome | 'all') => setAbFilterState({ experimentId, value }),
    [experimentId],
  );
  const setRetryingRun = useCallback(
    (value: string) => setRetryingRunState({ experimentId, value }),
    [experimentId],
  );
  const setRetryError = useCallback(
    (key: string, message: string) => setRetryErrorState({ experimentId, key, message }),
    [experimentId],
  );

  const load = useCallback(async (silent = false) => {
    const sequence = ++loadSequence.current;
    if (!silent) setLoading(true);
    try {
      const [detailResponse, contextResponse] = await Promise.all([
        apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}?user=${encodeURIComponent(user)}&casePageSize=100`, { cache: 'no-store' }),
        apiFetch(`/api/skill-workbench/skills/${encodeURIComponent(skillName)}/experiments?user=${encodeURIComponent(user)}&version=${version}`, { cache: 'no-store' }),
      ]);
      const detailResult = await detailResponse.json();
      const contextResult = await contextResponse.json();
      if (!detailResponse.ok) throw new Error(detailResult.error || '加载实验失败');
      if (!contextResponse.ok) throw new Error(contextResult.error || '加载 Skill 实验上下文失败');
      const nextDetail = detailResult as DetailPayload;
      const nextWorkbench = (Array.isArray(contextResult.experiments) ? contextResult.experiments : [])
        .find((item: WorkbenchExperiment) => item.id === experimentId) || null;
      if (sequence !== loadSequence.current) return;
      setDetail(nextDetail);
      setWorkbenchExperiment(nextWorkbench);
      const snapshot = (nextWorkbench?.configSnapshot || nextDetail.configSnapshot || {}) as Record<string, unknown>;
      const datasetId = typeof snapshot.datasetId === 'string' ? snapshot.datasetId : '';
      if (!datasetId) setDataset(null);
      if (datasetId && dataset?.id !== datasetId) {
        const datasetResponse = await apiFetch(`/api/agent-datasets/${encodeURIComponent(datasetId)}?user=${encodeURIComponent(user)}&view=items`, { cache: 'no-store' });
        const datasetResult = await datasetResponse.json();
        if (datasetResponse.ok && sequence === loadSequence.current) setDataset(datasetResult as DatasetPayload);
      }
      if (sequence === loadSequence.current) setError('');
    } catch (loadError) {
      if (!silent && sequence === loadSequence.current) setError(loadError instanceof Error ? loadError.message : '加载实验失败');
    } finally {
      if (!silent && sequence === loadSequence.current) setLoading(false);
    }
  }, [dataset, experimentId, skillName, user, version]);

  useEffect(() => () => { loadSequence.current += 1; }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const caseStates = workbenchExperiment?.grayscaleTask?.caseStates || {};
    const hasUnfinishedRuns = (detail?.preset === 'skill-ab' || detail?.preset === 'use-case') && Object.values(caseStates).some((state) =>
      [...sideRuns(state.a), ...sideRuns(state.b)].some((run) => !terminal(run.status)),
    );
    if (!detail || (!['draft', 'running'].includes(detail.status) && !hasUnfinishedRuns)) return;
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load(true);
        if (!cancelled) schedule();
      }, 3000);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [detail, load, workbenchExperiment]);

  const states = useMemo(() => workbenchExperiment?.grayscaleTask?.caseStates || {}, [workbenchExperiment]);
  const hasActiveRuns = useMemo(() => Object.values(states).some((state) => (
    [...sideRuns(state.a), ...sideRuns(state.b)].some(runIsActive)
  )), [states]);
  const snapshot = useMemo(
    () => (workbenchExperiment?.configSnapshot || detail?.configSnapshot || {}) as Record<string, unknown>,
    [detail?.configSnapshot, workbenchExperiment?.configSnapshot],
  );
  const caseIds = useMemo(
    () => Object.keys(states).length
      ? (Array.isArray(snapshot.caseIds) ? snapshot.caseIds.map(String) : Object.keys(states))
      : (detail?.cases || []).map((item) => item.id),
    [detail?.cases, snapshot.caseIds, states],
  );
  const abComparison = useMemo(
    () => buildAbComparison(caseIds, states, detail?.evaluatorIds || []),
    [caseIds, detail?.evaluatorIds, states],
  );

  const abProgress = useMemo(() => {
    const aRuns = caseIds.flatMap((id) => sideRuns(states[id]?.a));
    const bRuns = caseIds.flatMap((id) => sideRuns(states[id]?.b));
    return {
      aDone: aRuns.filter((run) => terminal(run.status)).length,
      aTotal: aRuns.length || caseIds.length,
      bDone: bRuns.filter((run) => terminal(run.status)).length,
      bTotal: bRuns.length || caseIds.length,
    };
  }, [caseIds, states]);

  const triggerMetrics = useMemo(() => {
    if (detail?.preset !== 'trigger') return null;
    const labels = new Map((dataset?.cases || []).map((item) => [String(item.id || ''), item.values?.should_trigger]));
    for (const item of detail.cases || []) {
      if (!labels.has(item.id)) labels.set(item.id, item.caseValues?.should_trigger);
    }
    let compared = 0;
    let correct = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const caseId of caseIds) {
      const expected = labels.get(caseId);
      if (typeof expected !== 'boolean') continue;
      const stateRuns = sideRuns(states[caseId]?.b);
      const detailCase = detail.cases?.find((item) => item.id === caseId);
      const runs = stateRuns.length ? stateRuns : detailCase ? [detailCase] : [];
      for (const run of runs) {
        if (typeof run.skillTriggered !== 'boolean') continue;
        compared += 1;
        if (run.skillTriggered === expected) correct += 1;
        else if (run.skillTriggered) falsePositive += 1;
        else falseNegative += 1;
      }
    }
    return { compared, accuracy: compared ? (correct / compared) * 100 : null, falsePositive, falseNegative };
  }, [caseIds, dataset, detail, states]);

  const pairedMetrics = useMemo(() => {
    if (detail?.preset !== 'skill-ab') return null;
    const aRuns = caseIds.flatMap((id) => sideRuns(states[id]?.a));
    const bRuns = caseIds.flatMap((id) => sideRuns(states[id]?.b));
    let compared = 0;
    let regressions = 0;
    for (const caseId of caseIds) {
      const aScore = average(sideRuns(states[caseId]?.a).map((run) => run.score));
      const bScore = average(sideRuns(states[caseId]?.b).map((run) => run.score));
      if (aScore == null || bScore == null) continue;
      compared += 1;
      if (aScore < bScore) regressions += 1;
    }
    return {
      currentScore: abComparison.aScore,
      baselineScore: abComparison.bScore,
      currentSeconds: average(aRuns.map((run) => seconds(run.timeCost))),
      baselineSeconds: average(bRuns.map((run) => seconds(run.timeCost))),
      currentTokens: average(aRuns.map((run) => run.tokenUsage)),
      baselineTokens: average(bRuns.map((run) => run.tokenUsage)),
      compared: abComparison.comparable || compared,
      regressions: abComparison.bWins || regressions,
    };
  }, [abComparison, caseIds, detail?.preset, states]);

  const retryRun = useCallback(async (caseId: string, side: 'a' | 'b' | 'both') => {
    const task = workbenchExperiment?.grayscaleTask;
    if (!task?.id || !task.caseStates) return;
    const retryKey = `${caseId}:${side}`;
    if (retryingRun) return;
    const sides: Array<'a' | 'b'> = side === 'both' ? ['a', 'b'] : [side];
    const targets = sides.map((targetSide) => {
      const target = task.caseStates?.[caseId]?.[targetSide];
      const runs = target?.runs?.length ? target.runs : target ? [target] : [];
      const run = [...runs].reverse().find((item) => item.runIndex != null || item.roundIndex != null);
      return { side: targetSide, run };
    });
    if (targets.some((target) => !target.run)) {
      setRetryError(retryKey, '找不到可重新执行的运行记录。');
      return;
    }
    const replacesPassedResult = targets.some((target) => (
      target.run?.status === 'pass'
      || (typeof target.run?.score === 'number' && Number.isFinite(target.run.score))
    ));
    const confirmMessage = side === 'both'
      ? '重新执行 A+B 会替换该 Case 两侧当前使用的执行结果和评分，是否继续？'
      : '重新执行会替换该 Case 当前使用的执行结果和评分，是否继续？';
    if (replacesPassedResult && !window.confirm(confirmMessage)) {
      return;
    }
    setRetryingRun(retryKey);
    setRetryError('', '');
    try {
      const response = await apiFetch(`/api/debug/grayscale-tasks/${encodeURIComponent(task.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          action: 'retry-run',
          caseId,
          side,
          runIndexes: Object.fromEntries(targets.map((target) => [
            target.side,
            target.run?.runIndex ?? target.run?.roundIndex ?? 1,
          ])),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '重新执行失败');
      await load(true);
    } catch (error) {
      setRetryError(retryKey, error instanceof Error ? error.message : '重新执行失败');
    } finally {
      setRetryingRun('');
    }
  }, [load, retryingRun, setRetryError, setRetryingRun, user, workbenchExperiment]);

  const retryExistingCase = useCallback(async (caseId: string) => {
    if (!detail || retryInFlight.current) return;
    const targets = existingTraceRetryResults(caseId, detail.results || [], detail.evaluatorIds);
    if (!targets.length) return;
    if (targets.some((item) => item.status === 'done')
      && !window.confirm('重新评测将替换该 Case 的当前评分，复用已有 Trace，不重新执行 Agent。是否继续？')) return;
    retryInFlight.current = true;
    const retryKey = `${caseId}:b`;
    setRetryingRun(retryKey);
    setRetryError('', '');
    try {
      for (const target of targets) {
        const response = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}/results/${encodeURIComponent(target.id)}/retry?user=${encodeURIComponent(user)}`, { method: 'POST' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '重新评测失败');
      }
    } catch (error) {
      setRetryError(retryKey, error instanceof Error ? error.message : '重新评测失败');
    } finally {
      await load(true);
      retryInFlight.current = false;
      setRetryingRun('');
    }
  }, [detail, experimentId, load, setRetryError, setRetryingRun, user]);

  if (caseDetailId) {
    return (
      <ExperimentCaseDetail
        id={experimentId}
        caseId={caseDetailId}
        embedded
        onBack={() => setCaseDetailId(null)}
      />
    );
  }

  if (loading) {
    return <div className="flex min-h-[420px] items-center justify-center text-sm text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载实验进度</div>;
  }
  if (!detail) {
    return <div className="p-8 text-center text-sm text-error">{error || '实验不存在'}</div>;
  }

  const isAb = detail.preset === 'skill-ab';
  const isTrigger = detail.preset === 'trigger';
  const isUseCase = detail.preset === 'use-case';
  const existingTrace = isUseCase && snapshot.traceSource === 'existing' && !workbenchExperiment?.grayscaleTask;
  const resultEvaluatorIds = detail.evaluatorIds.filter((id) => evaluatorLookup.categoryOf(id) === 'res');
  const traceEvaluatorIds = detail.evaluatorIds.filter((id) => evaluatorLookup.categoryOf(id) === 'traj');
  const experimentSettled = ['done', 'partial', 'failed', 'cancelled'].includes(detail.status);
  const abRunsComplete = abProgress.aDone >= abProgress.aTotal && abProgress.bDone >= abProgress.bTotal;
  const resultRowsComplete = detail.evaluationProgress
    ? detail.evaluationProgress.pending === 0
    : detail.progress.pending === 0;
  const isDone = ['done', 'partial', 'failed'].includes(detail.status)
    && resultRowsComplete
    && (!isAb || abRunsComplete);
  const displayStatus = ['done', 'partial'].includes(detail.status) && !isDone
    ? 'running'
    : detail.status;
  const total = detail.executionProgress?.total || (isAb
    ? abProgress.aTotal + abProgress.bTotal
    : detail.traceProgress?.total || detail.progress.total || detail.caseTotal);
  const completed = detail.executionProgress
    ? detail.executionProgress.succeeded + detail.executionProgress.failed
    : isAb
      ? abProgress.aDone + abProgress.bDone
      : detail.traceProgress
        ? detail.traceProgress.ready + detail.traceProgress.failed
        : detail.progress.done + detail.progress.failed;
  const firstScore = isUseCase ? categoryAverage(detail.breakdown, resultEvaluatorIds)
    : detail.breakdown.find((item) => item.evaluatorId === SKILL_TRIGGER_ANALYZER_EVALUATOR_ID)?.avg
    ?? detail.breakdown.find((item) => item.evaluatorId === 'skill-trigger-accuracy')?.avg
    ?? detail.breakdown.find((item) => item.evaluatorId === 'preset-agent-task-completion')?.avg
    ?? detail.overall;
  const secondScore = isUseCase ? categoryAverage(detail.breakdown, traceEvaluatorIds)
    : detail.breakdown.find((item) => item.evaluatorId === (isAb ? 'preset-result-accuracy' : 'preset-agent-trace-quality'))?.avg ?? null;
  const metricLabel = isTrigger ? '触发准确率' : detail.preset === 'use-case' ? '任务结果得分' : '当前版本得分';
  const metricValue = isUseCase && !resultEvaluatorIds.length ? '未评测' : !isDone
    ? '—'
    : isTrigger && triggerMetrics?.accuracy != null
      ? `${triggerMetrics.accuracy.toFixed(1)}%`
      : isAb ? formatScore(pairedMetrics?.currentScore) : formatScore(firstScore);
  const secondLabel = isTrigger ? '误选 / 漏选' : detail.preset === 'use-case' ? '轨迹质量' : '回归用例';
  const secondValue = isUseCase && !traceEvaluatorIds.length ? '未评测' : !isDone
    ? '—'
    : isTrigger
      ? triggerMetrics?.compared ? `${triggerMetrics.falsePositive} / ${triggerMetrics.falseNegative}` : '—'
      : isAb
        ? pairedMetrics?.compared ? `${pairedMetrics.regressions}/${pairedMetrics.compared}` : '—'
        : formatScore(secondScore);
  const conclusionScore = isAb ? pairedMetrics?.currentScore : detail.overall;
  const configuredTarget = (snapshot.executionTarget || snapshot.traceGenerationTarget) as { host?: string; platform?: string; model?: string | null } | undefined;
  const modelMismatch = !existingTrace && executionModelMismatch(configuredTarget?.model, (detail.cases || []).map((row) => row.actualModel));
  const outcome = modelMismatch ? { successful: false, label: '配置不一致', conclusion: '配置不一致', hint: '实际执行模型与选择不一致，请重新创建实验；本记录不能用于评价所选模型' } : describeExperimentOutcome({
    status: displayStatus, execution: detail.executionProgress, evaluation: detail.evaluationProgress,
    score: conclusionScore, complete: isDone,
    trajectoryOnly: isUseCase && traceEvaluatorIds.length > 0 && traceEvaluatorIds.length === detail.evaluatorIds.length,
  });
  const conclusion = outcome.conclusion;
  const traceSource = snapshot.traceSource === 'existing' ? (isAb ? '已有 Trace 输入（重新执行）' : '已有 Trace') : '平台运行';
  const traceGenerationTarget = existingTrace ? null : configuredTarget;
  const hostAndModel = traceGenerationTarget?.host
    ? `${traceGenerationTarget.host} · ${traceGenerationTarget.platform || '—'} / ${traceGenerationTarget.model || '平台默认'}`
    : snapshot.traceSource === 'existing' ? '不适用（复用已有 Trace）' : '—';
  const evaluatorNames = detail.evaluatorIds
    .map((id) => isTrigger && LEGACY_TRIGGER_EVALUATOR_IDS.has(id)
      ? 'skill-trigger-analyzer（历史结果）'
      : evaluatorLookup.nameOf(id))
    .join('、');
  const percent = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : 0;
  const versionALabel = detail.skillContext?.versionA == null ? '无 Skill' : `v${String(detail.skillContext.versionA)}`;
  const versionBLabel = `v${String(detail.skillContext?.versionB ?? '—')}`;
  const detailCases = new Map((detail.cases || []).map((item) => [item.id, item]));
  const datasetCases = new Map<string, Record<string, unknown>>((dataset?.cases || []).map((item) => [
    String(item.id || ''),
    {
      ...(item.values || {}),
      input: item.input || item.values?.input,
      expectedOutput: item.expectedOutput || item.values?.expectedOutput,
    },
  ]));
  const filteredAbCases = abComparison.cases.filter((item) => abFilter === 'all' || item.outcome === abFilter);
  const scoreDelta = abComparison.aScore != null && abComparison.bScore != null
    ? abComparison.aScore - abComparison.bScore
    : null;
  const comparisonConclusion = modelMismatch ? '执行模型与配置不一致，本次 A/B 结论不可用于评价所选模型' : !isDone
    ? '评估完成后生成最终 A/B 结论'
    : scoreDelta == null
    ? '等待 A、B 两侧形成可比结果'
    : Math.abs(scoreDelta) < 0.05
      ? `A ${versionALabel} 与 B ${versionBLabel} 综合得分持平`
      : `${scoreDelta > 0 ? `A ${versionALabel}` : `B ${versionBLabel}`} 综合得分高 ${Math.abs(scoreDelta).toFixed(1)} 分`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="w-full space-y-4">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground-secondary">‹ 返回</button>
          <div>
            <div className="flex items-center gap-1">
              <h2 className="text-base font-semibold text-foreground">{detail.name}</h2>
              <ExperimentRenameButton
                experimentId={detail.id}
                user={user}
                name={detail.name}
                createdAt={detail.createdAt}
                onRenamed={(name) => {
                  setDetail((current) => current ? { ...current, name } : current);
                  void load(true);
                }}
              />
            </div>
            <p className="mt-1 text-sm text-foreground-muted">{PRESET_LABELS[detail.preset || ''] || 'Skill 实验'} · 统一实验流程 · {traceSource}</p>
          </div>
          <span className={`ml-auto rounded-md px-2 py-1 text-sm font-medium ${displayStatus === 'failed' ? 'bg-error-subtle text-error' : outcome.successful ? 'bg-success-subtle text-success' : 'bg-primary-subtle text-primary'}`}>
            {outcome.label || STATUS_LABELS[displayStatus] || displayStatus}
          </span>
        </div>

        {error && <div className="rounded-lg border border-error-subtle-border bg-error-subtle p-3 text-sm text-error">{error}</div>}
        {modelMismatch && <div role="alert" className="rounded-lg border border-error-subtle-border bg-error-subtle p-3 text-sm text-error">配置模型 {configuredTarget?.model} 与实际执行模型不一致，请重新创建实验。历史输出和评分保留，但不代表所选模型的结果。</div>}

        {detail.executionProgress && detail.evaluationProgress && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-4 py-3 text-sm">
              <span><span className="text-foreground-muted">待评测 Agent：</span><b className="font-semibold text-foreground">{detail.agentName || '—'}</b></span>
              <span><span className="text-foreground-muted">评估器：</span><b className="font-semibold text-foreground">{detail.evaluatorIds.length}</b></span>
              <span><span className="text-foreground-muted">统计口径：</span><b className="font-semibold text-foreground">{detail.executionProgress.total} 个执行项 = {detail.evaluationProgress.total} 个评测项</b></span>
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              {([
                ['执行成功', detail.executionProgress.succeeded, 'text-success'],
                ['执行失败', detail.executionProgress.failed, 'text-error'],
                ['评测成功', detail.evaluationProgress.succeeded, 'text-success'],
                ['评测失败', detail.evaluationProgress.failed, 'text-error'],
                ['未评测', detail.evaluationProgress.skipped || 0, 'text-foreground-muted'],
                ['未计分', detail.evaluationProgress.unscored || 0, 'text-foreground-muted'],
              ] as const).map(([label, value, tone]) => (
                <div key={label} className="min-w-0 bg-card px-3 py-3">
                  <small className={`text-sm font-medium ${tone}`}>{label}</small>
                  <b className="mt-2 block text-lg font-semibold tabular-nums leading-6 text-foreground">{value} <span className="text-sm font-normal text-foreground-muted">项</span></b>
                </div>
              ))}
            </div>
            <div className="bg-background-secondary px-4 py-2.5 text-sm text-foreground-muted">
              一个执行项对应一个聚合评测项；多个评估器只决定该评测项是否成功，不扩大评测项总数。执行失败的项记为未评测；正常完成但未返回分数的项单列为未计分。
            </div>
          </section>
        )}

        {isAb ? (
          <>
            <div className="rounded-xl border border-primary-subtle-border bg-primary-subtle px-4 py-3 text-sm text-foreground-secondary">
              <b className="text-foreground">{comparisonConclusion}</b>
              <span className="ml-2">仅基于 {abComparison.comparable} 个可比配对 Case；{abComparison.unpaired} 个尚未配对。</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-border border-t-2 border-t-primary bg-card p-5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-md bg-primary text-sm font-semibold text-white">A</span>
                  <b className="text-sm text-foreground">当前版本 · {versionALabel}</b>
                </div>
                <div className="mt-3 flex items-baseline gap-3">
                  <strong className="text-lg font-semibold tabular-nums leading-6 text-primary">{formatScore(isDone ? abComparison.aScore : null)}</strong>
                  <span className="text-sm text-foreground-muted">综合得分</span>
                </div>
              </div>
              <div className="rounded-xl border border-border border-t-2 border-t-success bg-card p-5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-md bg-success text-sm font-semibold text-white">B</span>
                  <b className="text-sm text-foreground">对比版本 · {versionBLabel}</b>
                </div>
                <div className="mt-3 flex items-baseline gap-3">
                  <strong className="text-lg font-semibold tabular-nums leading-6 text-success">{formatScore(isDone ? abComparison.bScore : null)}</strong>
                  <span className="text-sm text-foreground-muted">综合得分</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            {[
              [existingTrace ? 'Trace 就绪' : '执行进度', `${completed}/${total || 0}`, outcome.successful ? '有效数据已齐' : isDone ? '执行已结束，请查看失败或未计分项' : `已完成 ${percent}%`],
              [metricLabel, metricValue, isTrigger ? `基于 ${triggerMetrics?.compared || 0}/${total || 0} 项有效判定；执行失败不计入` : '来自已选评估器'],
              [secondLabel, secondValue, isTrigger ? '误选与漏选分开统计' : '相同任务口径'],
              ['当前结论', conclusion, outcome.hint],
            ].map(([label, value, hint]) => (
              <div key={label} className="rounded-xl border border-border bg-card p-4">
                <small className="text-sm text-foreground-muted">{label}</small>
                <b className="mt-2 block text-lg font-semibold tabular-nums leading-6 text-foreground">{value}</b>
                <em className="mt-1 block text-sm not-italic text-foreground-muted">{hint}</em>
              </div>
            ))}
          </div>
        )}

        <SkillExperimentProgress
          status={displayStatus}
          preset={detail.preset}
          traceSource={snapshot.traceSource as string | undefined}
          executionProgress={detail.executionProgress}
          evaluationProgress={detail.evaluationProgress}
          sideProgress={detail.sideProgress}
          versionALabel={versionALabel}
          versionBLabel={versionBLabel}
        />

        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3"><h3 className="text-base font-semibold text-foreground">已冻结配置</h3></div>
          <div className="grid gap-px bg-border md:grid-cols-3">
            {[
              ['Skill', `${detail.skillName || skillName} · ${isAb ? `A ${detail.skillContext?.versionA == null ? '无 Skill' : `v${String(detail.skillContext.versionA)}`} / B v${String(detail.skillContext?.versionB ?? '—')}` : `v${detail.skillVersion ?? '—'}`}`],
              ['Agent', detail.agentName || '—'],
              ['数据集', dataset?.name || String(snapshot.datasetId || (existingTrace ? '未关联数据集' : '—'))],
              ['Trace 来源', traceSource],
              ['评估器', evaluatorNames || '—'],
              ['配置主机 / 运行模型', hostAndModel],
            ].map(([label, value]) => (
              <div key={label} className="bg-card p-3"><small className="text-sm text-foreground-muted">{label}</small><b className="mt-1 block break-words text-base font-semibold text-foreground">{value}</b></div>
            ))}
          </div>
        </section>

        {isAb ? (
          <>
            <section className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-base font-semibold text-foreground">评估器分解</h3>
                <span className="text-sm text-foreground-muted">双色条仅统计两侧都有得分的可比 Case</span>
                <span className="ml-auto flex items-center gap-3 text-sm text-foreground-muted">
                  <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-primary" />A · {versionALabel}</span>
                  <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-success" />B · {versionBLabel}</span>
                </span>
              </div>
              <div className="divide-y divide-border px-4">
                {abComparison.evaluators.map((evaluator) => (
                  <div key={evaluator.evaluatorId} className="grid gap-3 py-4 md:grid-cols-[220px_1fr] md:items-center">
                    <div>
                      <b className="block text-sm text-foreground">{evaluatorLookup.nameOf(evaluator.evaluatorId) || evaluator.evaluatorName}</b>
                      <small className="mt-1 block text-sm text-foreground-muted">覆盖 {evaluator.coverage}/{abComparison.comparable} 个可比 Case</small>
                    </div>
                    <div className="space-y-2">
                      {([
                        ['A', evaluator.aScore, 'bg-primary', 'text-primary'],
                        ['B', evaluator.bScore, 'bg-success', 'text-success'],
                      ] as const).map(([side, score, barClass, textClass]) => (
                        <div key={side} className="grid grid-cols-[16px_1fr_42px] items-center gap-2">
                          <span className={`text-sm font-semibold ${textClass}`}>{side}</span>
                          <div className="h-2 overflow-hidden rounded-full bg-background-secondary">
                            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${isDone ? Math.max(0, Math.min(100, score || 0)) : 0}%` }} />
                          </div>
                          <b className={`text-right text-sm ${textClass}`}>{formatScore(isDone ? score : null)}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {abComparison.evaluators.length === 0 && <div className="py-8 text-center text-sm text-foreground-muted">评估器结果生成后将在这里按 A/B 分解。</div>}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-base font-semibold text-foreground">Case 明细</h3>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {([
                    ['all', '全部', abComparison.cases.length],
                    ['a', 'A 胜', abComparison.aWins],
                    ['b', 'B 胜', abComparison.bWins],
                    ['tie', '平', abComparison.ties],
                    ['unpaired', '未配对', abComparison.unpaired],
                  ] as const).map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAbFilter(value)}
                      className={`rounded-full border px-3 py-1 text-sm font-medium ${abFilter === value ? 'border-primary bg-primary-subtle text-primary' : 'border-border bg-card text-foreground-secondary'}`}
                    >
                      {label} <span className="ml-1 text-foreground-muted">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[520px] overflow-x-auto overflow-y-auto [scrollbar-gutter:stable]">
                <table
                  className="w-full table-fixed text-left text-sm"
                  style={{ minWidth: 1608 }}
                >
                  <thead className="sticky top-0 z-10 bg-background-secondary text-foreground-muted">
                    <tr>
                      <th className="w-40 px-3 py-2 font-medium">输入</th>
                      <th className="w-40 px-3 py-2 font-medium">预期输出</th>
                      <th className="w-48 px-3 py-2 font-medium">A · {versionALabel} 实际输出</th>
                      <th className="w-[72px] px-2 py-2 font-medium">综合得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">结果得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">轨迹得分</th>
                      <th className="w-48 px-3 py-2 font-medium">B · {versionBLabel} 实际输出</th>
                      <th className="w-[72px] px-2 py-2 font-medium">综合得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">结果得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">轨迹得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">胜负</th>
                      <th className="sticky right-64 z-[1] w-32 bg-background-secondary px-2 py-2 font-medium">操作 A</th>
                      <th className="sticky right-32 z-[1] w-32 bg-background-secondary px-2 py-2 font-medium">操作 B</th>
                      <th className="sticky right-0 z-[1] w-32 bg-background-secondary px-2 py-2 font-medium">操作 A+B</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredAbCases.map((comparison) => {
                      const detailCase = detailCases.get(comparison.caseId);
                      const datasetValues = datasetCases.get(comparison.caseId) || {};
                      const input = firstText(detailCase?.input, detailCase?.caseValues?.input, datasetValues.input, datasetValues.query, datasetValues.prompt);
                      const reference = firstText(detailCase?.referenceOutput, detailCase?.caseValues?.expectedOutput, datasetValues.expectedOutput, datasetValues.referenceOutput);
                      const outcome = comparison.outcome === 'a' ? 'A 胜' : comparison.outcome === 'b' ? 'B 胜' : comparison.outcome === 'tie' ? '平' : '未配对';
                      const aResultScore = average(comparison.a.evaluations.filter((item) => evaluatorLookup.categoryOf(item.evaluatorId) === 'res' && item.status === 'done').map((item) => item.score));
                      const aTraceScore = average(comparison.a.evaluations.filter((item) => evaluatorLookup.categoryOf(item.evaluatorId) === 'traj' && item.status === 'done').map((item) => item.score));
                      const bResultScore = average(comparison.b.evaluations.filter((item) => evaluatorLookup.categoryOf(item.evaluatorId) === 'res' && item.status === 'done').map((item) => item.score));
                      const bTraceScore = average(comparison.b.evaluations.filter((item) => evaluatorLookup.categoryOf(item.evaluatorId) === 'traj' && item.status === 'done').map((item) => item.score));
                      const aRun = [...sideRuns(states[comparison.caseId]?.a)].reverse()[0];
                      const bRun = [...sideRuns(states[comparison.caseId]?.b)].reverse()[0];
                      const aRetryMode = aRun ? resolveGrayscaleRetryMode(aRun) : 'execution';
                      const bRetryMode = bRun ? resolveGrayscaleRetryMode(bRun) : 'execution';
                      const retryBusy = Boolean(retryingRun) || (!experimentSettled && hasActiveRuns);
                      const aBusy = !experimentSettled && runIsActive(comparison.a);
                      const bBusy = !experimentSettled && runIsActive(comparison.b);
                      const pairActionLabel = retryingRun === `${comparison.caseId}:both`
                        ? '重试中'
                        : aBusy || bBusy
                          ? activeAbPairLabel(comparison.a, comparison.b)
                          : aRetryMode === bRetryMode
                            ? aRetryMode === 'evaluation' ? '重新评测 A+B' : '重新执行 A+B'
                            : '重试 A+B';
                      const aExperimentCaseId = detail.cases?.find((item) => (
                        (aRun?.experimentCaseId && item.id === aRun.experimentCaseId)
                        || (item.taskId && item.taskId === comparison.a.sessionId)
                      ))?.id || '';
                      const bExperimentCaseId = detail.cases?.find((item) => (
                        (bRun?.experimentCaseId && item.id === bRun.experimentCaseId)
                        || (item.taskId && item.taskId === comparison.b.sessionId)
                      ))?.id || '';
                      return (
                        <tr key={comparison.caseId} className="align-top hover:bg-background-secondary/60">
                          <td className="px-3 py-3"><ExpandableCellText value={input} /></td>
                          <td className="px-3 py-3"><ExpandableCellText value={reference} muted /></td>
                          <td className="px-3 py-3"><RunOutput run={aRun} output={comparison.a.output} /></td>
                          <td className="px-2 py-3 font-semibold text-foreground">{scoreText(comparison.a.score, summaryScoreStatus(comparison.a))}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(aResultScore, comparison.a.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(aTraceScore, comparison.a.status)}</td>
                          <td className="px-3 py-3"><RunOutput run={bRun} output={comparison.b.output} /></td>
                          <td className="px-2 py-3 font-semibold text-foreground">{scoreText(comparison.b.score, summaryScoreStatus(comparison.b))}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(bResultScore, comparison.b.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(bTraceScore, comparison.b.status)}</td>
                          <td className="px-2 py-3"><span className={`rounded-md px-2 py-1 text-sm font-medium ${comparison.outcome === 'a' ? 'bg-primary-subtle text-primary' : comparison.outcome === 'b' ? 'bg-success-subtle text-success' : 'bg-background-secondary text-foreground-muted'}`}>{outcome}</span></td>
                          <td className="sticky right-64 bg-card px-2 py-3">
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={!aExperimentCaseId} onClick={() => aExperimentCaseId && setCaseDetailId(aExperimentCaseId)} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">详情</button>
                              <button type="button" disabled={retryBusy || aBusy} onClick={() => void retryRun(comparison.caseId, 'a')} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{retryingRun === `${comparison.caseId}:a` ? '提交中' : aBusy ? (aRetryMode === 'evaluation' ? '评测中' : '执行中') : aRetryMode === 'evaluation' ? '重新评测' : '重新执行'}</button>
                            </div>
                            {retryError.key === `${comparison.caseId}:a` && <small className="mt-1 block whitespace-normal text-sm leading-4 text-error">{retryError.message}</small>}
                          </td>
                          <td className="sticky right-32 bg-card px-2 py-3">
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={!bExperimentCaseId} onClick={() => bExperimentCaseId && setCaseDetailId(bExperimentCaseId)} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">详情</button>
                              <button type="button" disabled={retryBusy || bBusy} onClick={() => void retryRun(comparison.caseId, 'b')} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{retryingRun === `${comparison.caseId}:b` ? '提交中' : bBusy ? (bRetryMode === 'evaluation' ? '评测中' : '执行中') : bRetryMode === 'evaluation' ? '重新评测' : '重新执行'}</button>
                            </div>
                            {retryError.key === `${comparison.caseId}:b` && <small className="mt-1 block whitespace-normal text-sm leading-4 text-error">{retryError.message}</small>}
                          </td>
                          <td className="sticky right-0 bg-card px-2 py-3">
                            <div className="flex flex-col items-start gap-1">
                              <button type="button" disabled={!aRun || !bRun || retryBusy || aBusy || bBusy} onClick={() => void retryRun(comparison.caseId, 'both')} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{pairActionLabel}</button>
                              <DeleteExperimentButton user={user} experimentId={experimentId} caseId={`dataset:${comparison.caseId}`} completed={isCompletedWorkbenchCase(detail.status, [states[comparison.caseId]?.a, states[comparison.caseId]?.b])} className="text-sm" onDeleted={(experimentDeleted) => experimentDeleted ? onBack() : load(true)} />
                            </div>
                            {retryError.key === `${comparison.caseId}:both` && <small className="mt-1 block whitespace-normal text-sm leading-4 text-error">{retryError.message}</small>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredAbCases.length === 0 && <div className="py-10 text-center text-sm text-foreground-muted">当前筛选下没有 Case。</div>}
              </div>
            </section>
          </>
        ) : (
          <>
            <button type="button" aria-expanded={showDetail} onClick={() => setDetailVisibility({ experimentId, expanded: !showDetail })} className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground-secondary">
              {showDetail ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              {showDetail ? '收起 Case 与评估明细' : '查看 Case 与评估明细'}
            </button>
            {showDetail && (
              isTrigger ? (
                <ExperimentDetail
                  id={experimentId}
                  embedded
                  onOpenCase={setCaseDetailId}
                />
              ) : (
                <section className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="text-base font-semibold text-foreground">Case 明细</h3>
                  </div>
                  <div className="max-h-[520px] overflow-x-auto overflow-y-auto [scrollbar-gutter:stable]">
                    <table className="w-full table-fixed text-left text-sm" style={{ minWidth: 1080 }}>
                      <thead className="sticky top-0 z-10 bg-background-secondary text-foreground-muted">
                        <tr>
                          <th className="w-48 px-3 py-2 font-medium">输入</th>
                          <th className="w-48 px-3 py-2 font-medium">预期输出</th>
                          <th className="w-64 px-3 py-2 font-medium">实际输出</th>
                          <th className="w-20 px-2 py-2 font-medium">综合得分</th>
                          <th className="w-20 px-2 py-2 font-medium">结果得分</th>
                          <th className="w-20 px-2 py-2 font-medium">轨迹得分</th>
                          <th className="sticky right-0 z-[1] w-40 bg-background-secondary px-3 py-2 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {caseIds.map((caseId) => {
                          const sideState = states[caseId]?.b;
                          const existingCase = existingTrace ? detailCases.get(caseId) : undefined;
                          const rowState = existingCase
                            ? existingTraceCaseRun(existingCase, detail.results || [], detail.evaluatorIds, detail.status)
                            : sideState;
                          const summary = summarizeAbSide(rowState);
                          const runs = sideRuns(rowState);
                          const latestRun = [...runs].reverse()[0];
                          const retryMode = existingTrace ? 'evaluation' : latestRun ? resolveGrayscaleRetryMode(latestRun) : 'execution';
                          const experimentCase = existingCase || detail.cases?.find((item) => (
                            (latestRun?.experimentCaseId && item.id === latestRun.experimentCaseId)
                            || (summary.sessionId && item.taskId === summary.sessionId)
                          ));
                          const datasetValues = datasetCases.get(caseId) || {};
                          const input = firstText(experimentCase?.input, datasetValues.input, datasetValues.query, datasetValues.prompt);
                          const reference = firstText(experimentCase?.referenceOutput, datasetValues.expectedOutput, datasetValues.referenceOutput);
                          const resultScore = evaluationScoreState(resultEvaluatorIds, summary.evaluations, summary.status);
                          const traceScore = evaluationScoreState(traceEvaluatorIds, summary.evaluations, summary.status);
                          const retryKey = `${caseId}:b`;
                          const busy = Boolean(retryingRun) || (existingTrace
                            ? ['executed', 'evaluating'].includes(summary.status)
                            : !experimentSettled && (hasActiveRuns || runIsActive(summary)));
                          const canRetry = existingTrace
                            ? existingTraceRetryResults(caseId, detail.results || [], detail.evaluatorIds).length > 0 && detail.status !== 'cancelled'
                            : Boolean(latestRun);
                          return (
                            <tr key={caseId} className="align-top hover:bg-background-secondary/60">
                              <td className="px-3 py-3"><ExpandableCellText value={input} /></td>
                              <td className="px-3 py-3"><ExpandableCellText value={reference} muted /></td>
                              <td className="px-3 py-3"><RunOutput run={latestRun} output={summary.output} /></td>
                              <td className="px-2 py-3 font-semibold text-foreground">{scoreText(summary.score, existingTrace ? summary.status : summaryScoreStatus(summary))}</td>
                              <td className="px-2 py-3 text-foreground">{scoreText(resultScore.score, resultScore.status)}</td>
                              <td className="px-2 py-3 text-foreground">{scoreText(traceScore.score, traceScore.status)}</td>
                              <td className="sticky right-0 bg-card px-3 py-3">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <button type="button" disabled={!experimentCase?.id} onClick={() => experimentCase?.id && setCaseDetailId(experimentCase.id)} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">详情</button>
                                  <button type="button" disabled={!canRetry || busy} onClick={() => void (existingTrace ? retryExistingCase(caseId) : retryRun(caseId, 'b'))} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{retryingRun === retryKey ? '提交中' : existingTrace ? (summary.status === 'evaluating' ? '评测中' : summary.status === 'executed' ? '待评测' : '重新评测') : busy ? (retryMode === 'evaluation' ? '评测中' : '执行中') : retryMode === 'evaluation' ? '重新评测' : '重新执行'}</button>
                                  <DeleteExperimentButton user={user} experimentId={experimentId} caseId={existingTrace ? caseId : `dataset:${caseId}`} completed={existingTrace ? !['executed', 'evaluating'].includes(summary.status) : isCompletedWorkbenchCase(detail.status, [sideState])} className="text-sm" onDeleted={(experimentDeleted) => experimentDeleted ? onBack() : load(true)} />
                                </div>
                                {retryError.key === retryKey && <small className="mt-1 block whitespace-normal text-sm leading-4 text-error">{retryError.message}</small>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {caseIds.length === 0 && <div className="py-10 text-center text-sm text-foreground-muted">暂无 Case。</div>}
                  </div>
                </section>
              )
            )}
          </>
        )}
      </div>

    </div>
  );
}
