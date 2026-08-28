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
  /** 失败工具调用所浪费的 token（失败调用所在回合的 usage 累加）。 */
  failedTokens: number;
  /** 失败工具调用所浪费的时间（失败调用所在回合的耗时累加，ms）。 */
  failedDurationMs: number;
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

/** 时间戳 → ms（兼容 Unix 秒 / 毫秒 / ISO 字符串）。 */
function toMs(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 0 && v < 10_000_000_000 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return undefined;
      return n > 0 && n < 10_000_000_000 ? n * 1000 : n;
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function extractToolTraceFacts(
  interactions: unknown[],
  availableCapabilities: EvaluatorCapabilityDescriptor[] = [],
): ToolTraceFacts {
  const tree = buildAgentCallTree(interactions as RawInteraction[]);
  if (!tree) {
    return {
      calls: [], countsByCapability: {}, calledCatalogCapabilities: [], unknownCalledCapabilities: [],
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, llmCallCount: 0, toolCallCount: 0, failedTokens: 0, failedDurationMs: 0 },
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
    failedTokens: 0,
    failedDurationMs: 0,
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
        interactionIndex: Number.isInteger(event.interactionIndex) ? event.interactionIndex : null,
      });
    }
  });

  // 失败消耗：失败工具调用所在回合的 token 与耗时（非 LLM 估算，从原始 interaction 计量）。
  // 用 interactionIndex 反查原始 interactions，累加该回合的 usage.total 与 timeInfo 跨度。
  const rawInteractions = interactions as RawInteraction[];
  const failedInteractionIdx = new Set<number>();
  for (const call of calls) {
    if (!isFailedCallStatus(call.status)) continue;
    if (Number.isInteger(call.interactionIndex)) failedInteractionIdx.add(call.interactionIndex as number);
  }
  for (const idx of failedInteractionIdx) {
    const it = rawInteractions[idx];
    if (!it) continue;
    const u = it.usage;
    if (u && Number.isFinite(u.total)) usage.failedTokens += u.total;
    const created = toMs(it.timeInfo?.created) ?? toMs(it.timestamp);
    const completed = toMs(it.timeInfo?.completed);
    if (created != null && completed != null && completed > created) {
      usage.failedDurationMs += completed - created;
    }
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
