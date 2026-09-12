import { prismaRaw } from '@/lib/storage/prisma';
import { Prisma } from '@prisma/client';
import { goalPlusActiveMainSessionIdentities } from '@/lib/ingest/goal-plus/correlate';
import { goalPlusCurrentRunIds } from '@/lib/ingest/goal-plus/trace-scope';

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

export type GoalPlusTraceRootResolution = 'exact-link' | 'active-session-alias' | 'pi-task-alias';

export interface GoalPlusTraceProjectionMembers {
  members: GoalPlusTraceProjectionMemberRef[];
  truncated: boolean;
  rootResolution?: GoalPlusTraceRootResolution;
}

type GoalPlusProjectionMain = {
  sourceDbId: string;
  goalDbId: string;
  source: { sourceId: string };
  goal: { goalPlusId: string; searchTasksJson: string; activeSessionJson: string | null } | null;
};

type Tx = Omit<typeof prismaRaw, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT = 51;

export async function goalPlusProjectedWorkerExecutionWhere(user?: string) {
  return prismaRaw.$transaction(async tx => {
    const goals = await tx.goalPlusGoal.findMany({
      where: user ? { source: { user } } : {},
      select: { activeSessionJson: true },
    });
    const activeIds = [...new Set(goals.flatMap(goal => [...goalPlusActiveMainSessionIds(goal.activeSessionJson)]))];
    const roots = await tx.execution.findMany({
      where: {
        ...(user ? { user } : {}),
        OR: [
          { goalPlusLinks: { some: { role: 'main', linkState: 'linked' } } },
          { taskId: { in: activeIds } },
        ],
      },
      select: { user: true, taskId: true },
    });
    const ids = new Set<string>();
    for (const root of roots) {
      if (!root.user || !root.taskId) continue;
      const session = await tx.session.findUnique({ where: { taskId: root.taskId }, select: { query: true, user: true } });
      if (session?.user !== root.user) continue;
      const projection = await findProjectionMembers(tx, root.user, root.taskId, session.query);
      for (const member of projection.members) ids.add(member.executionId);
    }
    return { id: { in: [...ids] } };
  }, { maxWait: 10_000, timeout: 30_000 });
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function parsePiTaskSessionId(taskId: string): { baseSessionId: string; taskIndex: number } | null {
  const match = /^(.+)__task(\d+)$/.exec(taskId.trim());
  if (!match?.[1]) return null;
  const taskIndex = Number(match[2]);
  return Number.isSafeInteger(taskIndex) ? { baseSessionId: match[1], taskIndex } : null;
}

function goalPlusActiveMainSessionIds(raw: string | null): Set<string> {
  const active = parseJson<Record<string, unknown>>(raw, {});
  const identities = goalPlusActiveMainSessionIdentities(active);
  return identities.length === 1 ? new Set(identities[0].exactIds) : new Set<string>();
}

function isGoalPlusMainQuery(query: string | null | undefined): boolean {
  return /^\s*\/goal-plus(?:\s|$)/i.test(query || '');
}

async function resolveGoalPlusSessionAliasMain(
  tx: Tx,
  user: string,
  sessionId: string,
  rootQuery: string | null | undefined,
  rootExecutions: Array<{ framework: string | null }>,
): Promise<GoalPlusProjectionMain | null> {
  if (!sessionId || !rootExecutions.length || rootExecutions.some(execution => execution.framework !== 'pi-agent')) {
    return null;
  }
  if (!isGoalPlusMainQuery(rootQuery)) return null;

  const possibleGoals = await tx.goalPlusGoal.findMany({
    where: {
      source: { user },
      activeSessionJson: { contains: sessionId },
    },
    select: {
      id: true,
      sourceDbId: true,
      goalPlusId: true,
      activeSessionJson: true,
      searchTasksJson: true,
      source: { select: { sourceId: true } },
    },
  });
  const matchingGoals = possibleGoals.filter(goal => (
    goalPlusActiveMainSessionIds(goal.activeSessionJson).has(sessionId)
  ));
  if (matchingGoals.length !== 1) return null;

  const goal = matchingGoals[0];
  const activeMainLinks = await tx.goalPlusExecutionLink.findMany({
    where: {
      sourceDbId: goal.sourceDbId,
      goalDbId: goal.id,
      role: 'main',
      linkState: { in: ['linked', 'ambiguous'] },
      source: { user },
    },
    select: { executionId: true, linkState: true },
  });
  const candidates = [...new Map(activeMainLinks.map(link => [link.executionId, link])).values()];
  if (candidates.length !== 1 || candidates[0].linkState !== 'linked') return null;

  return {
    sourceDbId: goal.sourceDbId,
    goalDbId: goal.id,
    source: goal.source,
    goal: { goalPlusId: goal.goalPlusId, searchTasksJson: goal.searchTasksJson, activeSessionJson: goal.activeSessionJson },
  };
}

async function resolvePiTaskAliasMain(
  tx: Tx,
  user: string,
  rootTaskId: string,
  rootQuery: string | null | undefined,
  rootExecutions: Array<{ framework: string | null }>,
): Promise<GoalPlusProjectionMain | null> {
  const alias = parsePiTaskSessionId(rootTaskId);
  if (!alias) return null;
  return resolveGoalPlusSessionAliasMain(tx, user, alias.baseSessionId, rootQuery, rootExecutions);
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
  rootQuery?: string | null,
): Promise<GoalPlusTraceProjectionMembers> {
  return prismaRaw.$transaction(tx => findProjectionMembers(tx, user, rootTaskId, rootQuery), { maxWait: 10_000, timeout: 30_000 });
}

async function findProjectionMembers(
  tx: Tx,
  user: string,
  rootTaskId: string,
  rootQuery?: string | null,
): Promise<GoalPlusTraceProjectionMembers> {
  const rootExecutions = await tx.execution.findMany({
    where: { user, taskId: rootTaskId },
    select: { id: true, framework: true, taskId: true, agentSessionId: true },
  });
  const rootExecutionIds = rootExecutions.map(execution => execution.id);
  if (!rootExecutionIds.length) return { members: [], truncated: false };

  const exactMainLinks = await tx.goalPlusExecutionLink.findMany({
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
      goal: { select: { goalPlusId: true, searchTasksJson: true, activeSessionJson: true } },
    },
  });
  const rootMainLinks = exactMainLinks.filter(link => {
    const activeIds = goalPlusActiveMainSessionIds(link.goal?.activeSessionJson ?? null);
    return activeIds.size > 0 && rootExecutions.some(execution => (
      [execution.taskId, execution.agentSessionId].some(id => id && activeIds.has(id))
    ));
  });
  let rootResolution: GoalPlusTraceRootResolution;
  let mainByGoal: Map<string, GoalPlusProjectionMain>;
  let validGoalIds: Set<string>;
  if (rootMainLinks.length) {
    const candidateGoalIds = [...new Set(rootMainLinks
      .map(link => link.goalDbId)
      .filter((id): id is string => Boolean(id)))];
    const activeMainLinks = await tx.goalPlusExecutionLink.findMany({
      where: {
        goalDbId: { in: candidateGoalIds },
        role: 'main',
        linkState: { in: ['linked', 'ambiguous'] },
        source: { user },
      },
      select: { goalDbId: true, executionId: true, linkState: true },
    });
    validGoalIds = new Set(candidateGoalIds.filter(goalDbId => {
      const candidates = [...new Map(activeMainLinks
        .filter(link => link.goalDbId === goalDbId)
        .map(link => [link.executionId, link])).values()];
      return candidates.length === 1
        && candidates[0].linkState === 'linked'
        && rootExecutionIds.includes(candidates[0].executionId);
    }));
    if (!validGoalIds.size) return { members: [], truncated: false };
    mainByGoal = new Map(rootMainLinks
      .filter(link => link.goalDbId && validGoalIds.has(link.goalDbId))
      .map(link => [link.goalDbId as string, { ...link, goalDbId: link.goalDbId as string }]));
    rootResolution = 'exact-link';
  } else {
    let aliasMain = await resolveGoalPlusSessionAliasMain(tx, user, rootTaskId, rootQuery, rootExecutions);
    rootResolution = 'active-session-alias';
    if (!aliasMain) {
      aliasMain = await resolvePiTaskAliasMain(tx, user, rootTaskId, rootQuery, rootExecutions);
      rootResolution = 'pi-task-alias';
    }
    if (!aliasMain) return { members: [], truncated: false };
    validGoalIds = new Set([aliasMain.goalDbId]);
    mainByGoal = new Map([[aliasMain.goalDbId, aliasMain]]);
  }
  const runScopes = [...mainByGoal.values()].flatMap(main => {
    const runIds = goalPlusCurrentRunIds(main.goal?.searchTasksJson ?? null);
    return runIds.length ? [{ sourceDbId: main.sourceDbId, goalDbId: main.goalDbId, runId: { in: runIds } }] : [];
  });
  if (!runScopes.length) return { members: [], truncated: false, rootResolution };
  const sessions = await tx.goalPlusAgentSession.findMany({
    where: {
      run: {
        OR: runScopes,
        source: { user },
      },
    },
    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
    include: {
      run: { select: { runId: true, goalDbId: true, sourceDbId: true } },
      candidate: { select: { candidateId: true } },
      links: {
        where: { linkState: { in: ['linked', 'ambiguous'] } },
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
  const taskIds = [...new Set(sessions.flatMap(session => session.links.flatMap(link => link.execution.taskId ? [link.execution.taskId] : [])))];
  const interactionCounts = new Map<string, number>();
  for (let offset = 0; offset < taskIds.length; offset += 500) {
    const counts = await tx.$queryRaw<Array<{ taskId: string; interactionCount: number | bigint }>>(Prisma.sql`
      SELECT taskId, CASE WHEN json_valid(interactions) THEN json_array_length(interactions) ELSE 0 END AS interactionCount
      FROM Session WHERE user = ${user} AND taskId IN (${Prisma.join(taskIds.slice(offset, offset + 500))})
    `);
    for (const row of counts) interactionCounts.set(row.taskId, Number(row.interactionCount));
  }
  const seenEvents = new Set<string>();
  for (const session of sessions) {
    const goalDbId = session.run.goalDbId;
    const main = goalDbId ? mainByGoal.get(goalDbId) : undefined;
    const linkedExecutions = [...new Map(session.links
      .filter(link => link.sourceDbId === session.run.sourceDbId && link.goalDbId === goalDbId
        && link.runDbId === session.runDbId && link.candidateDbId === session.candidateDbId)
      .map(link => [link.executionId, link.execution])).values()];
    if (!main?.goal || linkedExecutions.length !== 1 || session.links.some(link => link.linkState === 'ambiguous')) continue;
    const execution = linkedExecutions[0];
    if (!execution?.taskId || !interactionCounts.get(execution.taskId)
      || execution.user !== user || rootExecutionIds.includes(execution.id)) continue;
    const role = session.role || 'candidate-worker';
    const displayRole = `${role} · ${session.candidate?.candidateId || session.agentSessionId}`;
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
      description: `Goal Plus 编排 ${displayRole} · ${session.run.runId}`,
      sourceType: 'goal-plus-semantic',
      relationKind: 'orchestrated',
      anchorState: 'not_provided',
      role: displayRole,
      timestamp: execution.timestamp,
    });
  }
  members.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.eventId.localeCompare(right.eventId));
  const included: GoalPlusTraceProjectionMemberRef[] = [];
  let interactionCount = 0;
  for (const member of members) {
    const required = (interactionCounts.get(member.taskId) || 0) + 1;
    if (included.length >= GOAL_PLUS_TRACE_PROJECTION_MEMBER_LIMIT - 1 || interactionCount + required > 20_000) break;
    included.push(member);
    interactionCount += required;
  }
  return {
    members: included,
    truncated: included.length < members.length,
    rootResolution,
  };
}
