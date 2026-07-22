export type AgentDebugModule = 'memory' | 'reflection' | 'planning' | 'action' | 'system' | 'others' | 'unknown';
export type AgentDebugSeverity = 'high' | 'medium' | 'low';
export type AgentDebugStatus = 'pending' | 'running' | 'done' | 'failed';
export type AgentDebugIssueResolution = 'unresolved' | 'recovered' | 'non_blocking';
export type AgentDebugFindingIssueRole = 'root' | 'contributing' | 'downstream';
export type AgentDebugFindingImpact = 'result_blocking' | 'quality_degrading' | 'recovered_cost' | 'risk';

export interface DebugToolCall {
  id?: string;
  name: string;
  args: unknown;
  output?: unknown;
  status: 'ok' | 'error' | 'unknown';
  startedAt?: number;
  completedAt?: number;
  anchorId?: string;
  traceStepIndex?: number;
  traceNodeLabel?: string;
  traceNodeKind?: string;
  rawError?: string;
}

export interface DebugTurn {
  turnIndex: number;
  sourceInteractionIndex: number;
  agentName?: string;
  role: 'assistant' | 'subagent' | 'opencode';
  text: string;
  reasoningText?: string;
  toolCalls: DebugToolCall[];
  requestContextPreview?: string;
  startedAt?: number;
  completedAt?: number;
  anchorIds: string[];
  traceStepIndex?: number;
  traceNodeLabel?: string;
  traceNodeKind?: string;
}

export interface AgentDebugTraceLocation {
  diagnosticStep?: number;
  traceStepIndex?: number;
  traceNodeLabel?: string;
  traceNodeKind?: string;
}

export interface AgentDebugCandidateWindow {
  id: string;
  reason: string;
  source: 'failure' | 'tool_error' | 'evaluation' | 'fallback';
  centerTurnIndex: number;
  startTurnIndex: number;
  endTurnIndex: number;
  anchorId?: string;
}

export interface AgentDebugIssue extends AgentDebugTraceLocation {
  id: string;
  step: number;
  module: AgentDebugModule;
  errorType: string;
  severity: AgentDebugSeverity;
  evidence: string;
  reasoning: string;
  confidence: number;
  anchorId?: string;
  windowId?: string;
  resolution?: AgentDebugIssueResolution;
  resolutionEvidence?: string;
}

export interface AgentDebugFindingIssueRef {
  issueId: string;
  role: AgentDebugFindingIssueRole;
}

export interface AgentDebugFinding {
  id: string;
  severity: AgentDebugSeverity;
  impact: AgentDebugFindingImpact;
  summary: string;
  evidence: string;
  issueRefs: AgentDebugFindingIssueRef[];
  correctionGuidance: string;
  confidence: number;
  supplementalEvidence?: AgentDebugSupplementalEvidence[];
}

export interface AgentDebugSupplementalEvidence {
  summary: string;
  severity: AgentDebugSeverity;
  facts: string[];
  mechanism: string;
  faultChain: string[];
  anchors: AgentDebugTrajectoryAnchor[];
  correctionGuidance: string;
  confidence: number;
  details: Record<string, unknown>;
}

export type AgentDebugTrajectoryPattern = 'non_termination' | 'no_progress' | 'oscillation' | 'runaway_repetition';

export interface AgentDebugTrajectoryAnchor {
  traceStepIndex?: number;
  traceNodeLabel?: string;
  anchorId?: string;
  sourceInteractionIndex?: number;
  note?: string;
}

/**
 * 轨迹级 finding —— 由确定性「轨迹诊断器」(trajectory-detector) 产出，与逐-step 认知
 * finding (AgentDebugFinding) 并列存在于报告中。它描述"跨区间的循环 / 无进展"这类
 * 时序属性，不绑定单一 criticalStep、不套五模块；展示形态是"故障机制 + 故障链 + 证据节点"。
 * 设计见 docs/agentdebug-diagnosis-principle-and-loop-detection-gap.md。
 */
export interface AgentDebugTrajectoryFinding {
  id: string;
  kind: 'trajectory';
  pattern: AgentDebugTrajectoryPattern;
  severity: AgentDebugSeverity;
  /** 1-2 句结论 */
  summary: string;
  /** 循环 / 无进展所跨的区间（左侧 trace 节点编号 + 原始 interaction 下标） */
  span: {
    fromStep: number | null;
    toStep: number | null;
    fromInteractionIndex: number;
    toInteractionIndex: number;
    turnCount: number;
  };
  /** 主导重复动作在区间内被识别到的次数 */
  cycleCount: number;
  /** 触发循环的代表性动作签名（工具名 + 归一化参数 / 文本指纹） */
  signature: string;
  /** "重复动作占比"等无进展度量的可读描述 */
  noProgressEvidence: string;
  /** 故障机制详解（确定性默认；可由可选 LLM 阶段覆盖为更详细叙事） */
  mechanism: string;
  /** 故障链（区间内主导动作循环的有序描述） */
  faultChain: string[];
  /** 代表性证据节点（举证用，非唯一根因点） */
  anchors: AgentDebugTrajectoryAnchor[];
  correctionGuidance: string;
  confidence: number;
  /** 产出器标识，例如 trajectory-detector@0.1 */
  detector: string;
  /** summary / mechanism / faultChain / correctionGuidance 是否已由 LLM 基于真实证据重写（否则为确定性兜底文案） */
  llmEnriched?: boolean;
}

export interface AgentDebugDetectorFinding {
  id: string;
  kind: string;
  pattern?: string;
  severity: AgentDebugSeverity;
  summary: string;
  facts: string[];
  mechanism: string;
  faultChain: string[];
  anchors: AgentDebugTrajectoryAnchor[];
  correctionGuidance: string;
  confidence: number;
  details: Record<string, unknown>;
  detector?: string;
  llmEnriched?: boolean;
  relatedFindingId?: string;
}

export interface AgentDebugDetectorMergeDecision {
  detectorFindingId: string;
  action: 'merge' | 'independent';
  targetFindingId?: string;
  relatedFindingId?: string;
  reason?: string;
  patch?: {
    severity?: AgentDebugSeverity;
    impact?: AgentDebugFindingImpact;
    confidence?: number;
  };
}

export interface AgentDebugRootCause {
  criticalStep: number | null;
  criticalTraceStepIndex?: number | null;
  criticalTraceNodeLabel?: string;
  criticalTraceNodeKind?: string;
  criticalAnchorId?: string;
  criticalModule: AgentDebugModule;
  criticalErrorType: string;
  summary: string;
  evidence: string;
  cascadingChain: Array<AgentDebugTraceLocation & {
    step: number;
    module: AgentDebugModule;
    errorType: string;
    consequence: string;
    anchorId?: string;
  }>;
  correctionGuidance: string;
  confidence: number;
}

export interface AgentDebugTriage {
  category: 'normal' | 'infra' | 'tool_systemic' | 'early_fatal';
  shortCircuited: boolean;
  fatalDiagnosis?: {
    errorType: string;
    toolName?: string;
    affectedSteps: number[];
    affectedTraceStepIndexes?: number[];
    traceNodeLabel?: string;
    traceNodeKind?: string;
    summary: string;
    recommendation: string;
    rawErrorEvidence: string;
    anchorId?: string;
  } | null;
  prefilterHints?: {
    forceFullSteps: number[];
  };
  notes?: string[];
}

export interface AgentDebugModuleOutput {
  module: Exclude<AgentDebugModule, 'unknown'>;
  content: string;
  confidence: number;
  source: 'tag' | 'llm' | 'raw_tool' | 'implicit' | 'system';
}

export interface AgentDebugStepRecord extends AgentDebugTraceLocation {
  step: number;
  sourceInteractionIndex: number;
  title: string;
  inputContext: string;
  agentOutput: string;
  environmentResponse: string;
  anchorId?: string;
  modules: {
    memory: AgentDebugModuleOutput;
    reflection: AgentDebugModuleOutput;
    planning: AgentDebugModuleOutput;
    action: AgentDebugModuleOutput;
    system: AgentDebugModuleOutput;
  };
}

export interface AgentDebugPhase1Cell extends AgentDebugTraceLocation {
  step: number;
  module: Exclude<AgentDebugModule, 'unknown'>;
  errorDetected: boolean;
  errorType: string;
  severity: AgentDebugSeverity;
  evidence: string;
  reasoning: string;
  confidence: number;
  anchorId?: string;
}

export type AgentDebugSkillsAnalysisStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AgentDebugSkillsKeyActionResult {
  actionId: string;
  actionContent: string;
  coverage: 'covered' | 'partial' | 'missing' | 'not_applicable';
  severity: AgentDebugSeverity;
  traceComparisonAnalysis: string;
  skillImprovementSuggestion: string;
}

export interface AgentDebugSkillSuggestion {
  category: string;
  severity: AgentDebugSeverity;
  summary: string;
  evidence: string;
  improvementSuggestion: string;
}

export interface AgentDebugSkillsAnalysis {
  status: AgentDebugSkillsAnalysisStatus;
  source: 'agent-debug';
  generatedAt?: string;
  updatedAt?: string;
  interactionHash?: string;
  errorMessage?: string | null;
  reasonText?: string;
  skillKeyActionComparison?: unknown;
  keyActionResults?: AgentDebugSkillsKeyActionResult[];
  /** 「建议流」(skill-suggestion-agent) 产出的 skill 改进建议，与关键动作覆盖解耦。 */
  skillSuggestions?: AgentDebugSkillSuggestion[];
}

export interface AgentDebugReportPayload {
  schemaVersion: 1 | 2 | 3;
  generator: string;
  executionId: string;
  interactionHash: string;
  status: 'done';
  generatedAt: string;
  triage?: AgentDebugTriage;
  rootCause: AgentDebugRootCause | null;
  issues: AgentDebugIssue[];
  findings?: AgentDebugFinding[];
  /** 旧报告兼容：读取时会迁移为 detectorFindings。 */
  trajectoryFindings?: AgentDebugTrajectoryFinding[];
  /** 未与 AgentDebug findings 重复、需要单独展示的专项诊断发现。 */
  detectorFindings?: AgentDebugDetectorFinding[];
  phase1Grid?: AgentDebugPhase1Cell[];
  stepRecords?: AgentDebugStepRecord[];
  candidateWindows: AgentDebugCandidateWindow[];
  skillsAnalysis?: AgentDebugSkillsAnalysis;
  modelLabel?: string | null;
  llmPowered?: boolean;
  stats: {
    stepCount: number;
    candidateWindowCount: number;
    issueCount: number;
    llmCallCount: number;
    durationMs: number;
  };
  skippedReason?: string;
}

export interface AgentDebugReportRow {
  id: string;
  executionId: string;
  user: string | null;
  interactionsHash: string;
  status: AgentDebugStatus;
  errorMessage: string | null;
  reportJson: string | null;
  stepCount: number;
  issueCount: number;
  llmCallCount: number;
  durationMs: number | null;
  generator: string;
  ranAt: string | Date;
  updatedAt: string | Date;
}

export interface AgentDebugSkillsAnalysisRow {
  id: string;
  executionId: string;
  user: string | null;
  interactionsHash: string;
  status: AgentDebugSkillsAnalysisStatus;
  errorMessage: string | null;
  analysisJson: string | null;
  keyActionCount: number;
  ranAt: string | Date;
  updatedAt: string | Date;
}
