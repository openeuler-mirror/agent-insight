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
}

export interface AgentDebugReportPayload {
  schemaVersion: 1 | 2;
  generator: string;
  executionId: string;
  interactionHash: string;
  status: 'done';
  generatedAt: string;
  triage?: AgentDebugTriage;
  rootCause: AgentDebugRootCause | null;
  issues: AgentDebugIssue[];
  findings?: AgentDebugFinding[];
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
