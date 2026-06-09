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
  AgentDebugFinding,
  AgentDebugFindingImpact,
  AgentDebugFindingIssueRole,
  AgentDebugIssueResolution,
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
      schemaVersion: 2,
      generator: AGENT_DEBUG_GENERATOR,
      executionId,
      interactionHash,
      status: 'done',
      generatedAt: new Date().toISOString(),
      triage: normalTriage(),
      rootCause: null,
      issues: [],
      findings: [],
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
  const parsedRootCause = normalizeRootCause(parsed.rootCause);
  const findings = normalizeFindings(parsed.findings, issues, parsedRootCause);
  const rootCause = parsedRootCause || projectFindingToRootCause(findings[0], issues);
  const triage = normalizeTriage(parsed.triage);

  return {
    schemaVersion: 2,
    generator: AGENT_DEBUG_GENERATOR,
    executionId,
    interactionHash,
    status: 'done',
    generatedAt: new Date().toISOString(),
    triage,
    rootCause,
    issues,
    findings,
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
    '- AgentDebug 主诊断必须只基于 trace、静态检测和 AgentDebug 诊断规程；不要读取或推断 Skills 关键动作分析结果。',
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
      resolution: 'unresolved' as AgentDebugIssueResolution,
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
      resolution: normalizeIssueResolution(optionalStringField(item, 'resolution')),
      resolutionEvidence: optionalStringField(item, 'resolutionEvidence'),
    }))
    .filter(issue => issue.module !== 'unknown');
}

function normalizeFindings(value: unknown, issues: AgentDebugIssue[], root: AgentDebugRootCause | null): AgentDebugFinding[] {
  const issueIds = new Set(issues.map(issue => issue.id));
  const normalized: AgentDebugFinding[] = [];
  const rootOwners = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const refsRaw = Array.isArray(item.issueRefs) ? item.issueRefs : [];
      const refs = refsRaw
        .map(ref => ref && typeof ref === 'object' ? ref as Record<string, unknown> : null)
        .filter((ref): ref is Record<string, unknown> => Boolean(ref))
        .map(ref => ({
          issueId: stringField(ref, 'issueId', ''),
          role: normalizeFindingIssueRole(optionalStringField(ref, 'role')),
        }))
        .filter(ref => ref.issueId && issueIds.has(ref.issueId));

      const dedupedRefs = refs.filter((ref, index) =>
        refs.findIndex(item => item.issueId === ref.issueId) === index
      );
      const rootRefs = dedupedRefs.filter(ref => ref.role === 'root');
      if (rootRefs.length !== 1) continue;
      if (rootOwners.has(rootRefs[0].issueId)) continue;
      rootOwners.add(rootRefs[0].issueId);

      normalized.push({
        id: stringField(item, 'id', `finding-${normalized.length + 1}`),
        severity: normalizeSeverity(stringField(item, 'severity', issueById(issues, rootRefs[0].issueId)?.severity || 'medium')),
        impact: normalizeFindingImpact(optionalStringField(item, 'impact')),
        summary: stringField(item, 'summary', ''),
        evidence: stringField(item, 'evidence', ''),
        issueRefs: dedupedRefs,
        correctionGuidance: stringField(item, 'correctionGuidance', ''),
        confidence: clamp(numberField(item, 'confidence', 0.5)),
      });
    }
  }
  if (normalized.length > 0) return normalized;
  return root ? [findingFromRootCause(root, issues)] : [];
}

function findingFromRootCause(root: AgentDebugRootCause, issues: AgentDebugIssue[]): AgentDebugFinding {
  const refs = issueRefsFromRootCause(root, issues);
  return {
    id: 'finding-root-cause',
    severity: issueById(issues, refs[0]?.issueId)?.severity || 'high',
    impact: 'quality_degrading',
    summary: root.summary,
    evidence: root.evidence,
    issueRefs: refs,
    correctionGuidance: root.correctionGuidance,
    confidence: root.confidence,
  };
}

function issueRefsFromRootCause(root: AgentDebugRootCause, issues: AgentDebugIssue[]): AgentDebugFinding['issueRefs'] {
  const refs: AgentDebugFinding['issueRefs'] = [];
  const rootIssue = issues.find(issue =>
    issue.module === root.criticalModule
    && locationIndexFromIssue(issue) === locationIndexFromRoot(root)
    && (!root.criticalErrorType || issue.errorType === root.criticalErrorType)
  ) || issues.find(issue =>
    issue.module === root.criticalModule
    && locationIndexFromIssue(issue) === locationIndexFromRoot(root)
  );
  if (rootIssue) refs.push({ issueId: rootIssue.id, role: 'root' });
  for (const chainItem of root.cascadingChain) {
    const matched = issues.find(issue =>
      issue.module === chainItem.module
      && locationIndexFromIssue(issue) === (chainItem.traceStepIndex ?? chainItem.step)
      && issue.errorType === chainItem.errorType
    ) || issues.find(issue =>
      issue.module === chainItem.module
      && locationIndexFromIssue(issue) === (chainItem.traceStepIndex ?? chainItem.step)
    );
    if (matched && !refs.some(ref => ref.issueId === matched.id)) {
      refs.push({ issueId: matched.id, role: 'downstream' });
    }
  }
  if (refs.length === 0 && issues[0]) refs.push({ issueId: issues[0].id, role: 'root' });
  return refs;
}

function projectFindingToRootCause(finding: AgentDebugFinding | undefined, issues: AgentDebugIssue[]): AgentDebugRootCause | null {
  if (!finding) return null;
  const rootRef = finding.issueRefs.find(ref => ref.role === 'root') || finding.issueRefs[0];
  const rootIssue = rootRef ? issueById(issues, rootRef.issueId) : null;
  if (!rootIssue) return null;
  return {
    criticalStep: rootIssue.step,
    criticalTraceStepIndex: rootIssue.traceStepIndex ?? rootIssue.step,
    criticalTraceNodeLabel: rootIssue.traceNodeLabel,
    criticalTraceNodeKind: rootIssue.traceNodeKind,
    criticalAnchorId: rootIssue.anchorId,
    criticalModule: rootIssue.module,
    criticalErrorType: rootIssue.errorType,
    summary: finding.summary,
    evidence: finding.evidence,
    cascadingChain: finding.issueRefs
      .filter(ref => ref.issueId !== rootIssue.id)
      .map(ref => issueById(issues, ref.issueId))
      .filter((issue): issue is AgentDebugIssue => Boolean(issue))
      .map(issue => ({
        step: issue.step,
        diagnosticStep: issue.diagnosticStep,
        traceStepIndex: issue.traceStepIndex,
        traceNodeLabel: issue.traceNodeLabel,
        traceNodeKind: issue.traceNodeKind,
        module: issue.module,
        errorType: issue.errorType,
        consequence: issue.reasoning || issue.evidence,
        anchorId: issue.anchorId,
      })),
    correctionGuidance: finding.correctionGuidance,
    confidence: finding.confidence,
  };
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

function normalizeIssueResolution(value: string | undefined): AgentDebugIssueResolution | undefined {
  return value === 'unresolved' || value === 'recovered' || value === 'non_blocking' ? value : undefined;
}

function normalizeFindingIssueRole(value: string | undefined): AgentDebugFindingIssueRole {
  return value === 'contributing' || value === 'downstream' || value === 'root' ? value : 'contributing';
}

function normalizeFindingImpact(value: string | undefined): AgentDebugFindingImpact {
  return value === 'result_blocking' || value === 'quality_degrading' || value === 'recovered_cost' || value === 'risk'
    ? value
    : 'quality_degrading';
}

function issueById(issues: AgentDebugIssue[], id: string | undefined): AgentDebugIssue | null {
  return issues.find(issue => issue.id === id) || null;
}

function locationIndexFromIssue(issue: AgentDebugIssue): number | null {
  return issue.traceStepIndex ?? issue.step ?? null;
}

function locationIndexFromRoot(root: AgentDebugRootCause): number | null {
  return root.criticalTraceStepIndex ?? root.criticalStep ?? null;
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
