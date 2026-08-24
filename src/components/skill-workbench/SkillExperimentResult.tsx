'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

import { ExperimentDetail } from '@/app/(main)/experiments/[id]/page';
import { ExperimentCaseDetail } from '@/app/(main)/experiments/[id]/cases/[caseId]/page';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { apiFetch } from '@/lib/client/api';
import {
  buildAbComparison,
  type AbCaseStates,
  type AbOutcome,
  type AbSideState,
} from '@/lib/skill-workbench/ab-comparison';
import { SKILL_TRIGGER_ANALYZER_EVALUATOR_ID } from '@/lib/skill-workbench/trigger-evaluator';

interface DetailPayload {
  id: string;
  name: string;
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
  caseTotal: number;
  cases?: Array<{
    id: string;
    taskId?: string | null;
    input?: string;
    actualOutput?: string;
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

function scoreText(score: number | null | undefined, status?: string) {
  if (typeof score === 'number' && Number.isFinite(score)) return score.toFixed(1);
  if (status === 'evaluating' || status === 'running') return '评估中';
  if (status === 'executed' || status === 'pending') return '待评估';
  if (status === 'fail' || status === 'failed') return '失败';
  return '—';
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
  const [showDetail, setShowDetail] = useState(false);
  const [caseDetailId, setCaseDetailId] = useState<string | null>(null);
  const [abFilterState, setAbFilterState] = useState<{ experimentId: string; value: AbOutcome | 'all' }>({ experimentId, value: 'all' });
  const [retryingAbSideState, setRetryingAbSideState] = useState<{ experimentId: string; value: string }>({ experimentId, value: '' });
  const loadSequence = useRef(0);
  const abFilter = abFilterState.experimentId === experimentId ? abFilterState.value : 'all';
  const retryingAbSide = retryingAbSideState.experimentId === experimentId ? retryingAbSideState.value : '';
  const setAbFilter = useCallback(
    (value: AbOutcome | 'all') => setAbFilterState({ experimentId, value }),
    [experimentId],
  );
  const setRetryingAbSide = useCallback(
    (value: string) => setRetryingAbSideState({ experimentId, value }),
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
    const hasUnfinishedAbRuns = detail?.preset === 'skill-ab' && Object.values(caseStates).some((state) =>
      [...sideRuns(state.a), ...sideRuns(state.b)].some((run) => !terminal(run.status)),
    );
    if (!detail || (!['draft', 'running'].includes(detail.status) && !hasUnfinishedAbRuns)) return;
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

  const retryAbEvaluation = useCallback(async (caseId: string, side: 'a' | 'b') => {
    const task = workbenchExperiment?.grayscaleTask;
    const evaluatorIds = detail?.evaluatorIds || [];
    if (!task?.id || !task.caseStates || evaluatorIds.length === 0) return;
    const retryKey = `${caseId}:${side}`;
    if (retryingAbSide) return;
    const nextStates = JSON.parse(JSON.stringify(task.caseStates)) as AbCaseStates;
    const target = nextStates[caseId]?.[side];
    const runs = target?.runs?.length ? target.runs : target ? [target] : [];
    if (!target || runs.length === 0 || runs.some((run) => !run.sessionId)) {
      setError('该版本没有可复用的执行轨迹，暂时无法重新评测。');
      return;
    }
    setRetryingAbSide(retryKey);
    for (const run of runs) {
      run.status = 'evaluating';
      run.evaluations = evaluatorIds.map((evaluatorId) => ({
        ...(run.evaluations?.find((evaluation) => evaluation.evaluatorId === evaluatorId) || {}),
        evaluatorId,
        evaluatorName: evaluatorLookup.nameOf(evaluatorId),
        status: 'pending',
      }));
      delete run.evaluatorRunId;
      delete run.evaluationResultId;
      delete run.evaluationTraceId;
      delete run.failureType;
      delete run.failureDetail;
      delete run.completedAt;
    }
    target.status = 'evaluating';
    try {
      const patchResponse = await apiFetch(`/api/debug/grayscale-tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          configJson: task.config || snapshot,
          caseStatesJson: nextStates,
        }),
      });
      const patchResult = await patchResponse.json().catch(() => ({}));
      if (!patchResponse.ok) throw new Error(patchResult.error || '重试状态保存失败');
      const retryResponse = await apiFetch(`/api/debug/grayscale-tasks/${encodeURIComponent(task.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          action: 'evaluate',
          caseIds: [caseId],
          evaluators: evaluatorIds,
          onlyMissingEvaluation: true,
        }),
      });
      const retryResult = await retryResponse.json().catch(() => ({}));
      if (!retryResponse.ok) throw new Error(retryResult.error || '重新评测失败');
      setError('');
      await load(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '重新评测失败');
    } finally {
      setRetryingAbSide('');
    }
  }, [detail?.evaluatorIds, evaluatorLookup, load, retryingAbSide, setRetryingAbSide, snapshot, user, workbenchExperiment]);

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
    return <div className="flex min-h-[420px] items-center justify-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载实验进度</div>;
  }
  if (!detail) {
    return <div className="p-8 text-center text-xs text-error">{error || '实验不存在'}</div>;
  }

  const isAb = detail.preset === 'skill-ab';
  const isTrigger = detail.preset === 'trigger';
  const abRunsComplete = abProgress.aDone >= abProgress.aTotal && abProgress.bDone >= abProgress.bTotal;
  const resultRowsComplete = detail.progress.pending === 0;
  const isDone = detail.status === 'done' && resultRowsComplete && (!isAb || abRunsComplete);
  const displayStatus = detail.status === 'done' && !isDone ? 'running' : detail.status;
  const total = isAb
    ? abProgress.aTotal + abProgress.bTotal
    : detail.traceProgress?.total || detail.progress.total || detail.caseTotal;
  const completed = isAb
    ? abProgress.aDone + abProgress.bDone
    : detail.traceProgress
      ? detail.traceProgress.ready + detail.traceProgress.failed
      : detail.progress.done + detail.progress.failed;
  const firstScore = detail.breakdown.find((item) => item.evaluatorId === SKILL_TRIGGER_ANALYZER_EVALUATOR_ID)?.avg
    ?? detail.breakdown.find((item) => item.evaluatorId === 'skill-trigger-accuracy')?.avg
    ?? detail.breakdown.find((item) => item.evaluatorId === 'preset-agent-task-completion')?.avg
    ?? detail.overall;
  const secondScore = detail.breakdown.find((item) => item.evaluatorId === (isAb ? 'preset-result-accuracy' : 'preset-agent-trace-quality'))?.avg ?? null;
  const metricLabel = isTrigger ? '触发准确率' : detail.preset === 'use-case' ? '任务结果得分' : '当前版本得分';
  const metricValue = !isDone
    ? '—'
    : isTrigger && triggerMetrics?.accuracy != null
      ? `${triggerMetrics.accuracy.toFixed(1)}%`
      : isAb ? formatScore(pairedMetrics?.currentScore) : formatScore(firstScore);
  const secondLabel = isTrigger ? '误选 / 漏选' : detail.preset === 'use-case' ? '轨迹质量' : '回归用例';
  const secondValue = !isDone
    ? '—'
    : isTrigger
      ? triggerMetrics?.compared ? `${triggerMetrics.falsePositive} / ${triggerMetrics.falseNegative}` : '—'
      : isAb
        ? pairedMetrics?.compared ? `${pairedMetrics.regressions}/${pairedMetrics.compared}` : '—'
        : formatScore(secondScore);
  const conclusionScore = isAb ? pairedMetrics?.currentScore : detail.overall;
  const conclusion = isDone ? (conclusionScore == null ? '已完成' : conclusionScore >= 80 ? '可使用' : '需优化') : detail.status === 'failed' ? '需处理' : '计算中';
  const traceSource = snapshot.traceSource === 'existing' ? '已有 Trace' : '平台运行';
  const evaluatorNames = detail.evaluatorIds
    .map((id) => isTrigger && LEGACY_TRIGGER_EVALUATOR_IDS.has(id)
      ? 'skill-trigger-analyzer（历史结果）'
      : evaluatorLookup.nameOf(id))
    .join('、');
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : isDone ? 100 : 0;
  const stage1Done = isAb ? abProgress.aDone >= abProgress.aTotal : completed >= Math.ceil(total / 2);
  const stage2Done = isAb ? abProgress.bDone >= abProgress.bTotal : completed >= total;
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
  const comparisonConclusion = !isDone
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
          <button type="button" onClick={onBack} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground-secondary">‹ 返回</button>
          <div>
            <h2 className="text-base font-semibold text-foreground">{detail.name}</h2>
            <p className="mt-1 text-xs text-foreground-muted">{PRESET_LABELS[detail.preset || ''] || 'Skill 实验'} · 统一实验流程 · {traceSource}</p>
          </div>
          <span className={`ml-auto rounded-md px-2 py-1 text-[10px] font-medium ${displayStatus === 'failed' ? 'bg-error-subtle text-error' : isDone ? 'bg-success-subtle text-success' : 'bg-primary-subtle text-primary'}`}>
            {STATUS_LABELS[displayStatus] || displayStatus}
          </span>
        </div>

        {error && <div className="rounded-lg border border-error-subtle-border bg-error-subtle p-3 text-xs text-error">{error}</div>}

        {isAb ? (
          <>
            <div className="rounded-xl border border-primary-subtle-border bg-primary-subtle px-4 py-3 text-xs text-foreground-secondary">
              <b className="text-foreground">{comparisonConclusion}</b>
              <span className="ml-2">仅基于 {abComparison.comparable} 个可比配对 Case；{abComparison.unpaired} 个尚未配对。</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-border border-t-2 border-t-primary bg-card p-5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-semibold text-white">A</span>
                  <b className="text-sm text-foreground">当前版本 · {versionALabel}</b>
                </div>
                <div className="mt-5 flex items-end gap-3">
                  <strong className="text-4xl leading-none text-primary">{formatScore(isDone ? abComparison.aScore : null)}</strong>
                  <span className="pb-1 text-xs text-foreground-muted">综合得分</span>
                </div>
              </div>
              <div className="rounded-xl border border-border border-t-2 border-t-success bg-card p-5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-md bg-success text-xs font-semibold text-white">B</span>
                  <b className="text-sm text-foreground">对比版本 · {versionBLabel}</b>
                </div>
                <div className="mt-5 flex items-end gap-3">
                  <strong className="text-4xl leading-none text-success">{formatScore(isDone ? abComparison.bScore : null)}</strong>
                  <span className="pb-1 text-xs text-foreground-muted">综合得分</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            {[
              ['执行进度', `${completed}/${total || 0}`, isDone ? '有效数据已齐' : `已完成 ${percent}%`],
              [metricLabel, metricValue, isTrigger ? '按正反用例统计' : '来自已选评估器'],
              [secondLabel, secondValue, isTrigger ? '误选与漏选分开统计' : '相同任务口径'],
              ['当前结论', conclusion, isDone ? '实验数据已完成评估' : '等待数据完成'],
            ].map(([label, value, hint]) => (
              <div key={label} className="rounded-xl border border-border bg-card p-4">
                <small className="text-[10px] text-foreground-muted">{label}</small>
                <b className="mt-2 block text-2xl text-foreground">{value}</b>
                <em className="mt-1 block text-[10px] not-italic text-foreground-muted">{hint}</em>
              </div>
            ))}
          </div>
        )}

        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-center border-b border-border px-4 py-3"><h3 className="text-sm font-semibold text-foreground">实验进度</h3><span className="ml-auto text-[10px] text-foreground-muted">{isDone ? '已完成' : '正在运行与评估'}</span></div>
          <div className="p-4">
            <div className="h-2 overflow-hidden rounded-full bg-background-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {[
                ['冻结实验配置', 'Skill、Agent、数据集与评估器快照已保存', true],
                [isAb ? '运行版本 A' : '运行第一批用例', isAb ? `${abProgress.aDone}/${abProgress.aTotal}` : `${Math.min(completed, Math.ceil(total / 2))}/${Math.ceil(total / 2)}`, stage1Done],
                [isAb ? '运行版本 B' : isTrigger ? '运行反向用例' : '运行剩余任务用例', isAb ? `${abProgress.bDone}/${abProgress.bTotal}` : stage2Done ? '全部完成' : '正在进行', stage2Done],
                ['生成实验结论', isDone ? '结果、轨迹与安全评估已汇总' : '等待全部数据', isDone],
              ].map(([label, hint, done], index) => (
                <div key={String(label)} className="flex gap-3">
                  <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${done ? 'border-primary bg-primary text-white' : 'border-border text-foreground-muted'}`}>{done ? '✓' : index + 1}</span>
                  <span><b className="block text-xs text-foreground">{String(label)}</b><small className="mt-1 block text-[10px] leading-4 text-foreground-muted">{String(hint)}</small></span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold text-foreground">已冻结配置</h3></div>
          <div className="grid gap-px bg-border md:grid-cols-3">
            {[
              ['Skill', `${detail.skillName || skillName} · ${isAb ? `A ${detail.skillContext?.versionA == null ? '无 Skill' : `v${String(detail.skillContext.versionA)}`} / B v${String(detail.skillContext?.versionB ?? '—')}` : `v${detail.skillVersion ?? '—'}`}`],
              ['Agent', detail.agentName || '—'],
              ['数据集', dataset?.name || String(snapshot.datasetId || '—')],
              ['Trace 来源', traceSource],
              ['评估器', evaluatorNames || '—'],
              ['运行配置', `${String(snapshot.repeatRounds || 1)} 轮 · ${String((snapshot.runtime as Record<string, unknown> | undefined)?.interactionPolicy || '默认权限')}${isAb && pairedMetrics?.currentSeconds != null ? ` · A ${pairedMetrics.currentSeconds.toFixed(1)}s${pairedMetrics.currentTokens != null ? ` / ${Math.round(pairedMetrics.currentTokens)} tokens` : ''}` : ''}`],
            ].map(([label, value]) => (
              <div key={label} className="bg-card p-3"><small className="text-[10px] text-foreground-muted">{label}</small><b className="mt-1 block break-words text-xs text-foreground">{value}</b></div>
            ))}
          </div>
        </section>

        {isAb ? (
          <>
            <section className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground">评估器分解</h3>
                <span className="text-[10px] text-foreground-muted">双色条仅统计两侧都有得分的可比 Case</span>
                <span className="ml-auto flex items-center gap-3 text-[10px] text-foreground-muted">
                  <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-primary" />A · {versionALabel}</span>
                  <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-success" />B · {versionBLabel}</span>
                </span>
              </div>
              <div className="divide-y divide-border px-4">
                {abComparison.evaluators.map((evaluator) => (
                  <div key={evaluator.evaluatorId} className="grid gap-3 py-4 md:grid-cols-[220px_1fr] md:items-center">
                    <div>
                      <b className="block text-xs text-foreground">{evaluatorLookup.nameOf(evaluator.evaluatorId) || evaluator.evaluatorName}</b>
                      <small className="mt-1 block text-[10px] text-foreground-muted">覆盖 {evaluator.coverage}/{abComparison.comparable} 个可比 Case</small>
                    </div>
                    <div className="space-y-2">
                      {([
                        ['A', evaluator.aScore, 'bg-primary', 'text-primary'],
                        ['B', evaluator.bScore, 'bg-success', 'text-success'],
                      ] as const).map(([side, score, barClass, textClass]) => (
                        <div key={side} className="grid grid-cols-[16px_1fr_42px] items-center gap-2">
                          <span className={`text-[10px] font-semibold ${textClass}`}>{side}</span>
                          <div className="h-2 overflow-hidden rounded-full bg-background-secondary">
                            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${isDone ? Math.max(0, Math.min(100, score || 0)) : 0}%` }} />
                          </div>
                          <b className={`text-right text-xs ${textClass}`}>{formatScore(isDone ? score : null)}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {abComparison.evaluators.length === 0 && <div className="py-8 text-center text-xs text-foreground-muted">评估器结果生成后将在这里按 A/B 分解。</div>}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground">Case 明细</h3>
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
                      className={`rounded-full border px-3 py-1 text-[10px] font-medium ${abFilter === value ? 'border-primary bg-primary-subtle text-primary' : 'border-border bg-card text-foreground-secondary'}`}
                    >
                      {label} <span className="ml-1 text-foreground-muted">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[520px] overflow-x-auto overflow-y-auto [scrollbar-gutter:stable]">
                <table
                  className="w-full table-fixed text-left text-[11px]"
                  style={{ minWidth: 1480 }}
                >
                  <thead className="sticky top-0 z-10 bg-background-secondary text-foreground-muted">
                    <tr>
                      <th className="w-40 px-3 py-2 font-medium">输入</th>
                      <th className="w-40 px-3 py-2 font-medium">参考输出</th>
                      <th className="w-48 px-3 py-2 font-medium">A · {versionALabel} 实际输出</th>
                      <th className="w-[72px] px-2 py-2 font-medium">综合得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">结果得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">轨迹得分</th>
                      <th className="w-48 px-3 py-2 font-medium">B · {versionBLabel} 实际输出</th>
                      <th className="w-[72px] px-2 py-2 font-medium">综合得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">结果得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">轨迹得分</th>
                      <th className="w-[72px] px-2 py-2 font-medium">胜负</th>
                      <th className="sticky right-28 z-[1] w-28 bg-background-secondary px-2 py-2 font-medium">操作 A</th>
                      <th className="sticky right-0 z-[1] w-28 bg-background-secondary px-2 py-2 font-medium">操作 B</th>
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
                      const aExperimentCaseId = detail.cases?.find((item) => item.taskId && item.taskId === comparison.a.sessionId)?.id || '';
                      const bExperimentCaseId = detail.cases?.find((item) => item.taskId && item.taskId === comparison.b.sessionId)?.id || '';
                      return (
                        <tr key={comparison.caseId} className="align-top hover:bg-background-secondary/60">
                          <td className="px-3 py-3"><ExpandableCellText value={input} /></td>
                          <td className="px-3 py-3"><ExpandableCellText value={reference} muted /></td>
                          <td className="px-3 py-3"><ExpandableCellText value={comparison.a.output} muted /></td>
                          <td className="px-2 py-3 font-semibold text-foreground">{scoreText(comparison.a.score, comparison.a.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(aResultScore, comparison.a.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(aTraceScore, comparison.a.status)}</td>
                          <td className="px-3 py-3"><ExpandableCellText value={comparison.b.output} muted /></td>
                          <td className="px-2 py-3 font-semibold text-foreground">{scoreText(comparison.b.score, comparison.b.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(bResultScore, comparison.b.status)}</td>
                          <td className="px-2 py-3 text-foreground">{scoreText(bTraceScore, comparison.b.status)}</td>
                          <td className="px-2 py-3"><span className={`rounded-md px-2 py-1 text-[10px] font-medium ${comparison.outcome === 'a' ? 'bg-primary-subtle text-primary' : comparison.outcome === 'b' ? 'bg-success-subtle text-success' : 'bg-background-secondary text-foreground-muted'}`}>{outcome}</span></td>
                          <td className="sticky right-28 bg-card px-2 py-3">
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={!aExperimentCaseId} onClick={() => aExperimentCaseId && setCaseDetailId(aExperimentCaseId)} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">详情</button>
                              <button type="button" disabled={retryingAbSide === `${comparison.caseId}:a` || ['running', 'evaluating', 'pending'].includes(comparison.a.status)} onClick={() => void retryAbEvaluation(comparison.caseId, 'a')} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{retryingAbSide === `${comparison.caseId}:a` ? '重试中' : '重试'}</button>
                            </div>
                          </td>
                          <td className="sticky right-0 bg-card px-2 py-3">
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={!bExperimentCaseId} onClick={() => bExperimentCaseId && setCaseDetailId(bExperimentCaseId)} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">详情</button>
                              <button type="button" disabled={retryingAbSide === `${comparison.caseId}:b` || ['running', 'evaluating', 'pending'].includes(comparison.b.status)} onClick={() => void retryAbEvaluation(comparison.caseId, 'b')} className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-foreground-muted">{retryingAbSide === `${comparison.caseId}:b` ? '重试中' : '重试'}</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredAbCases.length === 0 && <div className="py-10 text-center text-xs text-foreground-muted">当前筛选下没有 Case。</div>}
              </div>
            </section>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setShowDetail((value) => !value)} className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-foreground-secondary">
              {showDetail ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              {showDetail ? '收起 Case 与评估明细' : '查看 Case 与评估明细'}
            </button>
            {showDetail && (
              <ExperimentDetail
                id={experimentId}
                embedded
                onOpenCase={setCaseDetailId}
              />
            )}
          </>
        )}
      </div>

    </div>
  );
}
