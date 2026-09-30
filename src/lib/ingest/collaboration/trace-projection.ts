import type { RawInteraction } from '@/lib/engine/observability/agent-trace';

export interface CollaborationTraceRelation {
  sourceType: 'goal-plus-semantic' | 'reported' | string;
  relationKind?: string;
  eventId: string;
  description: string;
  anchorState: string;
  role?: string;
}

export interface CollaborationTraceMember extends CollaborationTraceRelation {
  taskId: string;
  executionId: string;
  agentName: string;
  interactions: RawInteraction[];
  query?: string | null;
}

export interface CollaborationTraceProjection {
  interactions: RawInteraction[];
  includedMembers: number;
  truncated: boolean;
}

const MAX_PROJECTED_MEMBERS = 50;
const MAX_PROJECTED_INTERACTIONS = 20_000;

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function interactionStart(interaction: RawInteraction): number | undefined {
  return toMs(interaction.timeInfo?.created) ?? toMs(interaction.timestamp);
}

function interactionEnd(interaction: RawInteraction): number | undefined {
  return toMs(interaction.timeInfo?.completed) ?? interactionStart(interaction);
}

function memberBounds(interactions: RawInteraction[]): { start?: number; end?: number } {
  const starts = interactions.map(interactionStart).filter((value): value is number => value !== undefined);
  const ends = interactions.map(interactionEnd).filter((value): value is number => value !== undefined);
  return {
    start: starts.length ? Math.min(...starts) : undefined,
    end: ends.length ? Math.max(...ends) : undefined,
  };
}

function relationOf(member: CollaborationTraceMember): CollaborationTraceRelation {
  return {
    sourceType: member.sourceType,
    relationKind: member.relationKind,
    eventId: member.eventId,
    description: member.description,
    anchorState: member.anchorState,
    role: member.role,
  };
}

function projectedMemberInteraction(
  interaction: RawInteraction,
  member: CollaborationTraceMember,
): RawInteraction {
  const relation = relationOf(member);
  const existingSessionId = interaction.subagent_session_id?.trim();
  if (interaction.role === 'system') {
    return {
      ...interaction,
      agent: interaction.agent || member.agentName,
      subagent_name: interaction.subagent_name || member.role || member.agentName,
      subagent_session_id: existingSessionId || member.taskId,
      trace_relation: relation,
    };
  }
  if (interaction.role === 'hook_context') {
    return {
      ...interaction,
      role: 'system',
      agent: interaction.agent || member.agentName,
      subagent_name: interaction.subagent_name || member.role || member.agentName,
      subagent_session_id: existingSessionId || member.taskId,
      trace_relation: relation,
    };
  }
  const projectedRole = existingSessionId
    ? interaction.role
    : interaction.role === 'user'
      ? 'user'
      : interaction.role === 'skill' || interaction.role === 'trace'
        ? interaction.role
        : 'subagent';
  return {
    ...interaction,
    role: projectedRole,
    agent: interaction.agent || member.agentName,
    subagent_name: interaction.subagent_name || member.role || member.agentName,
    subagent_session_id: existingSessionId || member.taskId,
    trace_relation: relation,
  };
}

function syntheticTaskInteraction(
  rootAgentName: string | undefined,
  member: CollaborationTraceMember,
): RawInteraction {
  const bounds = memberBounds(member.interactions);
  const relation = relationOf(member);
  return {
    role: 'assistant',
    agent: rootAgentName,
    content: '',
    timestamp: bounds.start,
    timeInfo: { created: bounds.start, completed: bounds.end },
    trace_synthetic: true,
    trace_relation: relation,
    tool_calls: [{
      id: `collaboration:${member.eventId}`,
      type: 'function',
      function: {
        name: 'task',
        arguments: JSON.stringify({
          subagent_type: member.role || member.agentName,
          description: member.description || member.query || '',
          session_id: member.taskId,
        }),
      },
      state: 'completed',
      timing: { started_at: bounds.start, completed_at: bounds.end },
      output: { session_id: member.taskId },
    }],
  };
}

export function composeCollaborationTrace(
  rootInteractions: RawInteraction[],
  members: CollaborationTraceMember[],
): CollaborationTraceProjection {
  const interactions = [...rootInteractions];
  const rootAgentName = rootInteractions.find(interaction => interaction.agent)?.agent;
  let includedMembers = 0;
  let projectedInteractionCount = 0;
  let truncated = members.length > MAX_PROJECTED_MEMBERS;

  for (const member of members.slice(0, MAX_PROJECTED_MEMBERS)) {
    if (!member.taskId || member.interactions.length === 0) continue;
    const required = member.interactions.length + 1;
    if (projectedInteractionCount + required > MAX_PROJECTED_INTERACTIONS) {
      truncated = true;
      break;
    }
    interactions.push(syntheticTaskInteraction(rootAgentName, member));
    interactions.push(...member.interactions.map(interaction => projectedMemberInteraction(interaction, member)));
    projectedInteractionCount += required;
    includedMembers += 1;
  }

  return { interactions, includedMembers, truncated };
}
