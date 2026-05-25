import { buildAgentCallTree, type RawInteraction } from '@/lib/engine/observability/agent-trace';

export interface TraceSkillRef {
  name: string;
  version: number | null;
}

interface ToolCallLike {
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

interface InteractionLike {
  role?: string;
  content?: unknown;
  subagent_session_id?: string | null;
  subagent_name?: string | null;
  toolCall?: ToolCallLike;
  toolCalls?: ToolCallLike[];
  tool_calls?: ToolCallLike[];
  responseMessage?: {
    tool_calls?: ToolCallLike[];
  };
}

export function getRootSkillFromInteractions(interactions: unknown): TraceSkillRef | null {
  if (!Array.isArray(interactions) || interactions.length === 0) return null;
  const normalized = interactions as InteractionLike[];
  const rootIndexes = getRootInteractionIndexes(normalized);

  for (const index of rootIndexes) {
    const refs = directSkillRefsFromInteraction(normalized[index]);
    if (refs.length > 0) return refs[0];
  }

  return null;
}

function getRootInteractionIndexes(interactions: InteractionLike[]): number[] {
  const tree = buildAgentCallTree(interactions as RawInteraction[]);
  if (tree && Array.isArray(tree.interactionIndices) && tree.interactionIndices.length > 0) {
    return [...tree.interactionIndices].sort((a, b) => a - b);
  }

  return interactions
    .map((interaction, index) => ({ interaction, index }))
    .filter(({ interaction }) => {
      const role = String(interaction.role || '').toLowerCase();
      return role !== 'subagent' && !interaction.subagent_session_id && !interaction.subagent_name;
    })
    .map(item => item.index);
}

function directSkillRefsFromInteraction(interaction: InteractionLike | undefined): TraceSkillRef[] {
  if (!interaction) return [];
  const refs: TraceSkillRef[] = [];
  for (const call of collectToolCalls(interaction)) {
    const name = call.name || call.function?.name;
    const args = parseMaybeJson(call.arguments ?? call.function?.arguments);
    if (name === 'skill' || name === 'load_skill') {
      const ref = skillRefFromArgs(args);
      if (ref) refs.push(ref);
    }
  }
  return dedupeRefs(refs);
}

function collectToolCalls(interaction: InteractionLike): ToolCallLike[] {
  const calls: ToolCallLike[] = [];
  if (interaction.toolCall) calls.push(interaction.toolCall);
  if (Array.isArray(interaction.toolCalls)) calls.push(...interaction.toolCalls);
  if (Array.isArray(interaction.tool_calls)) calls.push(...interaction.tool_calls);
  if (Array.isArray(interaction.responseMessage?.tool_calls)) calls.push(...interaction.responseMessage.tool_calls);
  if (Array.isArray(interaction.content)) {
    for (const item of interaction.content) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if ((record.type === 'toolCall' || record.type === 'tool_use') && typeof record.name === 'string') {
        calls.push({
          name: record.name,
          arguments: record.arguments ?? record.input,
        });
      }
    }
  }
  return calls;
}

function skillRefFromArgs(args: unknown): TraceSkillRef | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  const name = stringValue(record.name)
    || stringValue(record.skill)
    || stringValue(record.skillName)
    || stringValue(record.skill_name);
  if (!name) return null;
  return {
    name,
    version: numberValue(record.version ?? record.skillVersion ?? record.skill_version) ?? null,
  };
}

function dedupeRefs(refs: TraceSkillRef[]): TraceSkillRef[] {
  const seen = new Set<string>();
  const out: TraceSkillRef[] = [];
  for (const ref of refs) {
    const key = `${ref.name}:${ref.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
