'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  RotateCcw,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { ExpandableText } from '@/components/text/ExpandableText';
import { TermPopover } from '@/components/text/TermPopover';
import { apiFetch } from '@/lib/client/api';
import type {
  AgentDebugFinding,
  AgentDebugIssue,
  AgentDebugModule,
  AgentDebugReportPayload,
  AgentDebugRootCause,
  AgentDebugSkillsAnalysis,
  AgentDebugTraceLocation,
  AgentDebugTrajectoryFinding,
} from '@/lib/engine/agent-debug/types';

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
  report?: AgentDebugReportPayload | null;
  row?: {
    status?: string;
    errorMessage?: string | null;
  } | null;
  reportId?: string;
  status?: string;
  cached?: boolean;
  error?: string;
}

interface AgentDebugSkillsAnalysisResponse {
  report?: AgentDebugReportPayload;
  skillsAnalysis?: AgentDebugSkillsAnalysis;
  row?: {
    status?: string;
    errorMessage?: string | null;
  } | null;
  status?: string;
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

const AGENT_DEBUG_POLL_MS = 3000;

function agentDebugStatus(data: AgentDebugResponse): string {
  return data.row?.status || data.status || '';
}

function isAgentDebugRunning(data: AgentDebugResponse): boolean {
  return agentDebugStatus(data) === 'running';
}

function skillsAnalysisFromResponse(data: AgentDebugSkillsAnalysisResponse): AgentDebugSkillsAnalysis | null {
  return data.skillsAnalysis || null;
}

function isSkillsAnalysisRunningResponse(data: AgentDebugSkillsAnalysisResponse): boolean {
  return skillsAnalysisFromResponse(data)?.status === 'running' || data.status === 'running';
}

const FINDING_MODULES = MODULES.filter(item => item.key !== 'system');

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
  over_simplification: '关键信息过度压缩',
  memory_retrieval_failure: '关键信息未召回',
  hallucination: '记忆幻觉',
  hallucinated_file_content: '臆造文件内容',
  stale_file_reference: '引用旧文件内容',
  forgot_user_constraint: '遗忘用户约束',
  progress_misjudge: '进展误判',
  progress_misjudgement: '进展误判',
  outcome_misinterpretation: '结果误读',
  causal_misattribution: '原因误判',
  reflection_hallucination: '反思幻觉',
  false_success_claim: '误报成功',
  missed_test_failure: '漏看测试失败',
  premature_completion: '过早完成',
  ignored_warning: '忽略重要警告',
  constraint_ignorance: '忽略约束',
  impossible_action: '不可行计划',
  inefficient_plan: '低效排查路径',
  wrong_file_target: '目标文件选错',
  missing_test_step: '缺少验证步骤',
  over_engineering: '过度设计',
  no_explicit_plan: '缺少显式计划',
  plan_action_mismatch: '计划与行动不一致',
  unsafe_destructive_action: '未确认高风险操作',
  misalignment: '动作偏离目标',
  invalid_action: '动作无法执行',
  format_error: '格式错误',
  parameter_error: '参数选择错误',
  nonexistent_path: '路径不存在',
  wrong_diff_anchor: '编辑锚点不匹配',
  dangerous_command: '危险命令',
  redundant_call: '重复调用',
  tool_misuse: '工具选择不当',
  step_limit: '步数限制',
  tool_execution_error: '工具执行错误',
  llm_limit: '模型输出限制',
  environment_error: '运行环境异常',
  context_overflow: '上下文超限',
  user_aborted: '用户/系统中断',
  auth_failure: '认证失败',
  schema_violation: '结构化输出违规',
  step_timeout: '单步超时',
  others: '其他问题',
  no_error: '未发现问题',
};

function hasUsableSkillsAnalysis(analysis?: AgentDebugSkillsAnalysis | null): boolean {
  return analysis?.status === 'done' && extractSkillsKeyActions(analysis as unknown as Record<string, unknown>).length > 0;
}

function optimisticSkillsAnalysisRunning(interactionHash?: string): AgentDebugSkillsAnalysis {
  const now = new Date().toISOString();
  return {
    status: 'running',
    source: 'agent-debug',
    generatedAt: now,
    updatedAt: now,
    interactionHash,
    errorMessage: null,
    keyActionResults: [],
  };
}

function optimisticSkillsAnalysisFailed(errorMessage: string, interactionHash?: string): AgentDebugSkillsAnalysis {
  const now = new Date().toISOString();
  return {
    status: 'failed',
    source: 'agent-debug',
    generatedAt: now,
    updatedAt: now,
    interactionHash,
    errorMessage,
    keyActionResults: [],
  };
}

export function AgentDebugCard({ executionId, user, locale, traceExplicitErrors = [], onNodeRefClick }: AgentDebugCardProps) {
  const zh = locale === 'zh';
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AgentDebugReportPayload | null>(null);
  const [skillsAnalysis, setSkillsAnalysis] = useState<AgentDebugSkillsAnalysis | null>(null);
  const [error, setError] = useState('');
  const observedRunningRef = useRef(false);
  const requestedSkillsAnalysisRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: AgentDebugResponse) => {
        if (cancelled) return;
        applyAgentDebugResponse(data);
      })
      .catch(err => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [executionId]);

  useEffect(() => {
    if (!executionId) return;
    setSkillsAnalysis(null);
    requestedSkillsAnalysisRef.current.clear();
    let cancelled = false;
    apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug/skills-analysis`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: AgentDebugSkillsAnalysisResponse) => {
        if (cancelled) return;
        applySkillsAnalysisResponse(data);
      })
      .catch(() => {
        if (!cancelled) setSkillsAnalysis(null);
      });
    return () => { cancelled = true; };
  }, [executionId]);

  useEffect(() => {
    if (!executionId || !loading) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug`);
        const data = await res.json().catch(() => ({})) as AgentDebugResponse;
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        applyAgentDebugResponse(data);
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    const timer = window.setInterval(poll, AGENT_DEBUG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [executionId, loading]);

  async function run(force = false) {
    if (!executionId || loading) return;
    observedRunningRef.current = true;
    setLoading(true);
    setError('');
    requestSkillsAnalysis(force);
    try {
      const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, force }),
      });
      const data = await res.json().catch(() => ({})) as AgentDebugResponse;
      if (res.status === 409 && isAgentDebugRunning(data)) {
        applyAgentDebugResponse(data);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      applyAgentDebugResponse(data);
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function applyAgentDebugResponse(data: AgentDebugResponse) {
    const status = agentDebugStatus(data);
    const nextReport = data.report || null;
    if (status === 'running') {
      observedRunningRef.current = true;
      setReport(nextReport);
      setError('');
      setLoading(true);
      return;
    }

    observedRunningRef.current = false;
    setLoading(false);
    setReport(nextReport);
    setError(data.row?.errorMessage || data.error || '');
  }

  function applySkillsAnalysisResponse(data: AgentDebugSkillsAnalysisResponse) {
    const nextAnalysis = skillsAnalysisFromResponse(data);
    if (nextAnalysis) {
      setSkillsAnalysis(nextAnalysis);
    } else if (!data.error && data.row?.status !== 'running') {
      setSkillsAnalysis(prev => prev?.status === 'running' ? prev : null);
    }
  }

  function requestSkillsAnalysis(force = false) {
    if (!executionId || !user) return;
    if (!force && (hasUsableSkillsAnalysis(skillsAnalysis) || skillsAnalysis?.status === 'running')) return;
    const key = `${executionId}:${force ? 'force' : 'auto'}:${skillsAnalysis?.interactionHash || ''}`;
    if (!force && requestedSkillsAnalysisRef.current.has(key)) return;
    if (force) {
      requestedSkillsAnalysisRef.current.clear();
    } else {
      requestedSkillsAnalysisRef.current.add(key);
    }
    void ensureSkillsAnalysis(force);
  }

  async function ensureSkillsAnalysis(force = false) {
    if (!executionId || !user) return;
    const currentHash = skillsAnalysis?.interactionHash;
    setSkillsAnalysis(optimisticSkillsAnalysisRunning(currentHash));
    try {
      const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug/skills-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, force }),
      });
      const data = await res.json().catch(() => ({})) as AgentDebugSkillsAnalysisResponse;
      applySkillsAnalysisResponse(data);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSkillsAnalysis(prev => optimisticSkillsAnalysisFailed(message, prev?.interactionHash || currentHash));
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
                      ? '按 AgentDebug 原方案，将每个执行片段抽取为 Memory / Reflection / Planning / Action 四个认知模块；System 作为外部工具/环境异常单独检查，再进入根因定位。'
                      : 'Use the original AgentDebug pipeline: decompose execution slices into four cognitive modules, check System errors separately, then identify the key diagnostic finding.'}
                  </p>
                </div>
                <ModulePreview />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4 text-[11.5px] text-foreground-muted">
                <span className="inline-flex items-center gap-1"><Clock className="size-3" /> {zh ? '预计 8-30s' : '8-30s expected'}</span>
                <span className="inline-flex items-center gap-1"><BrainCircuit className="size-3" /> {zh ? '初筛 + 根因定位' : 'Phase 1 + Phase 2'}</span>
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
                  <div className="text-[14.5px] font-bold tracking-tight text-foreground">AgentDebug · {zh ? '初筛 + 根因定位' : 'Original two-phase pipeline'}</div>
                  <div className="mt-0.5 text-[11.5px] text-foreground-muted">{zh ? '正在抽取 Memory / Reflection / Planning / Action 与 System 模块，并进入根因联合定位。' : 'Extracting Memory / Reflection / Planning / Action and System modules, then Phase 2 critical-error analysis.'}</div>
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
          {skillsAnalysis && (
            <AssistantArticle meta={zh ? 'Skills 分析' : 'Skills analysis'}>
              <SkillsAnalysisSection
                executionId={executionId}
                user={user}
                zh={zh}
                analysis={skillsAnalysis}
                onAnalysisUpdate={setSkillsAnalysis}
              />
            </AssistantArticle>
          )}
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
          <ReportView
            report={report}
            zh={zh}
            executionId={executionId}
            user={user}
            traceExplicitErrors={traceExplicitErrors}
            onNodeRefClick={onNodeRefClick}
            skillsAnalysis={skillsAnalysis}
            onSkillsAnalysisUpdate={setSkillsAnalysis}
            onRerun={() => run(true)}
          />
        </AssistantArticle>
      )}
    </div>
  );
}

function ReportView({ report, zh, executionId, user, traceExplicitErrors, onNodeRefClick, skillsAnalysis, onSkillsAnalysisUpdate, onRerun }: {
  report: AgentDebugReportPayload;
  zh: boolean;
  executionId: string;
  user: string;
  traceExplicitErrors: TraceExplicitError[];
  onNodeRefClick?: (nodeId: string) => void;
  skillsAnalysis: AgentDebugSkillsAnalysis | null;
  onSkillsAnalysisUpdate: (analysis: AgentDebugSkillsAnalysis | null) => void;
  onRerun: () => void;
}) {
  const findings = useMemo(() => normalizeReportFindings(report), [report]);
  const trajectoryFindings = useMemo(
    () => (Array.isArray(report.trajectoryFindings) ? report.trajectoryFindings : []),
    [report],
  );
  const [expandedFindingIds, setExpandedFindingIds] = useState<Set<string>>(() => new Set(findings[0] ? [findings[0].id] : []));
  const issueCount = report.issues.length + traceExplicitErrors.length;
  const totalFindings = findings.length + trajectoryFindings.length;

  useEffect(() => {
    setExpandedFindingIds(new Set(findings[0] ? [findings[0].id] : []));
  }, [findings]);

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
      <div className="space-y-3">
        <FatalDiagnosisCard
          report={report}
          zh={zh}
          onNodeRefClick={onNodeRefClick}
          onRerun={onRerun}
        />
        <SkillsAnalysisSection
          executionId={executionId}
          user={user}
          zh={zh}
          analysis={skillsAnalysis}
          onAnalysisUpdate={onSkillsAnalysisUpdate}
        />
      </div>
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
              <div className="text-[10.5px] font-bold tracking-[0.14em] text-error">{zh ? '关键诊断发现' : 'KEY DIAGNOSTIC FINDINGS'}</div>
              <div className="mt-0.5 text-sm font-bold tracking-tight text-foreground">
                {totalFindings > 0
                  ? (zh ? `${totalFindings} 条发现 · ${issueCount} 条证据节点` : `${totalFindings} findings · ${issueCount} evidence nodes`)
                  : (zh ? '未发现明确关键问题' : 'No clear key finding')}
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onRerun}>
            <RefreshCw className="size-3.5" />
            {zh ? '重新诊断' : 'Rerun'}
          </Button>
        </div>

        {totalFindings > 0 ? (
          <div className="space-y-2">
            {findings.map((finding, index) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                index={index}
                report={report}
                zh={zh}
                expanded={expandedFindingIds.has(finding.id)}
                traceExplicitErrors={index === 0 ? traceExplicitErrors : []}
                onToggle={() => {
                  setExpandedFindingIds(prev => {
                    const next = new Set(prev);
                    if (next.has(finding.id)) next.delete(finding.id);
                    else next.add(finding.id);
                    return next;
                  });
                }}
                onNodeRefClick={onNodeRefClick}
              />
            ))}
            {trajectoryFindings.map((finding, i) => (
              <TrajectoryFindingRow
                key={finding.id}
                finding={finding}
                index={findings.length + i}
                zh={zh}
                expanded={expandedFindingIds.has(finding.id)}
                onToggle={() => {
                  setExpandedFindingIds(prev => {
                    const next = new Set(prev);
                    if (next.has(finding.id)) next.delete(finding.id);
                    else next.add(finding.id);
                    return next;
                  });
                }}
                onNodeRefClick={onNodeRefClick}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">{zh ? '初筛未检测到足够明确的问题。' : 'Phase 1 did not find a clear issue.'}</p>
        )}
      </div>

      <SkillsAnalysisSection
        executionId={executionId}
        user={user}
        zh={zh}
        analysis={skillsAnalysis}
        onAnalysisUpdate={onSkillsAnalysisUpdate}
      />
    </div>
  );
}
function TrajectoryFindingRow({ finding, index, zh, expanded, onToggle, onNodeRefClick }: {
  finding: AgentDebugTrajectoryFinding;
  index: number;
  zh: boolean;
  expanded: boolean;
  onToggle: () => void;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const spanText = finding.span.fromStep != null && finding.span.toStep != null
    ? `#${finding.span.fromStep}–#${finding.span.toStep}`
    : (zh ? `${finding.span.turnCount} 个 turn` : `${finding.span.turnCount} turns`);
  return (
    <div className="rounded-lg border border-border bg-background-secondary p-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[11px] font-bold text-primary">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-6 text-foreground">{sanitizeConclusionText(finding.summary)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-muted">
            <span className="inline-flex items-center gap-1 rounded bg-error-subtle px-1 py-0.5 text-error">
              <RotateCcw className="size-3" />{zh ? '疑似循环' : 'Suspected loop'}
            </span>
            <span>{zh ? '区间' : 'span'} {spanText} · ×{finding.cycleCount} · {Math.round(finding.confidence * 100)}%</span>
          </div>
        </div>
        {expanded ? <ChevronDown className="mt-1 size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="mt-1 size-3.5 shrink-0 text-foreground-muted" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <section>
            <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '故障机制' : 'Mechanism'}</div>
            <div className="text-[12.5px] leading-6 text-foreground">{sanitizeReportText(finding.mechanism)}</div>
          </section>

          {finding.faultChain.length > 0 && (
            <section>
              <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '故障链' : 'Fault chain'}</div>
              <ol className="space-y-0.5">
                {finding.faultChain.map((step, i) => (
                  <li key={i} className="text-[12px] leading-6 text-foreground-muted">{i + 1}. {sanitizeReportText(step)}</li>
                ))}
              </ol>
            </section>
          )}

          <section>
            <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '无进展证据' : 'No-progress evidence'}</div>
            <div className="text-[12px] leading-6 text-foreground-muted">{sanitizeReportText(finding.noProgressEvidence)}</div>
          </section>

          {finding.anchors.length > 0 && (
            <section className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '证据节点' : 'Evidence'}</span>
              {finding.anchors.map((anchor, i) => {
                const label = anchor.traceStepIndex != null ? `#${anchor.traceStepIndex}` : (anchor.traceNodeLabel || `node ${i + 1}`);
                const clickable = Boolean(anchor.anchorId && onNodeRefClick);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!clickable}
                    onClick={() => { if (anchor.anchorId && onNodeRefClick) onNodeRefClick(anchor.anchorId); }}
                    className={`rounded border border-border px-1.5 py-0.5 text-[11px] ${clickable ? 'cursor-pointer text-error hover:bg-error-subtle' : 'cursor-default text-foreground-muted'}`}
                    title={anchor.traceNodeLabel || ''}
                  >
                    {label}{anchor.note ? ` · ${anchor.note}` : ''}
                  </button>
                );
              })}
            </section>
          )}

          <section className="rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '建议' : 'Guidance'}</div>
            <div className="text-[12.5px] leading-6 text-foreground">{sanitizeReportText(finding.correctionGuidance)}</div>
          </section>
        </div>
      )}
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

function FindingCard({ finding, index, report, zh, expanded, traceExplicitErrors, onToggle, onNodeRefClick }: {
  finding: AgentDebugFinding;
  index: number;
  report: AgentDebugReportPayload;
  zh: boolean;
  expanded: boolean;
  traceExplicitErrors: TraceExplicitError[];
  onToggle: () => void;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const findingIssues = issuesForFinding(finding, report.issues);
  const rootIssue = findingIssues.find(issue => finding.issueRefs.find(ref => ref.issueId === issue.id)?.role === 'root') || findingIssues[0];
  const modules = index === 0 ? MODULES : FINDING_MODULES;
  const conclusion = splitFindingSummary(finding.summary);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background-secondary p-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[11px] font-bold text-primary">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-6 text-foreground">{sanitizeConclusionText(conclusion.conclusion || finding.summary)}</div>
          {rootIssue && (
            <div className="mt-0.5 text-[11px] text-foreground-muted">{formatTraceLocation(rootIssue, zh)}</div>
          )}
        </div>
        {expanded ? <ChevronDown className="mt-1 size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="mt-1 size-3.5 shrink-0 text-foreground-muted" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <section className="rounded-lg border border-border bg-card">
            <button
              type="button"
              aria-expanded={evidenceExpanded}
              onClick={() => setEvidenceExpanded(value => !value)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none hover:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '证据' : 'Evidence'}</span>
              <span className="h-px min-w-4 flex-1 bg-border" />
              <span className="text-[11px] text-foreground-muted">
                {zh ? '展开查看关联模块证据' : 'Expand linked module evidence'}
              </span>
              {evidenceExpanded ? <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-foreground-muted" />}
            </button>
            {evidenceExpanded && (
              <div className="border-t border-border p-3">
                {finding.evidence && (
                  <p className="mb-2 rounded-md border border-border bg-background-secondary p-2 font-mono text-[11.5px] leading-5 text-foreground-muted">
                    {sanitizeReportText(finding.evidence)}
                  </p>
                )}
                <div className="grid gap-2 md:grid-cols-2">
                  {modules.map(module => (
                    <EvidenceModuleCard
                      key={module.key}
                      module={module}
                      zh={zh}
                      globalSystem={index === 0 && module.key === 'system'}
                      issues={module.key === 'system'
                        ? report.issues.filter(issue => issue.module === 'system')
                        : findingIssues.filter(issue => issue.module === module.key)}
                      traceExplicitErrors={index === 0 && module.key === 'system' ? traceExplicitErrors : []}
                      finding={finding}
                      onNodeRefClick={onNodeRefClick}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          {conclusion.details && (
            <section>
              <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '分析说明' : 'Analysis notes'}</div>
              <ExpandableText
                maxLines={4}
                className="text-[12px] leading-6 text-foreground-muted"
                expandLabel={zh ? '展开完整说明' : 'Show full notes'}
                collapseLabel={zh ? '收起说明' : 'Collapse notes'}
              >
                {sanitizeReportText(conclusion.details)}
              </ExpandableText>
            </section>
          )}

          <section className="rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '建议' : 'Guidance'}</div>
            <div className="text-[12.5px] leading-6 text-foreground">{sanitizeReportText(finding.correctionGuidance)}</div>
          </section>
        </div>
      )}
    </div>
  );
}

function EvidenceModuleCard({ module, zh, globalSystem, issues, traceExplicitErrors, finding, onNodeRefClick }: {
  module: { key: AgentDebugModule; zh: string; en: string };
  zh: boolean;
  globalSystem: boolean;
  issues: AgentDebugIssue[];
  traceExplicitErrors: TraceExplicitError[];
  finding: AgentDebugFinding;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  const Icon = MODULE_ICONS[module.key] || Eye;
  const [expanded, setExpanded] = useState(false);
  const orderedIssues = [...issues].sort((a, b) => {
    const aRole = finding.issueRefs.find(ref => ref.issueId === a.id)?.role || 'contributing';
    const bRole = finding.issueRefs.find(ref => ref.issueId === b.id)?.role || 'contributing';
    const roleDelta = findingRoleRank(bRole) - findingRoleRank(aRole);
    if (roleDelta !== 0) return roleDelta;
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return (locationIndex(a) ?? a.step) - (locationIndex(b) ?? b.step);
  });
  const orderedTraceErrors = [...traceExplicitErrors].sort((a, b) => (a.traceStepIndex ?? Number.MAX_SAFE_INTEGER) - (b.traceStepIndex ?? Number.MAX_SAFE_INTEGER));
  const totalCount = orderedIssues.length + orderedTraceErrors.length;
  const title = globalSystem ? (zh ? '全局 System 证据' : 'Global System Evidence') : module.en;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full items-start justify-between gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg border border-border bg-background-secondary text-primary">
            <Icon className="size-3.5" />
          </div>
          <div>
            <ModuleTitle
              title={title}
              help={(zh ? MODULE_HELP[module.key]?.zh : MODULE_HELP[module.key]?.en) || module.key}
            />
            <div className="text-[11px] text-foreground-muted">{globalSystem ? (zh ? '只在第一条关键发现展示一次' : 'Shown once in the first finding') : (zh ? module.zh : module.key)}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={totalCount > 0 ? 'warning' : 'success'} label={totalCount > 0 ? `${totalCount}` : 'OK'} />
          {expanded ? <ChevronDown className="mt-0.5 size-3.5 text-foreground-muted" /> : <ChevronRight className="mt-0.5 size-3.5 text-foreground-muted" />}
        </div>
      </button>
      {expanded && (totalCount > 0 ? (
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {orderedIssues.map(issue => (
            <IssueEvidenceItem key={issue.id} issue={issue} role={finding.issueRefs.find(ref => ref.issueId === issue.id)?.role} zh={zh} onNodeRefClick={onNodeRefClick} />
          ))}
          {orderedTraceErrors.map(error => (
            <TraceErrorEvidenceItem key={error.id} error={error} zh={zh} onNodeRefClick={onNodeRefClick} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[12px] leading-6 text-foreground-muted">
          {zh ? '当前发现未关联该模块问题' : 'This finding has no issue linked to this module.'}
        </p>
      ))}
    </div>
  );
}

function IssueEvidenceItem({ issue, role, zh, onNodeRefClick }: {
  issue: AgentDebugIssue;
  role?: string;
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">{formatTraceLocation(issue, zh)}</span>
      </div>
      <ExpandableText
        maxLines={4}
        className="text-[11.5px] leading-5 text-foreground-muted"
        expandLabel={zh ? '展开完整原因' : 'Show full reason'}
        collapseLabel={zh ? '收起原因' : 'Collapse reason'}
      >
        {sanitizeReportText(issue.reasoning || issue.evidence)}
      </ExpandableText>
      {issue.evidence && issue.reasoning && (
        <ExpandableText
          maxLines={3}
          className="mt-1.5 font-mono text-[10.5px] leading-5 text-foreground-muted"
          expandLabel={zh ? '展开证据原文' : 'Show evidence'}
          collapseLabel={zh ? '收起证据原文' : 'Collapse evidence'}
        >
          {sanitizeReportText(issue.evidence)}
        </ExpandableText>
      )}
      {issue.anchorId && onNodeRefClick && (
        <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(issue.anchorId!)}>
          {zh ? '跳到左侧节点' : 'View trace node'}
          <ChevronRight className="size-3" />
        </Button>
      )}
    </div>
  );
}

function TraceErrorEvidenceItem({ error, zh, onNodeRefClick }: {
  error: TraceExplicitError;
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background-secondary px-2.5 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">{formatTraceLocation(error, zh)}</span>
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
      {error.anchorId && onNodeRefClick && (
        <Button className="mt-1.5 h-6 px-0 text-[11px]" variant="link" size="sm" onClick={() => onNodeRefClick(error.anchorId!)}>
          {zh ? '跳到左侧节点' : 'View trace node'}
          <ChevronRight className="size-3" />
        </Button>
      )}
    </div>
  );
}

function keyActionBadgeStatus(status: string): 'success' | 'warning' | 'error' | 'pending' {
  const normalized = status.toLowerCase();
  if (normalized === 'covered' || normalized === 'passed' || normalized === 'pass' || normalized === 'success') return 'success';
  if (normalized === 'missing' || normalized === 'failed' || normalized === 'fail' || normalized === 'error') return 'error';
  if (normalized === 'not_applicable' || normalized === 'not-applicable' || normalized === 'n/a') return 'pending';
  return 'warning';
}

function formatKeyActionStatus(status: string, zh: boolean): string {
  const normalized = status.toLowerCase();
  if (!zh) return status;
  if (normalized === 'covered' || normalized === 'passed' || normalized === 'pass' || normalized === 'success') return '\u5df2\u8986\u76d6';
  if (normalized === 'partial' || normalized === 'partially_covered') return '\u90e8\u5206\u8986\u76d6';
  if (normalized === 'missing' || normalized === 'failed' || normalized === 'fail' || normalized === 'error') return '\u672a\u8986\u76d6';
  if (normalized === 'not_applicable' || normalized === 'not-applicable' || normalized === 'n/a') return '\u4e0d\u9002\u7528';
  return status;
}

function SkillsAnalysisSection({ executionId, user, zh, analysis, onAnalysisUpdate }: {
  executionId: string;
  user: string;
  zh: boolean;
  analysis: AgentDebugSkillsAnalysis | null;
  onAnalysisUpdate: (analysis: AgentDebugSkillsAnalysis | null) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [keyActionsExpanded, setKeyActionsExpanded] = useState(false);
  const [error, setError] = useState('');
  const [localAnalysis, setLocalAnalysis] = useState<AgentDebugSkillsAnalysis | null>(analysis);

  useEffect(() => {
    setLocalAnalysis(analysis);
  }, [analysis]);

  const keyActions = extractSkillsKeyActions(localAnalysis as Record<string, unknown> | null);
  const skillSuggestions = extractSkillsSuggestions(localAnalysis as Record<string, unknown> | null);
  const summaryText = summarizeSkillsReason(localAnalysis?.reasonText || '');
  const status = localAnalysis?.status || 'pending';
  const hasUsableData = status === 'done' && keyActions.length > 0;
  const canGenerate = status !== 'running';
  const failed = status === 'failed';
  const attentionCount = keyActions.filter(item => item.status === 'partial' || item.status === 'missing' || item.status === 'not_applicable').length;

  useEffect(() => {
    if (!executionId || status !== 'running') return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug/skills-analysis`);
        const data = await res.json().catch(() => ({})) as AgentDebugSkillsAnalysisResponse;
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const nextAnalysis = skillsAnalysisFromResponse(data);
        if (nextAnalysis) {
          onAnalysisUpdate(nextAnalysis);
          setLocalAnalysis(nextAnalysis);
          if (nextAnalysis.status !== 'failed') setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    const timer = window.setInterval(poll, AGENT_DEBUG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [executionId, onAnalysisUpdate, status]);

  async function generateSkillsAnalysis(force = true) {
    if (!executionId || !user || generating) return;
    setGenerating(true);
    setError('');
    const optimistic = optimisticSkillsAnalysisRunning(localAnalysis?.interactionHash);
    setLocalAnalysis(optimistic);
    onAnalysisUpdate(optimistic);
    try {
      const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/agent-debug/skills-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, force }),
      });
      const data = await res.json().catch(() => ({})) as {
        skillsAnalysis?: AgentDebugSkillsAnalysis;
        status?: string;
        error?: string;
      };
      if (res.status === 409 && isSkillsAnalysisRunningResponse(data)) {
        applySkillsAnalysisResponse(data);
        if (!expanded) setExpanded(true);
        return;
      }
      applySkillsAnalysisResponse(data);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!expanded) setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function applySkillsAnalysisResponse(data: AgentDebugSkillsAnalysisResponse) {
    const nextAnalysis = skillsAnalysisFromResponse(data);
    if (nextAnalysis) {
      setLocalAnalysis(nextAnalysis);
      onAnalysisUpdate(nextAnalysis);
    } else if (!data.error) {
      setLocalAnalysis(prev => prev?.status === 'running' ? prev : null);
      if (localAnalysis?.status !== 'running') onAnalysisUpdate(null);
    }
    if (!data.error || isSkillsAnalysisRunningResponse(data)) {
      setError('');
    }
  }

  return (
    <div className="rounded-lg border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {expanded ? <ChevronDown className="mt-1 size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="mt-1 size-3.5 shrink-0 text-foreground-muted" />}
          <div className="min-w-0">
            <div className="text-[10.5px] font-bold tracking-[0.14em] text-primary">{zh ? '\u0053\u006b\u0069\u006c\u006c\u0073 \u5206\u6790' : 'SKILLS ANALYSIS'}</div>
            {(generating || status === 'running' || !hasUsableData) && (
              <div className="mt-0.5 text-sm font-bold tracking-tight text-foreground">
                {generating || status === 'running'
                  ? (zh ? '正在生成 Skills 步骤核验' : 'Generating Skills step review')
                  : (zh ? '暂无 Skills 步骤核验结果' : 'No Skills step review yet')}
              </div>
            )}
            {hasUsableData && (
              <div className="mt-0.5 text-[11px] text-foreground-muted">
                {zh ? `${keyActions.length} 个 Skill 步骤` : `${keyActions.length} Skill steps`}
              </div>
            )}
          </div>
        </button>
        {canGenerate && (
          <Button variant="outline" size="sm" onClick={() => generateSkillsAnalysis(true)} disabled={generating}>
            {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {failed || localAnalysis ? (zh ? '重新分析' : 'Re-analyze') : (zh ? '生成 Skills 分析' : 'Generate Skills analysis')}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="mt-3">
          {error && (
            <div className="mb-3 rounded-md border border-error-border bg-error-subtle p-2 text-[12px] text-error">{error}</div>
          )}

          {hasUsableData ? (
            <div className="space-y-3">
              {summaryText && (
                <div className="rounded-md border border-border bg-background-secondary p-3">
                  <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '总结' : 'Summary'}</div>
                  <p className="whitespace-pre-line text-[12.5px] leading-6 text-foreground-muted">{summaryText}</p>
                </div>
              )}
              <div className="rounded-md border border-border bg-background-secondary">
                <button
                  type="button"
                  aria-expanded={keyActionsExpanded}
                  onClick={() => setKeyActionsExpanded(value => !value)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="text-[12px] font-bold text-foreground">{zh ? 'Skill 步骤核验' : 'Skill step review'}</span>
                  <StatusBadge status={attentionCount > 0 ? 'warning' : 'success'} label={`${keyActions.length}`} />
                  {attentionCount > 0 && (
                    <span className="text-[11px] text-foreground-muted">{zh ? `${attentionCount} 个需关注` : `${attentionCount} need attention`}</span>
                  )}
                  <span className="h-px min-w-4 flex-1 bg-border" />
                  {keyActionsExpanded ? <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-foreground-muted" />}
                </button>
                {keyActionsExpanded && (
                  <div className="space-y-2 border-t border-border p-2.5">
                    {keyActions.map((item, index) => (
                      <div key={`${index}-${item.title}`} className="rounded-md border border-border bg-card px-2.5 py-2">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={keyActionBadgeStatus(item.status)} label={formatKeyActionStatus(item.status, zh) || (zh ? 'Skill 步骤' : 'Skill step')} />
                          <span className="text-[12px] font-semibold text-foreground">{item.title || (zh ? `Skill 步骤 ${index + 1}` : `Skill step ${index + 1}`)}</span>
                        </div>
                        {item.description && <p className="text-[11.5px] leading-5 text-foreground-muted">{item.description}</p>}
                        {item.status !== 'covered' && item.status !== 'not_applicable' && item.suggestion && (
                          <div className="mt-2 rounded-md border border-success-border bg-success-subtle px-2 py-1.5 text-[11.5px] leading-5 text-success">
                            <span className="font-semibold">{zh ? '改进建议' : 'Suggestion'}</span>
                            <span className="ml-1 text-foreground-muted">{item.suggestion}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {skillSuggestions.length > 0 && (
                <div className="rounded-md border border-border bg-background-secondary">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <span className="text-[12px] font-bold text-foreground">{zh ? 'Skill 改进建议' : 'Skill improvement suggestions'}</span>
                    <StatusBadge status="warning" label={`${skillSuggestions.length}`} />
                    <span className="h-px min-w-4 flex-1 bg-border" />
                  </div>
                  <div className="space-y-2 border-t border-border p-2.5">
                    {skillSuggestions.map((item, index) => (
                      <div key={`sugg-${index}-${item.summary}`} className="rounded-md border border-border bg-card px-2.5 py-2">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={item.severity === 'high' ? 'error' : item.severity === 'medium' ? 'warning' : 'success'} label={item.category} />
                          <span className="text-[12px] font-semibold text-foreground">{item.summary}</span>
                        </div>
                        {item.evidence && <p className="text-[11.5px] leading-5 text-foreground-muted">{item.evidence}</p>}
                        <div className="mt-2 rounded-md border border-success-border bg-success-subtle px-2 py-1.5 text-[11.5px] leading-5 text-success">
                          <span className="font-semibold">{zh ? '改进建议' : 'Suggestion'}</span>
                          <span className="ml-1 text-foreground-muted">{item.improvementSuggestion}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-border bg-background-secondary p-3">
              <p className="text-[12.5px] leading-6 text-foreground-muted">
                {generating || status === 'running'
                  ? (zh ? '正在生成 Skills 步骤核验。完成后会保存到 AgentDebug Skills 分析缓存里。' : 'Skills step review is running. The result will be saved in the AgentDebug Skills cache.')
                  : failed
                    ? (zh ? `Skills 步骤核验失败：${localAnalysis?.errorMessage || '未知错误'}。可以重新分析。` : `Skills step review failed: ${localAnalysis?.errorMessage || 'unknown error'}. You can re-analyze.`)
                    : status === 'done'
                      ? (zh ? '已保存 Skills 分析结果，但缺少步骤核验明细。可以重新分析。' : 'Saved Skills analysis has no step review details. You can re-analyze.')
                      : (zh ? '当前 trace 还没有 Skills 步骤核验结果。点击生成后会分析 Skill 步骤覆盖情况，并保存到 AgentDebug Skills 分析缓存。' : 'This trace has no Skills step review yet. Generate it to analyze Skill step coverage and save it in the AgentDebug Skills cache.')}
              </p>
              {canGenerate && (
                <Button variant="outline" size="sm" className="mt-2" onClick={() => generateSkillsAnalysis(true)} disabled={generating}>
                  {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  {failed || localAnalysis ? (zh ? '重新分析' : 'Re-analyze') : (zh ? '生成 Skills 分析' : 'Generate Skills analysis')}
                </Button>
              )}
            </div>
          )}
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

function normalizeReportFindings(report: AgentDebugReportPayload): AgentDebugFinding[] {
  if (Array.isArray(report.findings) && report.findings.length > 0) return report.findings;
  return report.rootCause ? [findingFromRootCause(report.rootCause, report.issues)] : [];
}

function findingFromRootCause(root: AgentDebugRootCause, issues: AgentDebugIssue[]): AgentDebugFinding {
  const issueRefs = issueRefsFromRootCause(root, issues);
  return {
    id: 'finding-root-cause',
    severity: issues.find(issue => issue.id === issueRefs[0]?.issueId)?.severity || 'high',
    impact: 'quality_degrading',
    summary: root.summary,
    evidence: root.evidence,
    issueRefs,
    correctionGuidance: root.correctionGuidance,
    confidence: root.confidence,
  };
}

function issueRefsFromRootCause(root: AgentDebugRootCause, issues: AgentDebugIssue[]): AgentDebugFinding['issueRefs'] {
  const refs: AgentDebugFinding['issueRefs'] = [];
  const rootIndex = locationIndex(rootTraceLocation(root));
  const rootIssue = issues.find(issue =>
    issue.module === root.criticalModule
    && locationIndex(issue) === rootIndex
    && issue.errorType === root.criticalErrorType
  ) || issues.find(issue =>
    issue.module === root.criticalModule
    && locationIndex(issue) === rootIndex
  );
  if (rootIssue) refs.push({ issueId: rootIssue.id, role: 'root' });
  for (const item of root.cascadingChain) {
    const matched = issues.find(issue =>
      issue.module === item.module
      && locationIndex(issue) === locationIndex(item)
      && issue.errorType === item.errorType
    ) || issues.find(issue =>
      issue.module === item.module
      && locationIndex(issue) === locationIndex(item)
    );
    if (matched && !refs.some(ref => ref.issueId === matched.id)) refs.push({ issueId: matched.id, role: 'downstream' });
  }
  if (refs.length === 0 && issues[0]) refs.push({ issueId: issues[0].id, role: 'root' });
  return refs;
}

function issuesForFinding(finding: AgentDebugFinding, issues: AgentDebugIssue[]): AgentDebugIssue[] {
  const issueById = new Map(issues.map(issue => [issue.id, issue]));
  return finding.issueRefs
    .map(ref => issueById.get(ref.issueId))
    .filter((issue): issue is AgentDebugIssue => Boolean(issue));
}

function findingRoleRank(role: string): number {
  if (role === 'root') return 3;
  if (role === 'contributing') return 2;
  if (role === 'downstream') return 1;
  return 0;
}

function extractSkillsKeyActions(raw: Record<string, unknown> | null): Array<{ title: string; description: string; status: string; suggestion: string }> {
  if (!raw) return [];
  const value = raw.keyActionResults || raw.key_action_results;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => ({
      title: stringValue(item.actionContent)
        || stringValue(item.action_content)
        || stringValue(item.actionName)
        || stringValue(item.name)
        || stringValue(item.title)
        || stringValue(item.keyAction)
        || '',
      description: stringValue(item.traceComparisonAnalysis)
        || stringValue(item.trace_comparison_analysis)
        || stringValue(item.reason)
        || stringValue(item.description)
        || stringValue(item.evidence)
        || '',
      status: stringValue(item.coverage)
        || stringValue(item.status)
        || stringValue(item.result)
        || stringValue(item.matchStatus)
        || '',
      suggestion: stringValue(item.skillImprovementSuggestion)
        || stringValue(item.skill_improvement_suggestion)
        || stringValue(item.suggestion)
        || '',
    }));
}

function extractSkillsSuggestions(raw: Record<string, unknown> | null): Array<{ category: string; severity: 'high' | 'medium' | 'low'; summary: string; evidence: string; improvementSuggestion: string }> {
  if (!raw) return [];
  const value = raw.skillSuggestions || raw.skill_suggestions;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => {
      const sev = stringValue(item.severity).toLowerCase();
      return {
        category: stringValue(item.category) || '其他',
        severity: (sev === 'high' || sev === 'low' ? sev : 'medium') as 'high' | 'medium' | 'low',
        summary: stringValue(item.summary),
        evidence: stringValue(item.evidence),
        improvementSuggestion: stringValue(item.improvementSuggestion) || stringValue(item.improvement_suggestion),
      };
    })
    .filter(item => item.summary && item.improvementSuggestion);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function summarizeSkillsReason(value: string): string {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/(完整性(?:\([^)]+\))?[：:])/g, '\n$1')
    .replace(/(工具选择(?:\([^)]+\))?[：:])/g, '\n$1')
    .replace(/(冗余(?:\([^)]+\))?[：:])/g, '\n$1')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !/^执行路径分析/.test(line) && !/可能触发封顶|封顶/.test(line))
    .join('\n');
}

function rootTraceLocation(root: AgentDebugRootCause): AgentDebugTraceLocation {
  return {
    traceStepIndex: root.criticalTraceStepIndex ?? root.criticalStep ?? undefined,
    traceNodeLabel: root.criticalTraceNodeLabel,
    traceNodeKind: root.criticalTraceNodeKind,
  };
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

function severityRank(severity: AgentDebugIssue['severity']): number {
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
  return label;
}
