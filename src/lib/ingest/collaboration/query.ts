import { prismaRaw } from '@/lib/storage/prisma';

import { deterministicCollaborationEventId } from './contracts';

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

export function goalPlusProjectedWorkerExecutionWhere(user?: string) {
  return {
    goalPlusLinks: {
      some: {
        linkState: 'linked',
        role: { not: 'main' },
        agentSessionDbId: { not: null },
        ...(user ? { source: { user } } : {}),
        goal: {
          is: {
            links: {
              some: {
                role: 'main',
                linkState: 'linked',
              },
            },
          },
        },
      },
    },
  };
}

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

  const rootMainLinks = await prismaRaw.goalPlusExecutionLink.findMany({
    where: {
      executionId: { in: rootExecutionIds },
      role: 'main',
      linkState: 'linked',
      goalDbId: { not: null },
      source: { user },
    },
    select: {
      sourceDbId: true,
      goalDbId: true,
      source: { select: { sourceId: true } },
      goal: { select: { goalPlusId: true } },
    },
  });
  if (!rootMainLinks.length) return { members: [], truncated: false };

  const candidateGoalIds = [...new Set(rootMainLinks
    .map(link => link.goalDbId)
    .filter((id): id is string => Boolean(id)))];
  const activeMainLinks = await prismaRaw.goalPlusExecutionLink.findMany({
    where: {
      goalDbId: { in: candidateGoalIds },
      role: 'main',
      linkState: { in: ['linked', 'ambiguous'] },
      source: { user },
    },
    select: { goalDbId: true, executionId: true, linkState: true },
  });
  const validGoalIds = new Set(candidateGoalIds.filter(goalDbId => {
    const candidates = [...new Map(activeMainLinks
      .filter(link => link.goalDbId === goalDbId)
      .map(link => [link.executionId, link])).values()];
    return candidates.length === 1
      && candidates[0].linkState === 'linked'
      && rootExecutionIds.includes(candidates[0].executionId);
  }));
  if (!validGoalIds.size) return { members: [], truncated: false };

  const mainByGoal = new Map(rootMainLinks
    .filter(link => link.goalDbId && validGoalIds.has(link.goalDbId))
    .map(link => [link.goalDbId as string, link]));
  const sessions = await prismaRaw.goalPlusAgentSession.findMany({
    where: {
      run: {
        goalDbId: { in: [...validGoalIds] },
        source: { user },
      },
    },
    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
    take: GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT,
    include: {
      run: { select: { runId: true, goalDbId: true, sourceDbId: true } },
      links: {
        where: { linkState: 'linked' },
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
  const seenEvents = new Set<string>();
  for (const session of sessions.slice(0, GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT - 1)) {
    const goalDbId = session.run.goalDbId;
    const main = goalDbId ? mainByGoal.get(goalDbId) : undefined;
    const linkedExecutions = [...new Map(session.links
      .filter(link => link.sourceDbId === session.run.sourceDbId && link.goalDbId === goalDbId)
      .map(link => [link.executionId, link.execution])).values()];
    if (!main?.goal || linkedExecutions.length !== 1) continue;
    const execution = linkedExecutions[0];
    if (!execution?.taskId || execution.user !== user || rootExecutionIds.includes(execution.id)) continue;
    const role = session.role || 'candidate-worker';
    const eventId = deterministicCollaborationEventId(
      main.source.sourceId,
      main.goal.goalPlusId,
      'orchestrated',
      session.run.runId,
      session.agentSessionId,
      role,
    );
    if (seenEvents.has(eventId)) continue;
    seenEvents.add(eventId);
    members.push({
      eventId,
      taskId: execution.taskId,
      executionId: execution.id,
      agentName: execution.agentName || execution.subagentName || role || execution.framework || 'Worker Agent',
      framework: execution.framework,
      description: `Goal Plus 编排 ${role}`,
      sourceType: 'goal-plus-semantic',
      relationKind: 'orchestrated',
      anchorState: 'not_provided',
      role,
      timestamp: execution.timestamp,
    });
  }
  members.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.eventId.localeCompare(right.eventId));
  return {
    members,
    truncated: sessions.length >= GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT,
  };
}
