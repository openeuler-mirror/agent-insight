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
import { apiFetch } from '@/lib/client/api';
import type { AgentDebugModule, AgentDebugPhase1Cell, AgentDebugReportPayload, AgentDebugRootCause } from '@/lib/engine/agent-debug/types';

interface AgentDebugCardProps {
  executionId: string;
  user: string;
  locale: string;
  suggested: boolean;
  onNodeRefClick?: (nodeId: string) => void;
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

export function AgentDebugCard({ executionId, user, locale, suggested, onNodeRefClick }: AgentDebugCardProps) {
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

  if (!suggested && !report && !error && !loading) return null;

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
                      ? '按 AgentDebug 原方案，将每个 Step 抽取为 Memory / Reflection / Planning / Action 四个认知模块；System 作为外部工具/环境异常单独检查，再进入 Phase 2 定位真正根因。'
                      : 'Use the original AgentDebug pipeline: decompose each step into four cognitive modules, check System errors separately, then identify the critical root cause.'}
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
                  {zh ? '载入 Execution.interactions · 拆分 step · 调用 AgentDebug detector' : 'Loading interactions · splitting steps · calling AgentDebug detectors'}
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
        <AssistantArticle meta={`${zh ? '诊断完成' : 'Done'} · ${report.stats.durationMs}ms · ${zh ? '智能诊断 Agent' : 'diagnosis agent'}`}>
          <ReportView report={report} zh={zh} onNodeRefClick={onNodeRefClick} onRerun={() => run(true)} />
        </AssistantArticle>
      )}
    </div>
  );
}

function ReportView({ report, zh, onNodeRefClick, onRerun }: {
  report: AgentDebugReportPayload;
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
  onRerun: () => void;
}) {
  const root = report.rootCause;
  const visiblePhase1Grid = useMemo(() => filterVisiblePhase1Cells(report.phase1Grid || [], root), [report.phase1Grid, root]);
  const hiddenIssueCount = Math.max(0, (report.phase1Grid || []).filter(cell => cell.errorDetected).length - visiblePhase1Grid.length);

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
              <div className="text-[10.5px] font-bold tracking-[0.14em] text-error">{zh ? '根本原因' : 'ROOT CAUSE · Critical error'}</div>
              <div className="mt-0.5 text-sm font-bold tracking-tight text-foreground">
                {root ? `${zh ? '第' : 'Step'} ${root.criticalStep ?? '-'} · ${formatModule(root.criticalModule, zh)}` : (zh ? '未发现明确根因' : 'No clear root cause')}
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
            <p className="mt-3 text-[13px] leading-7 text-foreground">{root.summary}</p>
            {root.evidence && <p className="mt-2 rounded-md border border-border bg-background-secondary p-2 font-mono text-[11.5px] leading-5 text-foreground-muted">{root.evidence}</p>}
            {root.cascadingChain.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '级联链路' : 'Cascading effects'}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {root.cascadingChain.map((item, index) => (
                    <span key={`${item.step}-${index}`} className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        disabled={!item.anchorId || !onNodeRefClick}
                        onClick={() => item.anchorId && onNodeRefClick?.(item.anchorId)}
                        className="rounded-md border border-border bg-background-secondary px-2 py-1 font-mono text-[11px] font-semibold text-primary disabled:cursor-default"
                      >
                        S{item.step} {formatModule(item.module, zh)}
                      </button>
                      {index < root.cascadingChain.length - 1 && <ChevronRight className="size-3 text-foreground-muted" />}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 rounded-lg border border-border bg-background-secondary px-3 py-2.5">
              <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '修复建议' : 'Correction guidance'}</div>
              <div className="text-[12.5px] leading-6 text-foreground">{root.correctionGuidance}</div>
            </div>
          </>
        ) : (
          <p className="text-sm text-foreground-muted">{zh ? 'Phase 1 未检测到足够明确的问题。' : 'Phase 1 did not find a clear error.'}</p>
        )}
      </div>

      <div className="flex items-center gap-2 text-[11.5px] font-bold tracking-[0.14em] text-foreground-muted">
        <span>{zh ? '认知与系统模块发现' : 'COGNITIVE & SYSTEM FINDINGS'}</span>
        <span className="h-px flex-1 bg-border" />
        <span className="normal-case tracking-normal">{report.modelLabel || 'model'}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {MODULES.map(item => (
          <ModuleFindingCard
            key={item.key}
            module={item}
            count={visiblePhase1Grid.filter(cell => cell.module === item.key).length}
            zh={zh}
            root={root}
            cells={visiblePhase1Grid.filter(cell => cell.module === item.key)}
            onNodeRefClick={onNodeRefClick}
          />
        ))}
      </div>

      <div className="rounded-lg border border-card-border bg-card p-3 text-xs text-foreground-muted shadow-sm">
        <div className="text-xs text-foreground-muted">
          {hiddenIssueCount > 0
            ? (zh
              ? `当前仅展示根因链路相关问题；${hiddenIssueCount} 个已恢复或旁支问题未展示 · 分析 ${report.stats.stepCount} 个诊断 Step`
              : `Showing root-chain issues only; ${hiddenIssueCount} recovered or side issues hidden · ${report.stats.stepCount} diagnostic steps`)
            : (zh
              ? `Phase 1 展示 ${visiblePhase1Grid.length} 个问题 · 分析 ${report.stats.stepCount} 个诊断 Step`
              : `${visiblePhase1Grid.length} issues shown · ${report.stats.stepCount} diagnostic steps`)}
        </div>
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
      {fatal.affectedSteps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-muted">
          <span className="font-semibold">{zh ? '受影响诊断 Step' : 'Affected steps'}</span>
          {fatal.affectedSteps.map(step => (
            <span key={step} className="rounded-md border border-border bg-background-secondary px-2 py-1 font-mono text-foreground">
              S{step}
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
          {zh ? '跳到原始证据' : 'View evidence'}
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

function ModuleFindingCard({ module, count, zh, root, cells, onNodeRefClick }: {
  module: { key: AgentDebugModule; zh: string; en: string };
  count: number;
  zh: boolean;
  root: AgentDebugRootCause | null;
  cells: AgentDebugPhase1Cell[];
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const Icon = MODULE_ICONS[module.key] || Eye;
  const [expanded, setExpanded] = useState(false);
  const orderedCells = useMemo(() => orderModuleCells(cells, root), [cells, root]);
  const primary = orderedCells[0];
  const extraCount = Math.max(0, count - 1);
  return (
    <div className="rounded-lg border border-card-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg border border-border bg-background-secondary text-primary">
            <Icon className="size-3.5" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">{module.en}</div>
            <div className="text-[11px] text-foreground-muted">{zh ? module.zh : module.key}</div>
          </div>
        </div>
        <StatusBadge status={count > 0 ? 'warning' : 'success'} label={count > 0 ? `${count}` : 'OK'} />
      </div>
      <p className="mt-3 line-clamp-3 text-[12.5px] leading-6 text-foreground-muted">
        {primary ? `${formatErrorType(primary.errorType, zh)}: ${primary.reasoning || primary.evidence}` : (zh ? '未检测到该模块的明确问题。' : 'No clear issue detected in this module.')}
      </p>
      {extraCount > 0 && !expanded && (
        <Button className="mt-2 h-7 px-0 text-[11.5px]" variant="link" size="sm" onClick={() => setExpanded(true)}>
          {zh ? `查看全部 ${count} 个问题` : `Show all ${count} issues`}
          <ChevronDown className="size-3" />
        </Button>
      )}
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {orderedCells.map(cell => (
            <div key={`${cell.step}-${cell.module}-${cell.errorType}-${cell.anchorId || ''}`} className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">S{cell.step}</span>
                <StatusBadge status={cell.severity === 'high' ? 'error' : 'warning'} label={formatErrorType(cell.errorType, zh)} />
                {root && root.criticalStep === cell.step && root.criticalModule === cell.module && (
                  <span className="rounded bg-error-subtle px-1.5 py-0.5 text-[10.5px] font-semibold text-error">{zh ? '根因相关' : 'Root cause'}</span>
                )}
              </div>
              <div className="text-[11.5px] leading-5 text-foreground-muted">{cell.reasoning || cell.evidence}</div>
              {cell.evidence && cell.reasoning && (
                <div className="mt-1.5 font-mono text-[10.5px] leading-5 text-foreground-muted">{cell.evidence}</div>
              )}
              {cell.anchorId && onNodeRefClick && (
                <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(cell.anchorId!)}>
                  {zh ? '跳到证据节点' : 'View evidence'}
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
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-foreground">Insight AI</span>
          {meta && <span className="text-[11px] text-foreground-muted">{meta}</span>}
        </div>
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

  const visibleKeys = new Set<string>();
  if (root.criticalStep != null && root.criticalModule !== 'unknown') {
    visibleKeys.add(moduleStepKey(root.criticalStep, root.criticalModule));
  }
  for (const item of root.cascadingChain || []) {
    visibleKeys.add(moduleStepKey(item.step, item.module));
  }

  const filtered = detected.filter(cell => visibleKeys.has(moduleStepKey(cell.step, cell.module)));
  return filtered.length > 0 ? filtered : detected;
}

function moduleStepKey(step: number, module: AgentDebugModule): string {
  return `${step}:${module}`;
}

function orderModuleCells(cells: AgentDebugPhase1Cell[], root: AgentDebugRootCause | null): AgentDebugPhase1Cell[] {
  return [...cells].sort((a, b) => {
    const aRoot = root && root.criticalStep === a.step && root.criticalModule === a.module ? 1 : 0;
    const bRoot = root && root.criticalStep === b.step && root.criticalModule === b.module ? 1 : 0;
    if (aRoot !== bRoot) return bRoot - aRoot;
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return a.step - b.step;
  });
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
  return '未短路';
}

function formatErrorType(errorType: string, zh: boolean) {
  if (!zh) return errorType;
  const label = ERROR_TYPE_LABEL_ZH[errorType] || errorType;
  return label === errorType ? errorType : `${label} (${errorType})`;
}
