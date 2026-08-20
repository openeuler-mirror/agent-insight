'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

import { ExperimentDetail } from '@/app/(main)/experiments/[id]/page';
import { ExperimentCaseDetail } from '@/app/(main)/experiments/[id]/cases/[caseId]/page';
import { apiFetch } from '@/lib/client/api';
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
  cases?: Array<{ id: string; caseValues?: Record<string, unknown> | null; skillTriggered?: boolean | null }>;
  configSnapshot?: Record<string, unknown> | null;
  skillContext?: Record<string, unknown> | null;
}

interface WorkbenchExperiment {
  id: string;
  configSnapshot?: Record<string, unknown>;
  grayscaleTask?: {
    caseStates?: Record<string, {
      a?: SideState;
      b?: SideState;
    }>;
  } | null;
}

interface SideState {
  status?: string;
  score?: number;
  timeCost?: string;
  tokenUsage?: number;
  toolCallCount?: number;
  skillTriggered?: boolean;
  runs?: Array<{
    status?: string;
    score?: number;
    timeCost?: string;
    tokenUsage?: number;
    toolCallCount?: number;
    skillTriggered?: boolean;
  }>;
}

interface DatasetPayload {
  id: string;
  name: string;
  cases?: Array<{ id?: string; values?: Record<string, unknown> }>;
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

const EVALUATOR_LABELS: Record<string, Record<string, string>> = {
  trigger: {
    [SKILL_TRIGGER_ANALYZER_EVALUATOR_ID]: 'skill-trigger-analyzer',
    'skill-trigger-accuracy': 'skill-trigger-analyzer（历史结果）',
    'preset-agent-task-completion': 'skill-trigger-analyzer（历史结果）',
    'preset-result-accuracy': 'skill-trigger-analyzer（历史结果）',
    'preset-agent-trace-quality': 'Agent 轨迹质量',
    'preset-safety-harmfulness': '安全合规',
  },
  'use-case': {
    'preset-agent-task-completion': '任务结果正确性',
    'preset-agent-trace-quality': 'Agent 轨迹质量',
    'preset-result-faithfulness': '证据忠实度',
    'preset-safety-harmfulness': '安全合规',
  },
  'skill-ab': {
    'preset-agent-task-completion': '任务结果正确性',
    'preset-result-accuracy': 'Skill 版本回归',
    'preset-agent-trace-quality': '执行成本',
    'preset-safety-harmfulness': '安全合规',
  },
};

function terminal(status?: string) {
  return ['pass', 'fail', 'done', 'failed', 'executed'].includes(status || '');
}

function sideRuns(side?: SideState) {
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

export function SkillExperimentResult({
  user,
  skillName,
  experimentId,
  onBack,
}: {
  user: string;
  skillName: string;
  experimentId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [workbenchExperiment, setWorkbenchExperiment] = useState<WorkbenchExperiment | null>(null);
  const [dataset, setDataset] = useState<DatasetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [caseDetailId, setCaseDetailId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [detailResponse, contextResponse] = await Promise.all([
        apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}?user=${encodeURIComponent(user)}&casePageSize=100`, { cache: 'no-store' }),
        apiFetch(`/api/skill-workbench/skills/${encodeURIComponent(skillName)}/experiments?user=${encodeURIComponent(user)}`, { cache: 'no-store' }),
      ]);
      const detailResult = await detailResponse.json();
      const contextResult = await contextResponse.json();
      if (!detailResponse.ok) throw new Error(detailResult.error || '加载实验失败');
      if (!contextResponse.ok) throw new Error(contextResult.error || '加载 Skill 实验上下文失败');
      const nextDetail = detailResult as DetailPayload;
      const nextWorkbench = (Array.isArray(contextResult.experiments) ? contextResult.experiments : [])
        .find((item: WorkbenchExperiment) => item.id === experimentId) || null;
      setDetail(nextDetail);
      setWorkbenchExperiment(nextWorkbench);
      const snapshot = (nextWorkbench?.configSnapshot || nextDetail.configSnapshot || {}) as Record<string, unknown>;
      const datasetId = typeof snapshot.datasetId === 'string' ? snapshot.datasetId : '';
      if (datasetId && dataset?.id !== datasetId) {
        const datasetResponse = await apiFetch(`/api/agent-datasets/${encodeURIComponent(datasetId)}?user=${encodeURIComponent(user)}&view=items`, { cache: 'no-store' });
        const datasetResult = await datasetResponse.json();
        if (datasetResponse.ok) setDataset(datasetResult as DatasetPayload);
      }
      setError('');
    } catch (loadError) {
      if (!silent) setError(loadError instanceof Error ? loadError.message : '加载实验失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [dataset?.id, experimentId, skillName, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!detail || !['draft', 'running'].includes(detail.status)) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [detail, load]);

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
      currentScore: average(aRuns.map((run) => run.score)),
      baselineScore: average(bRuns.map((run) => run.score)),
      currentSeconds: average(aRuns.map((run) => seconds(run.timeCost))),
      baselineSeconds: average(bRuns.map((run) => seconds(run.timeCost))),
      currentTokens: average(aRuns.map((run) => run.tokenUsage)),
      baselineTokens: average(bRuns.map((run) => run.tokenUsage)),
      compared,
      regressions,
    };
  }, [caseIds, detail?.preset, states]);

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
  const isDone = detail.status === 'done';
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
  const metricValue = isTrigger && triggerMetrics?.accuracy != null
    ? `${triggerMetrics.accuracy.toFixed(1)}%`
    : isAb ? formatScore(pairedMetrics?.currentScore) : formatScore(firstScore);
  const secondLabel = isTrigger ? '误选 / 漏选' : detail.preset === 'use-case' ? '轨迹质量' : '回归用例';
  const secondValue = isTrigger
    ? triggerMetrics?.compared ? `${triggerMetrics.falsePositive} / ${triggerMetrics.falseNegative}` : '—'
    : isAb
      ? pairedMetrics?.compared ? `${pairedMetrics.regressions}/${pairedMetrics.compared}` : '—'
      : formatScore(secondScore);
  const conclusionScore = isAb ? pairedMetrics?.currentScore : detail.overall;
  const conclusion = isDone ? (conclusionScore == null ? '已完成' : conclusionScore >= 80 ? '可使用' : '需优化') : detail.status === 'failed' ? '需处理' : '计算中';
  const traceSource = snapshot.traceSource === 'existing' ? '已有 Trace' : '平台运行';
  const evaluatorNames = detail.evaluatorIds
    .map((id) => EVALUATOR_LABELS[detail.preset || '']?.[id] || id)
    .join('、');
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : isDone ? 100 : 0;
  const stage1Done = isAb ? abProgress.aDone >= abProgress.aTotal : completed >= Math.ceil(total / 2);
  const stage2Done = isAb ? abProgress.bDone >= abProgress.bTotal : completed >= total;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground-secondary">‹ 返回</button>
          <div>
            <h2 className="text-base font-semibold text-foreground">{detail.name}</h2>
            <p className="mt-1 text-xs text-foreground-muted">{PRESET_LABELS[detail.preset || ''] || 'Skill 实验'} · 统一实验流程 · {traceSource}</p>
          </div>
          <span className={`ml-auto rounded-md px-2 py-1 text-[10px] font-medium ${detail.status === 'failed' ? 'bg-error-subtle text-error' : isDone ? 'bg-success-subtle text-success' : 'bg-primary-subtle text-primary'}`}>
            {STATUS_LABELS[detail.status] || detail.status}
          </span>
        </div>

        {error && <div className="rounded-lg border border-error-subtle-border bg-error-subtle p-3 text-xs text-error">{error}</div>}

        <div className="grid gap-3 md:grid-cols-4">
          {[
            ['执行进度', `${completed}/${total || 0}`, isDone ? '有效数据已齐' : `已完成 ${percent}%`],
            [metricLabel, metricValue, isTrigger ? '按正反用例统计' : '来自已选评估器'],
            [secondLabel, secondValue, isTrigger ? '误选与漏选分开统计' : isAb ? `基线 v${String(detail.skillContext?.versionB ?? '—')} 得分 ${formatScore(pairedMetrics?.baselineScore)}` : '相同任务口径'],
            ['当前结论', conclusion, isDone ? '实验数据已完成评估' : '等待数据完成'],
          ].map(([label, value, hint]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4">
              <small className="text-[10px] text-foreground-muted">{label}</small>
              <b className="mt-2 block text-2xl text-foreground">{value}</b>
              <em className="mt-1 block text-[10px] not-italic text-foreground-muted">{hint}</em>
            </div>
          ))}
        </div>

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
      </div>
    </div>
  );
}
