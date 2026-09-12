import { prismaRaw } from '@/lib/storage/prisma';

export interface GoalPlusTraceProjectionMemberRef {
  eventId: string;
  taskId: string;
  executionId: string;
  agentName: string;
  framework: string | null;
  description: string;
  sourceType: string;
  relationKind?: string;
  anchorState: string;
  role?: string;
  timestamp: Date;
}

const GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT = 51;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function listCollaborations(user: string, options: { limit?: number; cursor?: string } = {}) {
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  const rows = await prismaRaw.collaboration.findMany({
    where: { user },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: { _count: { select: { events: true } } },
  });
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(row => ({
      collaborationId: row.collaborationId,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      eventCount: row._count.events,
      diagnostics: parseJson(row.diagnosticsJson, []),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    nextCursor: hasMore ? rows[limit - 1].id : null,
  };
}

export async function getCollaboration(user: string, collaborationId: string) {
  const collaboration = await prismaRaw.collaboration.findUnique({
    where: { user_collaborationId: { user, collaborationId } },
    include: {
      events: {
        orderBy: [{ observedAt: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
        include: {
          endpointResolutions: {
            include: {
              execution: {
                select: {
                  id: true,
                  taskId: true,
                  agentSessionId: true,
                  framework: true,
                  agentName: true,
                  subagentName: true,
                  parentExecutionId: true,
                  timestamp: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!collaboration) return null;

  const nodeMap = new Map<string, {
    sessionId: string;
    executionIds: Set<string>;
    states: Set<string>;
    executions: Map<string, Record<string, unknown>>;
  }>();
  const node = (sessionId: string) => {
    const current = nodeMap.get(sessionId) || {
      sessionId,
      executionIds: new Set<string>(),
      states: new Set<string>(),
      executions: new Map<string, Record<string, unknown>>(),
    };
    nodeMap.set(sessionId, current);
    return current;
  };

  const events = collaboration.events.map(event => {
    const resolutions = Object.fromEntries(event.endpointResolutions.map(resolution => {
      const sessionId = resolution.side === 'from' ? event.fromSessionId! : event.toSessionId!;
      const current = node(sessionId);
      current.states.add(resolution.linkState);
      if (resolution.execution) {
        current.executionIds.add(resolution.execution.id);
        current.executions.set(resolution.execution.id, resolution.execution);
      }
      return [resolution.side, {
        linkState: resolution.linkState,
        linkMethod: resolution.linkMethod,
        execution: resolution.execution,
        evidence: parseJson(resolution.evidenceJson, {}),
        ...(resolution.side === 'from' ? {
          anchor: {
            status: resolution.anchorState || 'pending',
            ...parseJson<Record<string, unknown>>(resolution.anchorJson, {}),
          },
        } : {}),
      }];
    }));
    node(event.fromSessionId!);
    node(event.toSessionId!);
    return {
      eventId: event.eventId,
      fromSessionId: event.fromSessionId,
      toSessionId: event.toSessionId,
      description: event.description,
      observedAt: event.observedAt,
      content: event.content,
      fromLocator: parseJson(event.fromLocatorJson, null),
      sourceType: event.sourceType,
      sourceRef: event.sourceRef,
      relationKind: event.relationKind,
      role: event.role,
      receivedAt: event.receivedAt,
      resolutions,
    };
  });

  const nodes = [...nodeMap.values()].map(item => ({
    sessionId: item.sessionId,
    resolutionState: item.executionIds.size === 1 && !item.states.has('ambiguous')
      ? 'linked'
      : item.executionIds.size > 1 || item.states.has('ambiguous') ? 'ambiguous' : 'pending',
    executions: [...item.executions.values()],
  }));
  return {
    collaborationId: collaboration.collaborationId,
    sourceType: collaboration.sourceType,
    sourceRef: collaboration.sourceRef,
    diagnostics: parseJson(collaboration.diagnosticsJson, []),
    createdAt: collaboration.createdAt,
    updatedAt: collaboration.updatedAt,
    nodes,
    events,
  };
}

export async function findGoalPlusTraceProjectionMembers(
  user: string,
  rootTaskId: string,
): Promise<{ members: GoalPlusTraceProjectionMemberRef[]; truncated: boolean }> {
  const rootExecutions = await prismaRaw.execution.findMany({
    where: { user, taskId: rootTaskId },
    select: { id: true },
  });
  const rootExecutionIds = rootExecutions.map(execution => execution.id);
  if (!rootExecutionIds.length) return { members: [], truncated: false };

  const events = await prismaRaw.collaborationEvent.findMany({
    where: {
      sourceType: 'goal-plus-semantic',
      relationKind: 'orchestrated',
      collaboration: { user },
      endpointResolutions: {
        some: {
          side: 'from',
          linkState: 'linked',
          executionId: { in: rootExecutionIds },
        },
      },
    },
    orderBy: [{ receivedAt: 'asc' }, { eventId: 'asc' }],
    take: GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT,
    include: {
      endpointResolutions: {
        where: { linkState: 'linked', side: { in: ['from', 'to'] } },
        include: {
          execution: {
            select: {
              id: true,
              taskId: true,
              user: true,
              framework: true,
              agentName: true,
              subagentName: true,
              timestamp: true,
            },
          },
        },
      },
    },
  });

  const members: GoalPlusTraceProjectionMemberRef[] = [];
  for (const event of events.slice(0, GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT - 1)) {
    const from = event.endpointResolutions.find(resolution => (
      resolution.side === 'from' && resolution.executionId && rootExecutionIds.includes(resolution.executionId)
    ));
    const to = event.endpointResolutions.find(resolution => resolution.side === 'to');
    const execution = to?.execution;
    if (!from || !execution?.taskId || execution.user !== user || rootExecutionIds.includes(execution.id)) continue;
    members.push({
      eventId: event.eventId,
      taskId: execution.taskId,
      executionId: execution.id,
      agentName: execution.agentName || execution.subagentName || event.role || execution.framework || 'Worker Agent',
      framework: execution.framework,
      description: event.description || `Goal Plus 编排 ${event.role || 'worker'}`,
      sourceType: event.sourceType,
      relationKind: event.relationKind || undefined,
      anchorState: from.anchorState || 'not_provided',
      role: event.role || undefined,
      timestamp: execution.timestamp,
    });
  }
  members.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.eventId.localeCompare(right.eventId));
  return {
    members,
    truncated: events.length >= GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT,
  };
}
