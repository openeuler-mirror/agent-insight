/**
 * Tool/Skill 轨迹事实提取器：把不同 Agent trace 统一为可确定性统计的调用序列。
 * 只保留 Tool 与 Skill；Agent、子 Agent 和任务委派不属于本评估器的能力调用。
 */
import {
  canonicalCapabilityKey,
  canonicalToolName,
  type EvaluatorCapabilityDescriptor,
  type EvaluatorCapabilityKind,
} from '@/lib/evaluators/evaluator-case-context';
import {
  buildAgentCallTree,
  walkTree,
  type RawInteraction,
} from '@/lib/engine/observability/agent-trace';
import { isFailedCallStatus } from './specialized-evaluator-common';

export interface ToolTraceFact {
  stepIndex: number;
  anchor: `step-${number}`;
  kind: EvaluatorCapabilityKind;
  name: string;
  canonicalName: string;
  canonicalKey: string;
  args: unknown;
  result: unknown;
  status: string | null;
  /** 从 result/output 提取的错误消息（无则为 null）。 */
  errorMessage: string | null;
  /** 从 result/output 提取的错误码（无则为 null）。 */
  errorCode: string | null;
  /** 工具调用自身 timing（ms since epoch），用于精确计量失败耗时。 */
  startedAt?: number;
  completedAt?: number;
  interactionIndex: number | null;
}

export interface CatalogCapabilityReference {
  kind: EvaluatorCapabilityKind;
  name: string;
  canonicalKey: string;
}

export interface ToolTraceFacts {
  calls: ToolTraceFact[];
  countsByCapability: Record<string, number>;
  calledCatalogCapabilities: CatalogCapabilityReference[];
  unknownCalledCapabilities: CatalogCapabilityReference[];
  /** 轨迹真实 token / 耗时计量（从 interactions 的 usage/timeInfo 聚合，非 LLM 估算）。 */
  usage: TraceUsageFacts;
}

/** 轨迹维度的真实 token 与耗时（供失败影响评估做确定性统计）。 */
export interface TraceUsageFacts {
  /** 总 token（input + output + reasoning + cache）。 */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** 总耗时（ms），首条到末条 interaction 的时间跨度；无法计算时为 undefined。 */
  durationMs?: number;
  /** LLM 调用次数（assistant/subagent/opencode 回合数）。 */
  llmCallCount: number;
  /** 工具调用次数。 */
  toolCallCount: number;
  /** 失败调用所在回合的 token（回合级近似，含生成工具调用前的 LLM 思考，非失败工具本身消耗）。 */
  failedTurnTokens: number;
  /** 失败工具调用自身耗时（用工具 timing.started_at/completed_at 精确计量，ms）。 */
  failedToolDurationMs: number;
}

/** 从工具返回值里提取错误消息与错误码（常见的 error/message/code 结构）。 */
function extractErrorFacts(result: unknown): { errorMessage: string | null; errorCode: string | null } {
  if (result == null) return { errorMessage: null, errorCode: null };
  if (typeof result === 'string') {
    const s = result.trim();
    return s ? { errorMessage: s.slice(0, 500), errorCode: null } : { errorMessage: null, errorCode: null };
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    return { errorMessage: null, errorCode: null };
  }
  const r = result as Record<string, unknown>;
  const message = firstString(r, ['error', 'message', 'error_message', 'errMsg', 'detail', 'reason', 'statusText']);
  const code = firstString(r, ['code', 'error_code', 'errorCode', 'status_code', 'statusCode', 'errno', 'type']);
  return {
    errorMessage: message ? message.slice(0, 500) : null,
    errorCode: code ? code.slice(0, 100) : null,
  };
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  // 嵌套 error 对象（如 { error: { message, code } }）
  for (const key of ['error', 'err']) {
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = firstString(v as Record<string, unknown>, keys);
      if (nested) return nested;
    }
  }
  return null;
}

function skillNameFromArgs(args: unknown, fallback: string): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fallback;
  const raw = args as Record<string, unknown>;
  for (const key of ['name', 'skill', 'skill_name', 'skillName']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

export function extractToolTraceFacts(
  interactions: unknown[],
  availableCapabilities: EvaluatorCapabilityDescriptor[] = [],
): ToolTraceFacts {
  const tree = buildAgentCallTree(interactions as RawInteraction[]);
  if (!tree) {
    return {
      calls: [], countsByCapability: {}, calledCatalogCapabilities: [], unknownCalledCapabilities: [],
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, llmCallCount: 0, toolCallCount: 0, failedTurnTokens: 0, failedToolDurationMs: 0 },
    };
  }

  const usage: TraceUsageFacts = {
    totalTokens: tree.stats.totalTokens,
    inputTokens: tree.stats.inputTokens,
    outputTokens: tree.stats.outputTokens,
    reasoningTokens: tree.stats.reasoningTokens,
    durationMs: tree.stats.durationMs,
    llmCallCount: tree.stats.llmCalls,
    toolCallCount: tree.stats.toolCalls,
    failedTurnTokens: 0,
    failedToolDurationMs: 0,
  };

  const calls: ToolTraceFact[] = [];
  let stepIndex = 0;
  walkTree(tree, (node) => {
    for (const event of node.events) {
      const currentStep = stepIndex;
      stepIndex += 1;
      if (event.kind !== 'tool' && event.kind !== 'skill') continue;
      const fallbackName = String(event.name || 'unknown').trim() || 'unknown';
      const name = event.kind === 'skill' ? skillNameFromArgs(event.args, fallbackName) : fallbackName;
      const errorFacts = extractErrorFacts(event.output);
      calls.push({
        stepIndex: currentStep,
        anchor: `step-${currentStep}`,
        kind: event.kind,
        name,
        canonicalName: canonicalToolName(name),
        canonicalKey: canonicalCapabilityKey(event.kind, name),
        args: event.args,
        result: event.output,
        status: typeof event.toolStatus === 'string' ? event.toolStatus : null,
        errorMessage: errorFacts.errorMessage,
        errorCode: errorFacts.errorCode,
        ...(Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}),
        ...(Number.isFinite(event.completedAt) ? { completedAt: event.completedAt } : {}),
        interactionIndex: Number.isInteger(event.interactionIndex) ? event.interactionIndex : null,
      });
    }
  });

  // 失败消耗计量（口径分离）：
  // - failedTurnTokens：回合级近似——失败调用所在 interaction 的 usage.total 累加。
  //   usage 属于生成该回合（含工具调用前的 LLM 思考），无法精确归因到单个失败工具，故明示为「回合」而非「工具」。
  // - failedToolDurationMs：工具级精确——用工具调用自身 timing.started_at/completed_at 累加。
  const rawInteractions = interactions as RawInteraction[];
  const failedInteractionIdx = new Set<number>();
  for (const call of calls) {
    if (!isFailedCallStatus(call.status)) continue;
    if (Number.isInteger(call.interactionIndex)) failedInteractionIdx.add(call.interactionIndex as number);
    if (Number.isFinite(call.startedAt) && Number.isFinite(call.completedAt) && call.completedAt! > call.startedAt!) {
      usage.failedToolDurationMs += call.completedAt! - call.startedAt!;
    }
  }
  for (const idx of failedInteractionIdx) {
    const it = rawInteractions[idx];
    if (!it) continue;
    const u = it.usage;
    if (u && Number.isFinite(u.total)) usage.failedTurnTokens += u.total ?? 0;
  }

  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.canonicalKey, (counts.get(call.canonicalKey) ?? 0) + 1);
  }
  const catalogByCanonical = new Map(
    availableCapabilities.map((capability) => [
      canonicalCapabilityKey(capability.kind, capability.name),
      capability,
    ]),
  );
  const calledCatalogCapabilities: CatalogCapabilityReference[] = [];
  const unknownCalledCapabilities: CatalogCapabilityReference[] = [];
  for (const canonicalKey of counts.keys()) {
    const catalog = catalogByCanonical.get(canonicalKey);
    if (catalog) {
      calledCatalogCapabilities.push({ kind: catalog.kind, name: catalog.name, canonicalKey });
      continue;
    }
    const call = calls.find((item) => item.canonicalKey === canonicalKey);
    if (call) unknownCalledCapabilities.push({ kind: call.kind, name: call.name, canonicalKey });
  }

  return {
    calls,
    countsByCapability: Object.fromEntries(counts),
    calledCatalogCapabilities,
    unknownCalledCapabilities,
    usage,
  };
}
