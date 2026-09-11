import { prismaRaw } from '@/lib/storage/prisma';

type LinkIntent = {
  key: string;
  role: string;
  goalDbId?: string;
  runDbId?: string;
  candidateDbId?: string;
  agentSessionDbId?: string;
  exactIds: string[];
  taskName?: string;
  expectedFramework?: 'pi-agent' | 'codex';
};

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function parseArray(raw: string | null): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
      : [];
  } catch {
    return [];
  }
}

function nonempty(...values: unknown[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => String(value).trim()))];
}

export function goalPlusFrameworkForHost(host: unknown): LinkIntent['expectedFramework'] {
  if (host === 'pi' || host === 'pi-rpc' || host === 'pi-agent') return 'pi-agent';
  if (host === 'codex') return 'codex';
  return undefined;
}

export function goalPlusCodexExecutionId(metadata: Record<string, unknown>): string | undefined {
  const direct = typeof metadata.codexExecutionId === 'string'
    ? metadata.codexExecutionId.trim()
    : typeof metadata.executionId === 'string' ? metadata.executionId.trim() : '';
  if (direct) return direct;
  const conversationId = typeof metadata.codexConversationId === 'string'
    ? metadata.codexConversationId.trim()
    : typeof metadata.conversationId === 'string' ? metadata.conversationId.trim() : '';
  const turnId = typeof metadata.codexTurnId === 'string'
    ? metadata.codexTurnId.trim()
    : typeof metadata.turnId === 'string' ? metadata.turnId.trim() : '';
  return conversationId && turnId ? `${conversationId}:turn:${turnId}` : undefined;
}

async function sourceLinkIntents(sourceDbId: string, sourceId: string): Promise<LinkIntent[]> {
  const [goals, sessions] = await Promise.all([
    prismaRaw.goalPlusGoal.findMany({ where: { sourceDbId } }),
    prismaRaw.goalPlusAgentSession.findMany({
      where: { run: { sourceDbId } },
      include: { run: true, candidate: true },
    }),
  ]);
  const intents: LinkIntent[] = [];
  for (const goal of goals) {
    const active = parseObject(goal.activeSessionJson);
    const discoveredMain = Array.isArray(active.mainSessions)
      ? active.mainSessions.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
      : [];
    const mainSessions = [active, ...discoveredMain]
      .map((session, index) => ({
        session,
        index,
        exactIds: nonempty(
          goalPlusCodexExecutionId(session),
          session.sessionId,
          session.nativeSessionId,
        ),
      }))
      .filter(item => item.exactIds.length > 0)
      .filter((item, index, items) => items.findIndex(candidate => (
        candidate.exactIds.some(id => item.exactIds.includes(id))
      )) === index);
    for (const { session, index, exactIds } of mainSessions) {
      intents.push({
        key: `goal:${goal.id}:main:${index}`,
        role: 'main',
        goalDbId: goal.id,
        exactIds,
        expectedFramework: goalPlusFrameworkForHost(session.host || active.host),
      });
    }
    for (const item of parseArray(goal.workItemsJson)) {
      if (item.route === 'search') continue;
      const workItemId = typeof item.workItemId === 'string' ? item.workItemId : 'unknown';
      intents.push({
        key: `goal:${goal.id}:work:${workItemId}`,
        role: `work-item:${workItemId}`,
        goalDbId: goal.id,
        exactIds: nonempty(item.agentId),
        taskName: typeof item.taskName === 'string' ? item.taskName : undefined,
        expectedFramework: goalPlusFrameworkForHost(item.host),
      });
    }
    for (const check of parseArray(goal.finalChecksJson)) {
      const metadata = check.checkerMetadata && typeof check.checkerMetadata === 'object'
        ? check.checkerMetadata as Record<string, unknown>
        : {};
      const checkId = typeof check.checkId === 'string' ? check.checkId : 'unknown';
      intents.push({
        key: `goal:${goal.id}:check:${checkId}`,
        role: `final-check:${checkId}`,
        goalDbId: goal.id,
        exactIds: nonempty(goalPlusCodexExecutionId(metadata), metadata.sessionId, metadata.agentId, metadata.externalId),
        taskName: typeof metadata.taskName === 'string' ? metadata.taskName : undefined,
        expectedFramework: goalPlusFrameworkForHost(check.checkerHost || metadata.host),
      });
    }
  }
  for (const session of sessions) {
    const hostMetadata = parseObject(session.hostMetadataJson);
    intents.push({
      key: `session:${session.id}`,
      role: session.role || 'candidate-worker',
      goalDbId: session.run.goalDbId || undefined,
      runDbId: session.runDbId,
      candidateDbId: session.candidateDbId || undefined,
      agentSessionDbId: session.id,
      exactIds: nonempty(
        goalPlusCodexExecutionId(hostMetadata),
        `goal-plus:${sourceId}:${session.agentSessionId}`,
        session.nativeSessionId,
        session.agentSessionId,
      ),
      taskName: session.taskName || undefined,
      expectedFramework: goalPlusFrameworkForHost(session.host),
    });
  }
  return intents.filter(intent => intent.exactIds.length > 0 || intent.taskName);
}

export async function relinkGoalPlusSource(sourceDbId: string): Promise<{ linked: number; ambiguous: number; unresolved: number }> {
  const source = await prismaRaw.goalPlusSource.findUnique({ where: { id: sourceDbId } });
  if (!source) return { linked: 0, ambiguous: 0, unresolved: 0 };
  const intents = await sourceLinkIntents(sourceDbId, source.sourceId);
  const duplicateTaskNames = new Set<string>();
  const taskNameCounts = new Map<string, number>();
  for (const intent of intents) {
    if (!intent.taskName) continue;
    taskNameCounts.set(intent.taskName, (taskNameCounts.get(intent.taskName) || 0) + 1);
  }
  for (const [name, count] of taskNameCounts) if (count > 1) duplicateTaskNames.add(name);

  await prismaRaw.goalPlusExecutionLink.updateMany({
    where: { sourceDbId, linkState: { in: ['linked', 'ambiguous'] } },
    data: { linkState: 'superseded' },
  });

  let linked = 0;
  let ambiguous = 0;
  let unresolved = 0;
  for (const intent of intents) {
    const exactMatches = intent.exactIds.length
      ? await prismaRaw.execution.findMany({
        where: {
          user: source.user,
          ...(intent.expectedFramework ? { framework: intent.expectedFramework } : {}),
          OR: [
            { taskId: { in: intent.exactIds } },
            { agentSessionId: { in: intent.exactIds } },
          ],
        },
        select: { id: true, taskId: true, agentSessionId: true, framework: true },
      })
      : [];
    let candidates = exactMatches.map(execution => {
      const passive = [execution.taskId, execution.agentSessionId]
        .some(value => value?.startsWith(`goal-plus:${source.sourceId}:`));
      return {
        execution,
        method: passive ? 'pi_native_passive' : 'native_session_id',
        priority: passive ? 3 : 1,
      };
    });
    if (candidates.length === 0 && intent.taskName && !duplicateTaskNames.has(intent.taskName)) {
      const matches = await prismaRaw.execution.findMany({
        where: {
          user: source.user,
          ...(intent.expectedFramework ? { framework: intent.expectedFramework } : {}),
          OR: [
            { taskId: intent.taskName },
            { agentSessionId: intent.taskName },
            { agentName: intent.taskName },
            { subagentName: intent.taskName },
          ],
        },
        select: { id: true, taskId: true, agentSessionId: true, framework: true },
      });
      candidates = matches.map(execution => ({ execution, method: 'task_name', priority: 4 }));
    }
    const unique = [...new Map(candidates
      .sort((left, right) => left.priority - right.priority)
      .map(candidate => [candidate.execution.id, candidate])).values()];
    if (unique.length === 0) {
      unresolved += 1;
      continue;
    }
    const winnerPriority = Math.min(...unique.map(candidate => candidate.priority));
    const winners = unique.filter(candidate => candidate.priority === winnerPriority);
    const state = winners.length === 1 ? 'linked' : 'ambiguous';
    if (state === 'linked') linked += 1;
    else ambiguous += 1;
    for (const candidate of unique) {
      const { execution, method, priority } = candidate;
      const candidateState = priority === winnerPriority ? state : 'superseded';
      await prismaRaw.goalPlusExecutionLink.upsert({
        where: {
          sourceDbId_executionId_role: {
            sourceDbId,
            executionId: execution.id,
            role: intent.role,
          },
        },
        create: {
          sourceDbId,
          goalDbId: intent.goalDbId,
          runDbId: intent.runDbId,
          candidateDbId: intent.candidateDbId,
          agentSessionDbId: intent.agentSessionDbId,
          executionId: execution.id,
          role: intent.role,
          linkMethod: method,
          linkState: candidateState,
          priority,
          evidenceJson: JSON.stringify({ intent: intent.key, exactIds: intent.exactIds, taskName: intent.taskName }),
          linkedAt: candidateState === 'linked' ? new Date() : null,
        },
        update: {
          goalDbId: intent.goalDbId,
          runDbId: intent.runDbId,
          candidateDbId: intent.candidateDbId,
          agentSessionDbId: intent.agentSessionDbId,
          linkMethod: method,
          linkState: candidateState,
          priority,
          evidenceJson: JSON.stringify({ intent: intent.key, exactIds: intent.exactIds, taskName: intent.taskName }),
          linkedAt: candidateState === 'linked' ? new Date() : null,
        },
      });
    }
  }
  return { linked, ambiguous, unresolved };
}

export async function relinkGoalPlusForExecution(user: string): Promise<void> {
  const sources = await prismaRaw.goalPlusSource.findMany({ where: { user }, select: { id: true } });
  for (const source of sources) await relinkGoalPlusSource(source.id);
}
