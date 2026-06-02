'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { ExpandableText } from '@/components/text/ExpandableText';
import { TermPopover } from '@/components/text/TermPopover';
import { apiFetch } from '@/lib/client/api';
import type { AgentDebugModule, AgentDebugPhase1Cell, AgentDebugReportPayload, AgentDebugRootCause, AgentDebugTraceLocation } from '@/lib/engine/agent-debug/types';

interface AgentDebugCardProps {
  executionId: string;
  user: string;
  locale: string;
  traceExplicitErrors?: TraceExplicitError[];
  onNodeRefClick?: (nodeId: string) => void;
}

export interface TraceExplicitError {
  id: string;
  title: string;
  description?: string;
  context?: string;
  recovery?: string;
  anchorId?: string;
  traceStepIndex?: number;
  traceNodeLabel?: string;
  traceNodeKind?: string;
}

interface AgentDebugResponse {
  report: AgentDebugReportPayload | null;
  row?: {
    status?: string;
    errorMessage?: string | null;
  } | null;
  cached?: boolean;
  error?: string;
}

const MODULES: Array<{ key: AgentDebugModule; zh: string; en: string }> = [
  { key: 'memory', zh: '记忆', en: 'Memory' },
  { key: 'reflection', zh: '反思', en: 'Reflection' },
  { key: 'planning', zh: '计划', en: 'Planning' },
  { key: 'action', zh: '行动', en: 'Action' },
  { key: 'system', zh: '系统', en: 'System' },
];

const MODULE_HELP: Record<string, { zh: string; en: string }> = {
  memory: {
    zh: '检查 Agent 是否错误引用历史信息、遗漏用户前文约束，或把不存在的上下文当成事实。',
    en: 'Checks whether the agent misused prior context, forgot user constraints, or relied on nonexistent history.',
  },
  reflection: {
    zh: '检查 Agent 是否误读工具结果、错误判断成功/失败，或过早认为任务已经完成。',
    en: 'Checks whether the agent misread tool results, misjudged progress, or claimed success too early.',
  },
  planning: {
    zh: '检查计划是否忽略环境约束、选择不可行路径，或与后续动作明显不一致。',
    en: 'Checks whether the plan ignored constraints, chose infeasible steps, or diverged from later actions.',
  },
  action: {
    zh: '检查真实工具调用、命令、路径、参数和动作执行结果是否存在明确问题。',
    en: 'Checks real tool calls, commands, paths, parameters, and action results for concrete issues.',
  },
  system: {
    zh: '检查工具、运行环境、模型限制、权限、超时等外部系统层异常。',
    en: 'Checks tool, runtime, model-limit, permission, timeout, and other external system errors.',
  },
};

const MODULE_ICONS: Record<string, typeof Clock> = {
  memory: Clock,
  reflection: MessageSquare,
  planning: CheckCircle2,
  action: Zap,
  system: FileText,
};

const MODULE_LABEL_ZH: Record<string, string> = {
  memory: '记忆',
  reflection: '反思',
  planning: '计划',
  action: '行动',
  system: '系统',
  others: '其他',
  unknown: '未知',
};

const ERROR_TYPE_LABEL_ZH: Record<string, string> = {
  over_simplification: '过度简化',
  memory_retrieval_failure: '记忆检索失败',
  hallucination: '幻觉',
  progress_misjudge: '进展误判',
  outcome_misinterpretation: '结果误读',
  causal_misattribution: '因果归因错误',
  constraint_ignorance: '忽略约束',
  impossible_action: '不可行计划',
  inefficient_plan: '低效计划',
  misalignment: '行动与计划不一致',
  invalid_action: '无效行动',
  format_error: '格式错误',
  parameter_error: '参数错误',
  step_limit: '步数上限',
  tool_execution_error: '工具执行错误',
  llm_limit: '模型响应限制',
  environment_error: '环境异常',
  others: '其他问题',
  no_error: '未发现问题',
};

export function AgentDebugCard({ executionId, user, locale, traceExplicitErrors = [], onNodeRefClick }: AgentDebugCardProps) {
  const zh = locale === 'zh';
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AgentDebugReportPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: AgentDebugResponse) => {
        if (cancelled) return;
        setReport(data.report || null);
        setError(data.row?.errorMessage || '');
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [executionId]);

  async function run(force = false) {
    if (!executionId || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, force }),
      });
      const data = await res.json().catch(() => ({})) as AgentDebugResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReport(data.report || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-6 space-y-4">
      {!report && !error && !loading && (
        <AssistantArticle>
          <div className="relative overflow-hidden rounded-lg border border-card-border bg-card shadow-sm">
            <div className="relative p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary-subtle-border bg-primary-subtle px-2 py-0.5 text-[10.5px] font-bold tracking-[0.12em] text-primary">
                    <span className="size-1.5 rounded-full bg-primary" />
                    {zh ? 'AGENTDEBUG · 四维认知' : 'AGENTDEBUG · FOUR-DIMENSION'}
                  </div>
                  <h3 className="text-lg font-extrabold tracking-tight text-foreground">
                    {zh ? '需要更深入的诊断？' : 'Need deeper diagnosis?'}
                  </h3>
                  <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-foreground-muted">
                    {zh
                      ? '按 AgentDebug 原方案，将每个执行片段抽取为 Memory / Reflection / Planning / Action 四个认知模块；System 作为外部工具/环境异常单独检查，再进入 Phase 2 定位真正根因。'
                      : 'Use the original AgentDebug pipeline: decompose execution slices into four cognitive modules, check System errors separately, then identify the key diagnostic finding.'}
                  </p>
                </div>
                <ModulePreview />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4 text-[11.5px] text-foreground-muted">
                <span className="inline-flex items-center gap-1"><Clock className="size-3" /> {zh ? '预计 8-30s' : '8-30s expected'}</span>
                <span className="inline-flex items-center gap-1"><BrainCircuit className="size-3" /> Phase 1 + Phase 2</span>
                <span className="inline-flex items-center gap-1"><FileText className="size-3" /> {zh ? '报告自动归档' : 'Report archived'}</span>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" onClick={() => run(false)}>
                  <Zap className="size-4" />
                  {zh ? '启动智能诊断' : 'Start diagnosis'}
                </Button>
              </div>
            </div>
          </div>
        </AssistantArticle>
      )}

      {loading && (
        <>
          <UserArticle>{zh ? '启动智能诊断（四个认知模块 + System 异常检查）' : 'Start AgentDebug diagnosis'}</UserArticle>
          <AssistantArticle meta={zh ? '诊断进行中' : 'Running diagnosis'}>
            <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-[14.5px] font-bold tracking-tight text-foreground">AgentDebug · {zh ? '原方案两阶段诊断' : 'Original two-phase pipeline'}</div>
                  <div className="mt-0.5 text-[11.5px] text-foreground-muted">{zh ? '正在抽取 Memory / Reflection / Planning / Action 与 System 模块，并进入 Phase 2 根因联合定位。' : 'Extracting Memory / Reflection / Planning / Action and System modules, then Phase 2 critical-error analysis.'}</div>
                </div>
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
              <div className="space-y-2">
                {MODULES.map((item) => (
                  <ProgressRow key={item.key} label={`${item.en} · ${zh ? item.zh : item.key}`} />
                ))}
              </div>
              <div className="mt-4 border-t border-border pt-3 text-[11.5px] text-foreground-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-primary" />
                  {zh ? '载入 Execution.interactions · 映射左侧节点 · 调用 AgentDebug detector' : 'Loading interactions · mapping trace nodes · calling AgentDebug detectors'}
                </span>
              </div>
            </div>
          </AssistantArticle>
        </>
      )}

      {error && !loading && (
        <AssistantArticle meta={zh ? '诊断失败' : 'Diagnosis failed'}>
          <div className="flex items-start gap-2 rounded-lg border border-error-border bg-error-subtle p-4 text-sm text-error">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{zh ? 'AgentDebug 运行失败' : 'AgentDebug failed'}</div>
              <div className="mt-1 break-words text-xs leading-5">{error}</div>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => run(true)}>
                <RefreshCw className="size-3.5" />
                {zh ? '重试' : 'Retry'}
              </Button>
            </div>
          </div>
        </AssistantArticle>
      )}

      {report && !loading && (
        <AssistantArticle meta={`${zh ? '诊断完成' : 'Done'} · ${formatDuration(report.stats.durationMs, zh)} · ${zh ? '智能诊断 Agent' : 'diagnosis agent'}`}>
          <ReportView report={report} zh={zh} traceExplicitErrors={traceExplicitErrors} onNodeRefClick={onNodeRefClick} onRerun={() => run(true)} />
        </AssistantArticle>
      )}
    </div>
  );
}

function ReportView({ report, zh, traceExplicitErrors, onNodeRefClick, onRerun }: {
  report: AgentDebugReportPayload;
  zh: boolean;
  traceExplicitErrors: TraceExplicitError[];
  onNodeRefClick?: (nodeId: string) => void;
  onRerun: () => void;
}) {
  const root = report.rootCause;
  const visiblePhase1Grid = useMemo(() => filterVisiblePhase1Cells(report.phase1Grid || [], root), [report.phase1Grid, root]);
  const otherPhase1Grid = useMemo(() => filterOtherPhase1Cells(report.phase1Grid || [], root), [report.phase1Grid, root]);
  const hiddenIssueCount = otherPhase1Grid.length;
  const [moduleSectionExpanded, setModuleSectionExpanded] = useState(false);
  const [findingDetailsExpanded, setFindingDetailsExpanded] = useState(false);
  const cascadingChain = useMemo(() => visibleCascade(root), [root]);
  const findingNarrative = useMemo(() => splitFindingSummary(root?.summary || ''), [root?.summary]);
  const visibleIssueCount = visiblePhase1Grid.length + traceExplicitErrors.length;

  if (report.skippedReason) {
    return (
      <div className="rounded-lg border border-card-border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <StatusBadge status="warning" label={zh ? '未运行' : 'Skipped'} />
          <span className="text-sm font-semibold text-foreground">AgentDebug</span>
        </div>
        <p className="text-sm leading-6 text-foreground-muted">{report.skippedReason}</p>
      </div>
    );
  }

  if (report.triage?.shortCircuited && report.triage.fatalDiagnosis) {
    return (
      <FatalDiagnosisCard
        report={report}
        zh={zh}
        onNodeRefClick={onNodeRefClick}
        onRerun={onRerun}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-card-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg border border-error-border bg-error-subtle text-error">
              <AlertTriangle className="size-3.5" />
            </div>
            <div>
              <div className="text-[10.5px] font-bold tracking-[0.14em] text-error">{zh ? '关键诊断发现' : 'KEY DIAGNOSTIC FINDING'}</div>
              <div className="mt-0.5 text-sm font-bold tracking-tight text-foreground">
                {root ? `${formatRootLocation(root, zh)} · ${formatModule(root.criticalModule, zh)}` : (zh ? '未发现明确关键问题' : 'No clear key finding')}
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onRerun}>
            <RefreshCw className="size-3.5" />
            {zh ? '重新诊断' : 'Rerun'}
          </Button>
        </div>

        {root ? (
          <>
            <StatusBadge status="error" label={formatErrorType(root.criticalErrorType, zh)} />
            <div className="mt-3">
              <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '结论' : 'Conclusion'}</div>
              <ExpandableText
                maxLines={3}
                className="text-[13px] leading-7 text-foreground"
                expandLabel={zh ? '展开完整结论' : 'Show full conclusion'}
                collapseLabel={zh ? '收起结论' : 'Collapse conclusion'}
              >
                {sanitizeConclusionText(findingNarrative.conclusion)}
              </ExpandableText>
            </div>

            <Button className="mt-3 h-7 px-0 text-[11.5px]" variant="link" size="sm" onClick={() => setFindingDetailsExpanded(value => !value)}>
              {findingDetailsExpanded ? (zh ? '收起证据与建议' : 'Hide evidence and guidance') : (zh ? '展开证据与建议' : 'Show evidence and guidance')}
              {findingDetailsExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </Button>

            {findingDetailsExpanded && (
              <div className="mt-3 space-y-3 border-t border-border pt-3">
                {root.evidence && (
                  <section>
                    <div className="mb-1.5 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '关键证据' : 'Key evidence'}</div>
                    <p className="rounded-md border border-border bg-background-secondary p-2 font-mono text-[11.5px] leading-5 text-foreground-muted">{sanitizeReportText(root.evidence)}</p>
                  </section>
                )}
                {findingNarrative.details && (
                  <section>
                    <div className="mb-1.5 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '分析说明' : 'Analysis notes'}</div>
                    <ExpandableText
                      maxLines={4}
                      className="text-[12px] leading-6 text-foreground-muted"
                      expandLabel={zh ? '展开完整说明' : 'Show full notes'}
                      collapseLabel={zh ? '收起说明' : 'Collapse notes'}
                    >
                      {sanitizeReportText(findingNarrative.details)}
                    </ExpandableText>
                  </section>
                )}
                {cascadingChain.length > 0 && (
                  <section>
                    <div className="mb-1.5 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '影响与级联' : 'Impact and cascade'}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {cascadingChain.map((item, index) => (
                        <span key={`${locationKey(item)}-${index}`} className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={!item.anchorId || !onNodeRefClick}
                            onClick={() => item.anchorId && onNodeRefClick?.(item.anchorId)}
                            className="rounded-md border border-border bg-background-secondary px-2 py-1 font-mono text-[11px] font-semibold text-primary disabled:cursor-default"
                          >
                            {formatTraceLocation(item, zh)} {formatModule(item.module, zh)}
                          </button>
                          {index < cascadingChain.length - 1 && <ChevronRight className="size-3 text-foreground-muted" />}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
                <section className="rounded-lg border border-border bg-background-secondary px-3 py-2.5">
                  <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '修复建议' : 'Correction guidance'}</div>
                  <div className="text-[12.5px] leading-6 text-foreground">{sanitizeReportText(root.correctionGuidance)}</div>
                </section>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-foreground-muted">{zh ? 'Phase 1 未检测到足够明确的问题。' : 'Phase 1 did not find a clear issue.'}</p>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-card-border bg-card shadow-sm">
        <button
          type="button"
          aria-expanded={moduleSectionExpanded}
          onClick={() => setModuleSectionExpanded(value => !value)}
          className="flex w-full items-center gap-2 px-3 py-3 text-left text-[11.5px] font-bold tracking-[0.14em] text-foreground-muted outline-none hover:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span>{zh ? '模块级诊断结果' : 'MODULE-LEVEL DIAGNOSIS RESULTS'}</span>
          <span className="h-px min-w-4 flex-1 bg-border" />
          <span className="normal-case tracking-normal">
            {zh
              ? `${visibleIssueCount} 个发现 · ${report.stats.stepCount} 个执行片段`
              : `${visibleIssueCount} findings · ${report.stats.stepCount} execution slices`}
          </span>
          <span className="normal-case tracking-normal">{report.modelLabel || 'model'}</span>
          {moduleSectionExpanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        </button>
        {moduleSectionExpanded && (
          <div className="space-y-3 border-t border-border p-3">
            <div className="grid gap-3 md:grid-cols-2">
              {MODULES.map(item => (
                <ModuleFindingCard
                  key={item.key}
                  module={item}
                  count={visiblePhase1Grid.filter(cell => cell.module === item.key).length}
                  zh={zh}
                  root={root}
                  cells={visiblePhase1Grid.filter(cell => cell.module === item.key)}
                  traceExplicitErrors={item.key === 'system' ? traceExplicitErrors : []}
                  onNodeRefClick={onNodeRefClick}
                />
              ))}
            </div>
            <OtherFindingsSection
              cells={otherPhase1Grid}
              zh={zh}
              onNodeRefClick={onNodeRefClick}
            />

            <div className="rounded-lg border border-border bg-background-secondary p-3 text-xs text-foreground-muted">
              {hiddenIssueCount > 0
                ? (zh
                  ? `当前仅展示关键发现相关问题；${hiddenIssueCount} 个已恢复或旁支问题未展示 · 分析 ${report.stats.stepCount} 个执行片段`
                  : `Showing key-finding issues only; ${hiddenIssueCount} recovered or side issues hidden · ${report.stats.stepCount} execution slices`)
                : (zh
                  ? `Phase 1 展示 ${visibleIssueCount} 个问题 · 分析 ${report.stats.stepCount} 个执行片段`
                  : `${visibleIssueCount} issues shown · ${report.stats.stepCount} execution slices`)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FatalDiagnosisCard({ report, zh, onNodeRefClick, onRerun }: {
  report: AgentDebugReportPayload;
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
  onRerun: () => void;
}) {
  const fatal = report.triage?.fatalDiagnosis;
  if (!fatal) return null;
  return (
    <div className="rounded-lg border border-error-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg border border-error-border bg-error-subtle text-error">
            <AlertTriangle className="size-3.5" />
          </div>
          <div>
            <div className="text-[10.5px] font-bold tracking-[0.14em] text-error">{zh ? '明显失败' : 'FATAL DIAGNOSIS'}</div>
            <div className="mt-0.5 text-sm font-bold tracking-tight text-foreground">
              {formatTriageCategory(report.triage?.category || 'normal', zh)}
              {fatal.toolName ? ` · ${fatal.toolName}` : ''}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onRerun}>
          <RefreshCw className="size-3.5" />
          {zh ? '重新诊断' : 'Rerun'}
        </Button>
      </div>
      <StatusBadge status="error" label={fatal.errorType} />
      <p className="mt-3 text-[13px] leading-7 text-foreground">{fatal.summary}</p>
      {(fatal.affectedTraceStepIndexes?.length || fatal.affectedSteps.length) > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-muted">
          <span className="font-semibold">{zh ? '受影响左侧节点' : 'Affected trace nodes'}</span>
          {(fatal.affectedTraceStepIndexes?.length ? fatal.affectedTraceStepIndexes : fatal.affectedSteps).map(step => (
            <span key={step} className="rounded-md border border-border bg-background-secondary px-2 py-1 font-mono text-foreground">
              {formatNodeIndex(step, zh)}
            </span>
          ))}
        </div>
      )}
      {fatal.rawErrorEvidence && (
        <p className="mt-3 rounded-md border border-border bg-background-secondary p-2 font-mono text-[11.5px] leading-5 text-foreground-muted">{fatal.rawErrorEvidence}</p>
      )}
      <div className="mt-3 rounded-lg border border-border bg-background-secondary px-3 py-2.5">
        <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '建议' : 'Recommendation'}</div>
        <div className="text-[12.5px] leading-6 text-foreground">{fatal.recommendation}</div>
      </div>
      {fatal.anchorId && onNodeRefClick && (
        <Button className="mt-3" variant="ghost" size="sm" onClick={() => onNodeRefClick(fatal.anchorId!)}>
          {zh ? '跳到左侧节点' : 'View trace node'}
          <ChevronRight className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function ModulePreview() {
  return (
    <div className="hidden grid-cols-2 gap-1.5 md:grid">
      {MODULES.slice(0, 4).map(item => {
        const Icon = MODULE_ICONS[item.key] || Eye;
        return (
          <div key={item.key} className="flex w-[100px] items-center gap-1.5 rounded-lg border border-border bg-background-secondary px-2 py-1.5 text-foreground">
            <Icon className="size-3" />
            <span className="text-[10.5px] font-bold">{item.en}</span>
          </div>
        );
      })}
    </div>
  );
}

function ModuleTitle({ title, help }: { title: string; help: string }) {
  return (
    <div className="flex items-center gap-1 text-sm font-bold text-foreground">
      <span>{title}</span>
      <TermPopover term={title} tag="fault" body={help} side="top" align="center">
        <span className="sr-only">{title}</span>
      </TermPopover>
    </div>
  );
}

function OtherFindingsSection({ cells, zh, onNodeRefClick }: {
  cells: AgentDebugPhase1Cell[];
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const orderedCells = useMemo(() => orderModuleCells(cells, null), [cells]);
  if (orderedCells.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-background-secondary p-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="text-[12px] font-bold text-foreground">{zh ? '其他发现' : 'Other findings'}</span>
        <StatusBadge status="warning" label={`${orderedCells.length}`} />
        <span className="min-w-0 flex-1 text-[11.5px] text-foreground-muted">
          {zh ? '已恢复或旁支问题，不作为上方关键诊断发现' : 'Recovered or side issues, not the key finding above'}
        </span>
        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-foreground-muted" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {orderedCells.map(cell => (
            <div key={`${locationKey(cell)}-${cell.module}-${cell.errorType}-${cell.anchorId || ''}`} className="rounded-md border border-border bg-card px-2.5 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-background-secondary px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">{formatTraceLocation(cell, zh)}</span>
                <StatusBadge status={cell.severity === 'high' ? 'error' : 'warning'} label={formatModule(cell.module, zh)} />
                <StatusBadge status={cell.severity === 'high' ? 'error' : 'warning'} label={formatErrorType(cell.errorType, zh)} />
                <span className="rounded bg-background-secondary px-1.5 py-0.5 text-[10.5px] font-semibold text-foreground-muted">{zh ? '旁支/已恢复' : 'Side/recovered'}</span>
              </div>
              <ExpandableText
                maxLines={4}
                className="text-[11.5px] leading-5 text-foreground-muted"
                expandLabel={zh ? '展开完整原因' : 'Show full reason'}
                collapseLabel={zh ? '收起原因' : 'Collapse reason'}
              >
                {cell.reasoning || cell.evidence}
              </ExpandableText>
              {cell.evidence && cell.reasoning && (
                <ExpandableText
                  maxLines={3}
                  className="mt-1.5 font-mono text-[10.5px] leading-5 text-foreground-muted"
                  expandLabel={zh ? '展开证据原文' : 'Show evidence'}
                  collapseLabel={zh ? '收起证据原文' : 'Collapse evidence'}
                >
                  {cell.evidence}
                </ExpandableText>
              )}
              {cell.anchorId && onNodeRefClick && (
                <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(cell.anchorId!)}>
                  {zh ? '跳到左侧节点' : 'View trace node'}
                  <ChevronRight className="size-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModuleFindingCard({ module, count, zh, root, cells, traceExplicitErrors = [], onNodeRefClick }: {
  module: { key: AgentDebugModule; zh: string; en: string };
  count: number;
  zh: boolean;
  root: AgentDebugRootCause | null;
  cells: AgentDebugPhase1Cell[];
  traceExplicitErrors?: TraceExplicitError[];
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const Icon = MODULE_ICONS[module.key] || Eye;
  const [expanded, setExpanded] = useState(false);
  const orderedCells = useMemo(() => orderModuleCells(cells, root), [cells, root]);
  const orderedTraceErrors = useMemo(() => [...traceExplicitErrors].sort((a, b) => (a.traceStepIndex ?? Number.MAX_SAFE_INTEGER) - (b.traceStepIndex ?? Number.MAX_SAFE_INTEGER)), [traceExplicitErrors]);
  const primary = orderedCells[0];
  const primaryTraceError = orderedTraceErrors[0];
  const totalCount = count + orderedTraceErrors.length;
  return (
    <div className="rounded-lg border border-card-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg border border-border bg-background-secondary text-primary">
            <Icon className="size-3.5" />
          </div>
          <div>
            <ModuleTitle
              title={module.en}
              help={(zh ? MODULE_HELP[module.key]?.zh : MODULE_HELP[module.key]?.en) || module.key}
            />
            <div className="text-[11px] text-foreground-muted">{zh ? module.zh : module.key}</div>
          </div>
        </div>
        <StatusBadge status={totalCount > 0 ? 'warning' : 'success'} label={totalCount > 0 ? `${totalCount}` : 'OK'} />
      </div>
      <ExpandableText
        maxLines={3}
        className="mt-3 text-[12.5px] leading-6 text-foreground-muted"
        expandLabel={zh ? '展开完整摘要' : 'Show full summary'}
        collapseLabel={zh ? '收起摘要' : 'Collapse summary'}
      >
        {primary
          ? `${formatErrorType(primary.errorType, zh)}: ${primary.reasoning || primary.evidence}`
          : primaryTraceError
            ? `${primaryTraceError.title}: ${primaryTraceError.description || primaryTraceError.context || (zh ? '当前 trace 已记录明确报错。' : 'This trace includes an explicit error.')}`
            : (zh ? '未检测到该模块的明确问题。' : 'No clear issue detected in this module.')}
      </ExpandableText>
      {totalCount > 0 && !expanded && (
        <Button className="mt-2 h-7 px-0 text-[11.5px]" variant="link" size="sm" onClick={() => setExpanded(true)}>
          {totalCount === 1
            ? (zh ? '查看问题详情' : 'Show issue details')
            : (zh ? `查看全部 ${totalCount} 个问题` : `Show all ${totalCount} issues`)}
          <ChevronDown className="size-3" />
        </Button>
      )}
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {orderedCells.map(cell => (
            <div key={`${locationKey(cell)}-${cell.module}-${cell.errorType}-${cell.anchorId || ''}`} className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">{formatTraceLocation(cell, zh)}</span>
                <StatusBadge status={cell.severity === 'high' ? 'error' : 'warning'} label={formatErrorType(cell.errorType, zh)} />
                {isRootCell(root, cell) && (
                  <span className="rounded bg-error-subtle px-1.5 py-0.5 text-[10.5px] font-semibold text-error">{zh ? '关键发现相关' : 'Key finding'}</span>
                )}
              </div>
              <ExpandableText
                maxLines={4}
                className="text-[11.5px] leading-5 text-foreground-muted"
                expandLabel={zh ? '展开完整原因' : 'Show full reason'}
                collapseLabel={zh ? '收起原因' : 'Collapse reason'}
              >
                {cell.reasoning || cell.evidence}
              </ExpandableText>
              {cell.evidence && cell.reasoning && (
                <ExpandableText
                  maxLines={3}
                  className="mt-1.5 font-mono text-[10.5px] leading-5 text-foreground-muted"
                  expandLabel={zh ? '展开证据原文' : 'Show evidence'}
                  collapseLabel={zh ? '收起证据原文' : 'Collapse evidence'}
                >
                  {cell.evidence}
                </ExpandableText>
              )}
              {cell.anchorId && onNodeRefClick && (
                <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(cell.anchorId!)}>
                  {zh ? '跳到左侧节点' : 'View trace node'}
                  <ChevronRight className="size-3" />
                </Button>
              )}
            </div>
          ))}
          {orderedTraceErrors.map(error => (
            <div key={error.id} className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">{formatTraceLocation(error, zh)}</span>
                <StatusBadge status="warning" label={error.title} />
              </div>
              {(error.description || error.context) && (
                <ExpandableText
                  maxLines={4}
                  className="text-[11.5px] leading-5 text-foreground-muted"
                  expandLabel={zh ? '展开详情' : 'Show details'}
                  collapseLabel={zh ? '收起详情' : 'Collapse details'}
                >
                  {[error.description, error.context].filter(Boolean).join('\n')}
                </ExpandableText>
              )}
              {error.recovery && (
                <ExpandableText
                  maxLines={3}
                  className="mt-1.5 text-[11px] leading-5 text-foreground-muted"
                  expandLabel={zh ? '展开建议' : 'Show guidance'}
                  collapseLabel={zh ? '收起建议' : 'Collapse guidance'}
                >
                  {error.recovery}
                </ExpandableText>
              )}
              {error.anchorId && onNodeRefClick && (
                <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(error.anchorId!)}>
                  {zh ? '跳到左侧节点' : 'View trace node'}
                  <ChevronRight className="size-3" />
                </Button>
              )}
            </div>
          ))}
          <Button className="h-7 px-0 text-[11.5px]" variant="link" size="sm" onClick={() => setExpanded(false)}>
            {zh ? '收起问题列表' : 'Collapse issues'}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProgressRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background-secondary text-primary">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-bold text-foreground">{label}</span>
          <span className="text-[11px] text-primary">分析中</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-background-secondary">
          <div className="h-full w-2/3 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}

function AssistantArticle({ children, meta }: { children: ReactNode; meta?: string }) {
  return (
    <article className="flex items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary-subtle-border bg-primary-subtle text-primary">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        {meta && <div className="mb-1.5 text-[11px] text-foreground-muted">{meta}</div>}
        <div className="max-w-[860px]">{children}</div>
      </div>
    </article>
  );
}

function UserArticle({ children }: { children: ReactNode }) {
  return (
    <article className="flex justify-end gap-3">
      <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-[13.5px] leading-6 text-primary-foreground">
        {children}
      </div>
    </article>
  );
}

function filterVisiblePhase1Cells(cells: AgentDebugPhase1Cell[], root: AgentDebugRootCause | null): AgentDebugPhase1Cell[] {
  const detected = cells.filter(cell => cell.errorDetected);
  if (!root) return detected;

  const visibleKeys = visibleIssueKeys(root);

  const filtered = detected.filter(cell => visibleKeys.has(moduleStepKey(locationIndex(cell), cell.module)));
  return filtered.length > 0 ? filtered : detected;
}

function filterOtherPhase1Cells(cells: AgentDebugPhase1Cell[], root: AgentDebugRootCause | null): AgentDebugPhase1Cell[] {
  const detected = cells.filter(cell => cell.errorDetected);
  if (!root) return [];
  const visibleKeys = visibleIssueKeys(root);
  const visibleCells = detected.filter(cell => visibleKeys.has(moduleStepKey(locationIndex(cell), cell.module)));
  if (visibleCells.length === 0) return [];
  return detected.filter(cell => !visibleKeys.has(moduleStepKey(locationIndex(cell), cell.module)));
}

function visibleIssueKeys(root: AgentDebugRootCause): Set<string> {
  const visibleKeys = new Set<string>();
  if (root.criticalModule !== 'unknown') {
    visibleKeys.add(moduleStepKey(locationIndex(rootTraceLocation(root)), root.criticalModule));
  }
  for (const item of visibleCascade(root)) {
    visibleKeys.add(moduleStepKey(locationIndex(item), item.module));
  }
  return visibleKeys;
}

function moduleStepKey(index: number | null, module: AgentDebugModule): string {
  return `${index ?? 'unknown'}:${module}`;
}

function orderModuleCells(cells: AgentDebugPhase1Cell[], root: AgentDebugRootCause | null): AgentDebugPhase1Cell[] {
  return [...cells].sort((a, b) => {
    const aRoot = isRootCell(root, a) ? 1 : 0;
    const bRoot = isRootCell(root, b) ? 1 : 0;
    if (aRoot !== bRoot) return bRoot - aRoot;
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return (locationIndex(a) ?? a.step) - (locationIndex(b) ?? b.step);
  });
}

function visibleCascade(root: AgentDebugRootCause | null): AgentDebugRootCause['cascadingChain'] {
  if (!root) return [];
  const rootIndex = locationIndex(rootTraceLocation(root));
  return [...root.cascadingChain]
    .filter(item => {
      const index = locationIndex(item);
      if (index == null) return false;
      return rootIndex == null || index > rootIndex;
    })
    .sort((a, b) => (locationIndex(a) ?? a.step) - (locationIndex(b) ?? b.step));
}

function isRootCell(root: AgentDebugRootCause | null, cell: AgentDebugPhase1Cell): boolean {
  if (!root || root.criticalModule !== cell.module) return false;
  return locationIndex(rootTraceLocation(root)) === locationIndex(cell);
}

function rootTraceLocation(root: AgentDebugRootCause): AgentDebugTraceLocation {
  return {
    traceStepIndex: root.criticalTraceStepIndex ?? root.criticalStep ?? undefined,
    traceNodeLabel: root.criticalTraceNodeLabel,
    traceNodeKind: root.criticalTraceNodeKind,
  };
}

function formatRootLocation(root: AgentDebugRootCause, zh: boolean): string {
  return formatTraceLocation(rootTraceLocation(root), zh);
}

function formatTraceLocation(item: AgentDebugTraceLocation, zh: boolean): string {
  const index = locationIndex(item);
  const prefix = index == null ? (zh ? '左侧节点' : 'Trace node') : formatNodeIndex(index, zh);
  const label = item.traceNodeLabel ? ` · ${truncateLabel(item.traceNodeLabel)}` : '';
  return `${prefix}${label}`;
}

function formatNodeIndex(index: number, zh: boolean): string {
  return zh ? `节点 #${index}` : `Node #${index}`;
}

function locationKey(item: AgentDebugTraceLocation & { step?: number }): string {
  return String(locationIndex(item) ?? item.step ?? 'unknown');
}

function locationIndex(item: AgentDebugTraceLocation): number | null {
  return item.traceStepIndex ?? null;
}

function truncateLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}...` : trimmed;
}

function sanitizeReportText(value: string): string {
  return (value || '')
    .replace(/步骤\s*\d+\s*[（(]\s*左侧节点\s*#(\d+)\s*[）)]/g, '左侧节点 #$1')
    .replace(/第\s*\d+\s*步\s*[（(]\s*左侧节点\s*#(\d+)\s*[）)]/g, '左侧节点 #$1')
    .replace(/步骤\s*\d+/g, '相关节点')
    .replace(/第\s*\d+\s*步/g, '相关节点');
}

function sanitizeConclusionText(value: string): string {
  return sanitizeReportText(value)
    .replace(/根本原因/g, '关键发现')
    .replace(/根因为/g, '关键发现是')
    .replace(/根因是/g, '关键发现是')
    .replace(/作为根因/g, '作为关键发现')
    .replace(/根因/g, '关键发现');
}

function splitFindingSummary(value: string): { conclusion: string; details: string } {
  const sentences = splitSentences(value);
  if (sentences.length <= 2) return { conclusion: value, details: '' };
  return {
    conclusion: sentences.slice(0, 2).join(''),
    details: sentences.slice(2).join(''),
  };
}

function splitSentences(value: string): string[] {
  const matches = (value || '').trim().match(/[^。！？.!?]+[。！？.!?]?/g);
  return matches?.map(item => item.trim()).filter(Boolean) || [];
}

function formatDuration(ms: number, zh: boolean): string {
  if (!Number.isFinite(ms) || ms < 0) return zh ? '未知耗时' : 'unknown duration';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const secondText = formatSeconds(seconds);
  if (hours > 0) {
    return zh ? `${hours}小时${minutes}分${secondText}秒` : `${hours}h ${minutes}m ${secondText}s`;
  }
  if (minutes > 0) {
    return zh ? `${minutes}分${secondText}秒` : `${minutes}m ${secondText}s`;
  }
  return zh ? `${secondText}秒` : `${secondText}s`;
}

function formatSeconds(value: number): string {
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function severityRank(severity: AgentDebugPhase1Cell['severity']): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function formatModule(module: AgentDebugModule, zh: boolean) {
  if (zh) return MODULE_LABEL_ZH[module] || module;
  return module;
}

function formatTriageCategory(category: string, zh: boolean) {
  if (!zh) return category;
  if (category === 'infra') return '基础设施级失败';
  if (category === 'tool_systemic') return '工具系统性失败';
  if (category === 'early_fatal') return '早期不可恢复失败';
  return '正常预检';
}

function formatErrorType(errorType: string, zh: boolean) {
  if (!zh) return errorType;
  const label = ERROR_TYPE_LABEL_ZH[errorType] || errorType;
  return label === errorType ? errorType : `${label} (${errorType})`;
}
