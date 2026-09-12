import { prismaRaw } from '@/lib/storage/prisma';

import {
  deterministicCollaborationEventId,
  deterministicCollaborationId,
  type CollaborationEventInput,
} from '../contracts';
import {
  persistCollaborationEvent,
  updateCollaborationDiagnostics,
  type CollaborationEndpointHint,
} from '../persist';

type GoalPlusProjectionDiagnostic = {
  code: 'main-trace-pending' | 'ambiguous-main-session';
  goalPlusId: string;
  candidateCount: number;
};

export function goalPlusCollaborationIdentity(sourceId: string, goalPlusId: string) {
  return {
    collaborationId: deterministicCollaborationId(sourceId, goalPlusId),
    sourceRef: `goal-plus:${sourceId}:${goalPlusId}`,
    mainSessionId: `goal-plus:${sourceId}:goal:${goalPlusId}:main`,
  };
}

export function goalPlusCollaborationEventIdentity(
  sourceId: string,
  goalPlusId: string,
  runId: string,
  agentSessionId: string,
  role: string,
): string {
  return deterministicCollaborationEventId(
    sourceId,
    goalPlusId,
    'orchestrated',
    runId,
    agentSessionId,
    role,
  );
}

export function goalPlusEndpointHint(
  candidates: Array<{ executionId: string; linkMethod: string; linkState: string }>,
  evidence: Record<string, unknown>,
): CollaborationEndpointHint {
  const linked = [...new Map(candidates
    .filter(candidate => candidate.linkState === 'linked')
    .map(candidate => [candidate.executionId, candidate])).values()];
  const possible = [...new Set(candidates
    .filter(candidate => ['linked', 'ambiguous'].includes(candidate.linkState))
    .map(candidate => candidate.executionId))];
  if (linked.length === 1 && possible.length === 1) {
    return {
      state: 'linked',
      executionId: linked[0].executionId,
      method: 'goal-plus-execution-link',
      evidence: { ...evidence, goalPlusLinkMethod: linked[0].linkMethod },
    };
  }
  return {
    state: possible.length ? 'ambiguous' : 'pending',
    method: possible.length ? 'goal-plus-execution-link' : undefined,
    evidence: { ...evidence, candidateExecutionIds: possible },
  };
}

export async function projectGoalPlusCollaborations(sourceDbId: string): Promise<{
  collaborations: number;
  projectedEvents: number;
  linkedEndpoints: number;
  ambiguousMainSessions: number;
}> {
  const source = await prismaRaw.goalPlusSource.findUnique({
    where: { id: sourceDbId },
    select: { id: true, user: true, sourceId: true },
  });
  if (!source) return { collaborations: 0, projectedEvents: 0, linkedEndpoints: 0, ambiguousMainSessions: 0 };
  const goals = await prismaRaw.goalPlusGoal.findMany({
    where: { sourceDbId },
    select: { id: true, goalPlusId: true },
  });
  let projectedEvents = 0;
  let linkedEndpoints = 0;
  let ambiguousMainSessions = 0;

  for (const goal of goals) {
    const identity = goalPlusCollaborationIdentity(source.sourceId, goal.goalPlusId);
    const metadata = {
      collaborationId: identity.collaborationId,
      sourceType: 'goal-plus-semantic' as const,
      sourceRef: identity.sourceRef,
    };
    const [mainLinks, sessions] = await Promise.all([
      prismaRaw.goalPlusExecutionLink.findMany({
        where: {
          sourceDbId,
          goalDbId: goal.id,
          role: 'main',
          linkState: { in: ['linked', 'ambiguous'] },
        },
        select: { executionId: true, linkMethod: true, linkState: true },
      }),
      prismaRaw.goalPlusAgentSession.findMany({
        where: { run: { sourceDbId, goalDbId: goal.id } },
        include: {
          run: { select: { runId: true } },
          links: {
            where: { linkState: { in: ['linked', 'ambiguous'] } },
            select: { executionId: true, linkMethod: true, linkState: true },
          },
        },
      }),
    ]);
    const mainHint = goalPlusEndpointHint(mainLinks, {
      sourceId: source.sourceId,
      goalPlusId: goal.goalPlusId,
      evidence: 'goal-main-membership',
    });
    const diagnostics: GoalPlusProjectionDiagnostic[] = [];
    if (mainHint.state === 'ambiguous') {
      ambiguousMainSessions += 1;
      diagnostics.push({
        code: 'ambiguous-main-session',
        goalPlusId: goal.goalPlusId,
        candidateCount: (mainHint.evidence?.candidateExecutionIds as unknown[] | undefined)?.length || 0,
      });
    } else if (mainHint.state === 'pending') {
      diagnostics.push({ code: 'main-trace-pending', goalPlusId: goal.goalPlusId, candidateCount: 0 });
    }
    const collaboration = await updateCollaborationDiagnostics(source.user, metadata, diagnostics);
    const desiredEventIds = new Set<string>();

    for (const session of sessions) {
      const role = session.role || 'candidate-worker';
      const eventId = goalPlusCollaborationEventIdentity(
        source.sourceId,
        goal.goalPlusId,
        session.run.runId,
        session.agentSessionId,
        role,
      );
      desiredEventIds.add(eventId);
      const input: CollaborationEventInput = {
        collaborationId: metadata.collaborationId,
        sourceType: metadata.sourceType,
        collaborationSourceRef: identity.sourceRef,
        eventId,
        fromSessionId: identity.mainSessionId,
        toSessionId: `goal-plus:${source.sourceId}:${session.agentSessionId}`,
        description: `Goal Plus 编排 ${role}`,
        relationKind: 'orchestrated',
        role,
        sourceRef: `${identity.sourceRef}:${session.run.runId}:${session.agentSessionId}:${role}`,
      };
      const targetHint = goalPlusEndpointHint(session.links, {
        sourceId: source.sourceId,
        goalPlusId: goal.goalPlusId,
        runId: session.run.runId,
        agentSessionId: session.agentSessionId,
        role,
        evidence: 'goal-membership',
      });
      const persisted = await persistCollaborationEvent(source.user, input, {
        endpointHints: { from: mainHint, to: targetHint },
      });
      await prismaRaw.collaborationEndpointResolution.update({
        where: { eventDbId_side: { eventDbId: persisted.eventDbId, side: 'from' } },
        data: {
          anchorState: 'not_provided',
          anchorJson: JSON.stringify({
            message: 'Goal Plus 仅提供编排成员关系，未推断具体启动调用位置',
            evidence: 'goal-membership',
          }),
        },
      });
      projectedEvents += 1;
      if (mainHint.state === 'linked') linkedEndpoints += 1;
      if (targetHint.state === 'linked') linkedEndpoints += 1;
    }

    const obsolete = await prismaRaw.collaborationEvent.findMany({
      where: {
        collaborationDbId: collaboration.id,
        sourceType: 'goal-plus-semantic',
        eventId: { notIn: [...desiredEventIds] },
      },
      select: { id: true },
    });
    if (obsolete.length) {
      await prismaRaw.collaborationEndpointResolution.updateMany({
        where: { eventDbId: { in: obsolete.map(event => event.id) } },
        data: { linkState: 'superseded', executionId: null, resolvedAt: new Date() },
      });
    }
  }
  return {
    collaborations: goals.length,
    projectedEvents,
    linkedEndpoints,
    ambiguousMainSessions,
  };
}
