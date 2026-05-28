import { runGeneralAgent } from '@/lib/engine/general-agent';
import { loadFileBasedSkillPrompt, mountFileBasedSkillResources } from '@/lib/engine/general-agent/skills-fs-loader';
import { ensureSessionWorkspace } from '@/lib/engine/general-agent/workspace';
import { ensureTraceBundle } from '@/lib/engine/observability/trace-bundle';
import fs from 'node:fs';
import path from 'node:path';
import { buildDebugTurns, hashInteractions } from './trace-adapter';
import { numberField, parseJsonObject, stringField } from './json';
import type {
  AgentDebugIssue,
  AgentDebugCandidateWindow,
  AgentDebugModule,
  AgentDebugModuleOutput,
  AgentDebugPhase1Cell,
  AgentDebugReportPayload,
  AgentDebugRootCause,
  AgentDebugSeverity,
  AgentDebugStepRecord,
  AgentDebugTriage,
  DebugTurn,
} from './types';

export const AGENT_DEBUG_GENERATOR = 'agent-debug-diagnosis-skill@0.1';

const AGENT_DEBUG_SKILL_NAME = 'agent-debug-diagnosis';
const FAULT_DIAGNOSIS_AGENT_NAME = 'fault-diagnosis-agent';
const AGENT_DEBUG_STATIC_REPORT_REL_PATH = '.agent-insight/agent-debug-static.json';
const AGENT_DEBUG_FINAL_REPORT_REL_PATH = '.agent-insight/agent-debug-final.json';

interface ExecutionLike {
  id?: string;
  taskId?: string | null;
  failures?: string | unknown[] | null;
  answerScore?: number | null;
  judgmentReason?: string | null;
  query?: string | null;
  framework?: string | null;
  user?: string | null;
}

export async function runAgentDebugDiagnosis(args: {
  execution: ExecutionLike;
  interactions: unknown[];
  user: string;
}): Promise<AgentDebugReportPayload> {
  const startedAt = Date.now();
  const executionId = String(args.execution.id || args.execution.taskId || '');
  const interactions = Array.isArray(args.interactions) ? args.interactions : [];
  const interactionHash = hashInteractions(interactions);
  const turns = buildDebugTurns(interactions);
  const candidateWindows: AgentDebugCandidateWindow[] = [];

  if (turns.length === 0) {
    return {
      schemaVersion: 1,
      generator: AGENT_DEBUG_GENERATOR,
      executionId,
      interactionHash,
      status: 'done',
      generatedAt: new Date().toISOString(),
      triage: normalTriage(),
      rootCause: null,
      issues: [],
      phase1Grid: [],
      stepRecords: [],
      candidateWindows,
      modelLabel: FAULT_DIAGNOSIS_AGENT_NAME,
      llmPowered: true,
      stats: {
        stepCount: 0,
        candidateWindowCount: candidateWindows.length,
        issueCount: 0,
        llmCallCount: 0,
        durationMs: Date.now() - startedAt,
      },
      skippedReason: '当前执行记录缺少可诊断的 assistant/subagent turn。',
    };
  }

  const workspaceTag = `agent-debug-${executionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;
  const workspaceDir = ensureSessionWorkspace(args.user, workspaceTag);
  const traceBundle = ensureTraceBundle({ workspaceDir, executionId, interactions });
  const mounted = mountFileBasedSkillResources(AGENT_DEBUG_SKILL_NAME, workspaceDir);
  const skillPrompt = loadFileBasedSkillPrompt(AGENT_DEBUG_SKILL_NAME);
  const system = buildSystemPrompt(skillPrompt, mounted.mountPoint ? `./.${AGENT_DEBUG_SKILL_NAME}/` : null);
  const inputRelPath = writeAgentDebugInput({
    workspaceDir,
    execution: args.execution,
      executionId,
      turns,
      traceBundle,
    });

  const result = await runGeneralAgent({
    user: args.user,
    query: buildAgentQuery({
      execution: args.execution,
      executionId,
      turns,
      traceBundle,
      inputRelPath,
      skillMountPath: mounted.mountPoint ? `./.${AGENT_DEBUG_SKILL_NAME}` : null,
    }),
    system,
    workspaceTag,
    sessionTitle: `agent-debug · ${executionId}`,
    systemAgentName: FAULT_DIAGNOSIS_AGENT_NAME,
    interactionPolicy: 'auto-allow',
    agent: 'build',
    timeoutMs: Number(process.env.AGENT_DEBUG_AGENT_TIMEOUT_MS || 110_000),
    modelOptions: { temperature: 0, maxTokens: 6000 },
  });

  const parsed = parseAgentDebugSkillOutput(result.output) || readAgentDebugFinalReport(workspaceDir);
  if (!parsed) {
    throw new Error('AgentDebug diagnosis skill did not return a valid JSON report.');
  }

  const stepRecords = normalizeStepRecords(parsed.stepRecords, turns);
  const phase1Grid = normalizePhase1Grid(parsed.phase1Grid);
  const issues = normalizeIssues(parsed.issues, phase1Grid);
  const rootCause = normalizeRootCause(parsed.rootCause);
  const triage = normalizeTriage(parsed.triage);

  return {
    schemaVersion: 1,
    generator: AGENT_DEBUG_GENERATOR,
    executionId,
    interactionHash,
    status: 'done',
    generatedAt: new Date().toISOString(),
    triage,
    rootCause,
    issues,
    phase1Grid,
    stepRecords,
    candidateWindows,
    modelLabel: `${FAULT_DIAGNOSIS_AGENT_NAME} + ${AGENT_DEBUG_SKILL_NAME}`,
    llmPowered: true,
    stats: {
      stepCount: stepRecords.length || turns.length,
      candidateWindowCount: candidateWindows.length,
      issueCount: issues.length,
      llmCallCount: 1,
      durationMs: Date.now() - startedAt,
    },
  };
}

export function parseAgentDebugSkillOutput(output: string): Record<string, unknown> | null {
  return parseJsonObject(output);
}

function readAgentDebugFinalReport(workspaceDir: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(path.join(workspaceDir, AGENT_DEBUG_FINAL_REPORT_REL_PATH), 'utf8');
    return parseJsonObject(content);
  } catch {
    return null;
  }
}

function normalTriage(): AgentDebugTriage {
  return {
    category: 'normal',
    shortCircuited: false,
    fatalDiagnosis: null,
    prefilterHints: { forceFullSteps: [] },
    notes: [],
  };
}

function normalizeTriage(value: unknown): AgentDebugTriage {
  if (!value || typeof value !== 'object') return normalTriage();
  const item = value as Record<string, unknown>;
  const categoryRaw = stringField(item, 'category', 'normal');
  const category: AgentDebugTriage['category'] = ['normal', 'infra', 'tool_systemic', 'early_fatal'].includes(categoryRaw)
    ? categoryRaw as AgentDebugTriage['category']
    : 'normal';
  const fatalRaw = item.fatalDiagnosis && typeof item.fatalDiagnosis === 'object'
    ? item.fatalDiagnosis as Record<string, unknown>
    : null;
  const hintsRaw = item.prefilterHints && typeof item.prefilterHints === 'object'
    ? item.prefilterHints as Record<string, unknown>
    : {};
  return {
    category,
    shortCircuited: Boolean(item.shortCircuited),
    fatalDiagnosis: fatalRaw ? {
      errorType: stringField(fatalRaw, 'errorType', 'fatal'),
      toolName: optionalStringField(fatalRaw, 'toolName'),
      affectedSteps: numberArrayField(fatalRaw, 'affectedSteps'),
      affectedTraceStepIndexes: numberArrayField(fatalRaw, 'affectedTraceStepIndexes'),
      traceNodeLabel: optionalStringField(fatalRaw, 'traceNodeLabel'),
      traceNodeKind: optionalStringField(fatalRaw, 'traceNodeKind'),
      summary: stringField(fatalRaw, 'summary', ''),
      recommendation: stringField(fatalRaw, 'recommendation', ''),
      rawErrorEvidence: stringField(fatalRaw, 'rawErrorEvidence', ''),
      anchorId: optionalStringField(fatalRaw, 'anchorId'),
    } : null,
    prefilterHints: {
      forceFullSteps: numberArrayField(hintsRaw, 'forceFullSteps'),
    },
    notes: stringArrayField(item, 'notes'),
  };
}

function buildSystemPrompt(skillPrompt: string, mountPath: string | null): string {
  return [
    '你是 Agent Insight 的智能故障诊断 Agent。当前任务是使用 agent-debug-diagnosis Skill 生成结构化认知根因报告。',
    '必须严格遵循下方 Skill 及其 references。AgentDebug 的拆分、Phase 1、Phase 2、taxonomy 和输出协议都以 Skill 文件为准。',
    '如果 Skill 要求读取 references 或执行 scripts，必须先完成这些步骤后再诊断。',
    '最终回答只能输出一个 JSON 对象。',
    '允许执行挂载 skill 下的只读/分析脚本；不要修改用户项目文件，不要重新执行用户任务。',
    mountPath ? `Skill 资源已挂载在 ${mountPath}，其中包含 SKILL.md 和 references/ 诊断规程。` : '',
    '',
    skillPrompt,
  ].filter(Boolean).join('\n\n');
}

function buildAgentQuery(args: {
  execution: ExecutionLike;
  executionId: string;
  turns: DebugTurn[];
  traceBundle: ReturnType<typeof ensureTraceBundle>;
  inputRelPath: string;
  skillMountPath: string | null;
}): string {
  const executionBrief = {
    id: args.execution.id,
    taskId: args.execution.taskId,
    framework: args.execution.framework,
    query: args.execution.query,
    failures: parseFailures(args.execution.failures),
    answerScore: args.execution.answerScore,
    judgmentReason: args.execution.judgmentReason,
  };

  return [
    '请对下面的 Agent Insight 执行记录运行 AgentDebug 四模块认知根因诊断。',
    '',
    '要求：',
    '- 先按 agent-debug-diagnosis Skill 的 Required References 读取并执行完整诊断规程。',
    `- 必须先运行 skill 脚本生成静态分析：python3 ${args.skillMountPath || `./.${AGENT_DEBUG_SKILL_NAME}`}/scripts/agentdebug_static.py --input ${args.inputRelPath} --output ${AGENT_DEBUG_STATIC_REPORT_REL_PATH}`,
    `- 返回前必须运行校验脚本：python3 ${args.skillMountPath || `./.${AGENT_DEBUG_SKILL_NAME}`}/scripts/agentdebug_validate.py --input ${AGENT_DEBUG_FINAL_REPORT_REL_PATH}`,
    `- 最终回复仍必须是 ${AGENT_DEBUG_FINAL_REPORT_REL_PATH} 的完整 JSON 对象，不要只回复摘要或诊断完成说明。`,
    '- 按 agent-debug-diagnosis Skill 输出严格 JSON。',
    '- Memory / Reflection / Planning / Action 都允许留白；空模块不是错误。',
    '- Action 必须基于真实 tool call；不要从 Action 失败倒推 Planning 一定错误。',
    '- 不使用候选窗口；必须基于输入文件中的全部 turns 运行拆分、静态检测和 Phase 1 分析。',
    '- 用户界面只展示左侧真实 trace 节点；所有 issue/root/cascade 必须尽量带 anchorId、traceStepIndex、traceNodeLabel。',
    '- 如果归一化 Step 摘要证据不足，可读取 Trace 资料包里的 manifest/index/nodes。',
    '',
    '## 执行记录',
    compactJson(executionBrief, 8000),
    '',
    '## 归一化 Step 摘要',
    compactJson(args.turns.map(turnToPromptRecord), 40_000),
    '',
    '## Trace 资料包',
    [
      `AgentDebug 输入文件：${args.inputRelPath}`,
      `静态分析输出文件：${AGENT_DEBUG_STATIC_REPORT_REL_PATH}`,
      `最终报告临时文件：${AGENT_DEBUG_FINAL_REPORT_REL_PATH}`,
      `Skill 挂载目录：${args.skillMountPath || `./.${AGENT_DEBUG_SKILL_NAME}`}`,
      `资料包目录：${args.traceBundle.bundleRelDir}/`,
      `manifest：${args.traceBundle.manifestRelPath}`,
      `index：${args.traceBundle.indexRelPath}`,
      `节点数：${args.traceBundle.nodeCount}`,
      `长文本 artifact 数：${args.traceBundle.artifactCount}`,
      `是否复用已有资料包：${args.traceBundle.reused ? '是' : '否'}`,
    ].join('\n'),
  ].join('\n');
}

function writeAgentDebugInput(args: {
  workspaceDir: string;
  execution: ExecutionLike;
  executionId: string;
  turns: DebugTurn[];
  traceBundle: ReturnType<typeof ensureTraceBundle>;
}): string {
  const relPath = path.join('.agent-insight', 'agent-debug-input.json');
  const filePath = path.join(args.workspaceDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    execution: {
      id: args.execution.id,
      taskId: args.execution.taskId,
      framework: args.execution.framework,
      query: args.execution.query,
      failures: parseFailures(args.execution.failures),
      answerScore: args.execution.answerScore,
      judgmentReason: args.execution.judgmentReason,
    },
    candidateWindows: [],
    turns: args.turns,
    traceBundle: {
      bundleRelDir: args.traceBundle.bundleRelDir,
      manifestRelPath: args.traceBundle.manifestRelPath,
      indexRelPath: args.traceBundle.indexRelPath,
      nodeCount: args.traceBundle.nodeCount,
      artifactCount: args.traceBundle.artifactCount,
      reused: args.traceBundle.reused,
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return relPath.split(path.sep).join('/');
}

function turnToPromptRecord(turn: DebugTurn) {
  return {
    step: turn.turnIndex,
    traceStepIndex: turn.traceStepIndex,
    traceNodeLabel: turn.traceNodeLabel,
    traceNodeKind: turn.traceNodeKind,
    sourceInteractionIndex: turn.sourceInteractionIndex,
    role: turn.role,
    agentName: turn.agentName,
    inputContext: truncate(turn.requestContextPreview || '', 1000),
    text: truncate(turn.text, 1800),
    reasoningText: truncate(turn.reasoningText || '', 1800),
    toolCalls: turn.toolCalls.map(tool => ({
      name: tool.name,
      status: tool.status,
      args: truncate(compactJson(tool.args, 1200), 1200),
      output: truncate(compactJson(tool.output, 1200), 1200),
      rawError: tool.rawError,
      anchorId: tool.anchorId,
      traceStepIndex: tool.traceStepIndex,
      traceNodeLabel: tool.traceNodeLabel,
      traceNodeKind: tool.traceNodeKind,
    })),
    anchorIds: turn.anchorIds,
  };
}

function normalizeStepRecords(value: unknown, turns: DebugTurn[]): AgentDebugStepRecord[] {
  if (!Array.isArray(value)) {
    return turns.map(turn => ({
      step: turn.traceStepIndex || turn.turnIndex,
      diagnosticStep: turn.turnIndex,
      traceStepIndex: turn.traceStepIndex,
      traceNodeLabel: turn.traceNodeLabel,
      traceNodeKind: turn.traceNodeKind,
      sourceInteractionIndex: turn.sourceInteractionIndex,
      title: turn.traceNodeLabel || `Trace node ${turn.traceStepIndex || turn.turnIndex}`,
      inputContext: turn.requestContextPreview || '',
      agentOutput: [turn.reasoningText, turn.text].filter(Boolean).join('\n\n'),
      environmentResponse: '',
      anchorId: turn.anchorIds[0],
      modules: emptyModules(),
    }));
  }
  return value
    .map((item, _index) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => {
      const step = Math.max(1, Math.round(numberField(item, 'step', index + 1)));
      const traceStepIndex = optionalNumberField(item, 'traceStepIndex') ?? step;
      const modules = item.modules && typeof item.modules === 'object'
        ? item.modules as Record<string, unknown>
        : {};
      return {
        step,
        diagnosticStep: optionalNumberField(item, 'diagnosticStep'),
        traceStepIndex,
        traceNodeLabel: optionalStringField(item, 'traceNodeLabel'),
        traceNodeKind: optionalStringField(item, 'traceNodeKind'),
        sourceInteractionIndex: Math.max(0, Math.round(numberField(item, 'sourceInteractionIndex', step - 1))),
        title: stringField(item, 'title', optionalStringField(item, 'traceNodeLabel') || `Trace node ${traceStepIndex}`),
        inputContext: stringField(item, 'inputContext', ''),
        agentOutput: stringField(item, 'agentOutput', ''),
        environmentResponse: stringField(item, 'environmentResponse', ''),
        anchorId: optionalStringField(item, 'anchorId'),
        modules: {
          memory: normalizeModuleOutput(modules.memory, 'memory'),
          reflection: normalizeModuleOutput(modules.reflection, 'reflection'),
          planning: normalizeModuleOutput(modules.planning, 'planning'),
          action: normalizeModuleOutput(modules.action, 'action'),
          system: normalizeModuleOutput(modules.system, 'system'),
        },
      };
    });
}

function normalizePhase1Grid(value: unknown): AgentDebugPhase1Cell[] {
  if (!Array.isArray(value)) return [];
  const cells: AgentDebugPhase1Cell[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const mod = normalizeModule(stringField(item, 'module', 'unknown'));
    if (mod === 'unknown') continue;
    const step = Math.max(1, Math.round(numberField(item, 'step', 1)));
    const traceStepIndex = optionalNumberField(item, 'traceStepIndex') ?? step;
    cells.push({
      step,
      diagnosticStep: optionalNumberField(item, 'diagnosticStep'),
      traceStepIndex,
      traceNodeLabel: optionalStringField(item, 'traceNodeLabel'),
      traceNodeKind: optionalStringField(item, 'traceNodeKind'),
      module: mod,
      errorDetected: Boolean(item.errorDetected),
      errorType: stringField(item, 'errorType', 'no_error'),
      severity: normalizeSeverity(stringField(item, 'severity', 'medium')),
      evidence: stringField(item, 'evidence', ''),
      reasoning: stringField(item, 'reasoning', ''),
      confidence: clamp(numberField(item, 'confidence', 0.5)),
      anchorId: optionalStringField(item, 'anchorId'),
    });
  }
  return cells;
}

function normalizeIssues(value: unknown, phase1Grid: AgentDebugPhase1Cell[]): AgentDebugIssue[] {
  const fromGrid = phase1Grid
    .filter(cell => cell.errorDetected)
    .map(cell => ({
      id: `N${cell.traceStepIndex || cell.step}-${cell.module}-${cell.errorType}`,
      step: cell.step,
      diagnosticStep: cell.diagnosticStep,
      traceStepIndex: cell.traceStepIndex,
      traceNodeLabel: cell.traceNodeLabel,
      traceNodeKind: cell.traceNodeKind,
      module: cell.module,
      errorType: cell.errorType,
      severity: cell.severity,
      evidence: cell.evidence,
      reasoning: cell.reasoning,
      confidence: cell.confidence,
      anchorId: cell.anchorId,
    }));
  if (!Array.isArray(value)) return fromGrid;
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => ({
      id: stringField(item, 'id', `issue-${index + 1}`),
      step: Math.max(1, Math.round(numberField(item, 'step', 1))),
      diagnosticStep: optionalNumberField(item, 'diagnosticStep'),
      traceStepIndex: optionalNumberField(item, 'traceStepIndex') ?? Math.max(1, Math.round(numberField(item, 'step', 1))),
      traceNodeLabel: optionalStringField(item, 'traceNodeLabel'),
      traceNodeKind: optionalStringField(item, 'traceNodeKind'),
      module: normalizeModule(stringField(item, 'module', 'unknown')),
      errorType: stringField(item, 'errorType', 'others'),
      severity: normalizeSeverity(stringField(item, 'severity', 'medium')),
      evidence: stringField(item, 'evidence', ''),
      reasoning: stringField(item, 'reasoning', ''),
      confidence: clamp(numberField(item, 'confidence', 0.5)),
      anchorId: optionalStringField(item, 'anchorId'),
    }))
    .filter(issue => issue.module !== 'unknown');
}

function normalizeRootCause(value: unknown): AgentDebugRootCause | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const rawStep = item.criticalStep;
  const criticalStep = typeof rawStep === 'number' && Number.isFinite(rawStep) ? Math.max(1, Math.round(rawStep)) : null;
  const criticalTraceStepIndex = optionalNumberField(item, 'criticalTraceStepIndex') ?? criticalStep;
  const chain = Array.isArray(item.cascadingChain)
    ? item.cascadingChain
      .map(entry => entry && typeof entry === 'object' ? entry as Record<string, unknown> : null)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(0, 8)
      .map(entry => {
        const step = Math.max(1, Math.round(numberField(entry, 'step', criticalStep || 1)));
        return {
          step,
          diagnosticStep: optionalNumberField(entry, 'diagnosticStep'),
          traceStepIndex: optionalNumberField(entry, 'traceStepIndex') ?? step,
          traceNodeLabel: optionalStringField(entry, 'traceNodeLabel'),
          traceNodeKind: optionalStringField(entry, 'traceNodeKind'),
          module: normalizeModule(stringField(entry, 'module', 'unknown')),
          errorType: stringField(entry, 'errorType', stringField(item, 'criticalErrorType', 'others')),
          consequence: stringField(entry, 'consequence', ''),
          anchorId: optionalStringField(entry, 'anchorId'),
        };
      })
      .filter(entry => entry.module !== 'unknown')
    : [];
  return {
    criticalStep,
    criticalTraceStepIndex,
    criticalTraceNodeLabel: optionalStringField(item, 'criticalTraceNodeLabel'),
    criticalTraceNodeKind: optionalStringField(item, 'criticalTraceNodeKind'),
    criticalAnchorId: optionalStringField(item, 'criticalAnchorId') || optionalStringField(item, 'anchorId'),
    criticalModule: normalizeModule(stringField(item, 'criticalModule', 'unknown')),
    criticalErrorType: stringField(item, 'criticalErrorType', 'others'),
    summary: stringField(item, 'summary', ''),
    evidence: stringField(item, 'evidence', ''),
    cascadingChain: chain,
    correctionGuidance: stringField(item, 'correctionGuidance', ''),
    confidence: clamp(numberField(item, 'confidence', 0.5)),
  };
}

function normalizeModuleOutput(value: unknown, module: AgentDebugModuleOutput['module']): AgentDebugModuleOutput {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const source = stringField(item, 'source', module === 'action' ? 'raw_tool' : module === 'system' ? 'system' : 'implicit');
  return {
    module,
    content: stringField(item, 'content', ''),
    confidence: clamp(numberField(item, 'confidence', 0)),
    source: ['tag', 'llm', 'raw_tool', 'implicit', 'system'].includes(source)
      ? source as AgentDebugModuleOutput['source']
      : 'implicit',
  };
}

function emptyModules(): AgentDebugStepRecord['modules'] {
  return {
    memory: normalizeModuleOutput(null, 'memory'),
    reflection: normalizeModuleOutput(null, 'reflection'),
    planning: normalizeModuleOutput(null, 'planning'),
    action: normalizeModuleOutput(null, 'action'),
    system: normalizeModuleOutput(null, 'system'),
  };
}

function normalizeModule(value: string): AgentDebugModule {
  return ['memory', 'reflection', 'planning', 'action', 'system', 'others'].includes(value)
    ? value as AgentDebugModule
    : 'unknown';
}

function normalizeSeverity(value: string): AgentDebugSeverity {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function optionalStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.round(value)) : undefined;
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function numberArrayField(obj: Record<string, unknown>, key: string): number[] {
  const value = obj[key];
  return Array.isArray(value)
    ? value
      .map(item => typeof item === 'number' && Number.isFinite(item) ? Math.max(1, Math.round(item)) : null)
      .filter((item): item is number => item != null)
    : [];
}

function parseFailures(value: ExecutionLike['failures']) {
  if (Array.isArray(value)) return value as Array<{ trace_anchor?: { step_id?: string; interaction_index?: number }; anchor_step_id?: string; description?: string; failure_type?: string }>;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactJson(value: unknown, max = 12_000): string {
  let text = '';
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? '');
  }
  return truncate(text, max);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
