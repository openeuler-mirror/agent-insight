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
    };
  }

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
  };
}
