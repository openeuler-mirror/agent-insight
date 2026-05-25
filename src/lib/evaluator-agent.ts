const EVALUATOR_AGENT_KEYWORDS = ['evaluator', 'checker', 'judge', 'locator', 'assessor', 'grader', '评估器'];

const EVALUATOR_TRACE_MARKERS = [
  '你是「轨迹评估器」的总协调者',
  '你是「Agent 任务完成度」评估器',
  'trace-quality-evaluator',
  'task-completion-evaluator',
  'reference_trajectory',
  'actual_trace',
  'key_point_findings',
  'key-points-checker',
  'detect_redundancy_and_loops',
  '已写入 final_result.json',
];

export const EVALUATOR_AGENT_NAMES = new Set([
  'trace-quality-evaluator',
  'completeness-checker',
  'tool-choice-judge',
  'attribution-locator',
  'task-completion-evaluator',
  'key-points-checker',
]);

export interface EvaluatorAgentLike {
  name?: string | null;
  parentAgent?: string | null;
}

export interface EvaluatorTraceLike {
  agent?: string | null;
  agentName?: string | null;
  agents?: string[] | null;
  label?: string | null;
  query?: string | null;
  final_result?: string | null;
}

function normalizeName(value?: string | null): string {
  return String(value || '').trim().toLowerCase();
}

export function isKnownEvaluatorAgentName(name?: string | null): boolean {
  const normalized = normalizeName(name);
  return normalized ? EVALUATOR_AGENT_NAMES.has(normalized) : false;
}

export function isEvaluatorAgentName(name?: string | null): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  if (EVALUATOR_AGENT_NAMES.has(normalized)) return true;
  return EVALUATOR_AGENT_KEYWORDS.some(keyword => normalized.includes(keyword));
}

export function isEvaluatorAgent(agent?: EvaluatorAgentLike | null): boolean {
  if (!agent) return false;
  return isEvaluatorAgentName(agent.name) || isEvaluatorAgentName(agent.parentAgent);
}

export function hasEvaluatorTraceMarker(record?: EvaluatorTraceLike | null): boolean {
  if (!record) return false;
  return [record.query, record.final_result, record.label].some(text => {
    const value = String(text || '');
    return value
      ? EVALUATOR_TRACE_MARKERS.some(marker => value.includes(marker))
      : false;
  });
}

export function isEvaluatorTraceRecord(record?: EvaluatorTraceLike | null): boolean {
  if (!record) return false;
  const names = [
    record.agentName,
    record.agent,
    ...(Array.isArray(record.agents) ? record.agents : []),
  ];
  if (names.some(name => isEvaluatorAgentName(name))) return true;
  return hasEvaluatorTraceMarker(record);
}

export function getPrimaryExecutionAgentName(record?: EvaluatorTraceLike | null): string {
  if (!record) return '';
  const names = [
    record.agentName,
    record.agent,
    ...(Array.isArray(record.agents) ? record.agents : []),
  ];
  const primary = names.find(name => {
    const normalized = String(name || '').trim();
    return normalized && !isEvaluatorAgentName(normalized);
  });
  return String(primary || '').trim();
}
