import { prismaRaw } from '@/lib/storage/prisma';
import { calculateGoalPlusCompleteness, calculateGoalPlusCompletenessMany } from './completeness';

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const executionSelect = {
  id: true,
  taskId: true,
  query: true,
  framework: true,
  model: true,
  agentName: true,
  subagentName: true,
  timestamp: true,
  latency: true,
  tokens: true,
  cost: true,
  answerScore: true,
  isAnswerCorrect: true,
  parentExecutionId: true,
  rootExecutionId: true,
  agentSessionId: true,
} as const;

export async function listGoalPlusSources(user: string) {
  return prismaRaw.goalPlusSource.findMany({
    where: { user },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      sourceId: true,
      label: true,
      workspaceFingerprint: true,
      collectorVersion: true,
      sourceSchemaVersion: true,
      firstSeenAt: true,
      lastSeenAt: true,
      lastScanCompletedAt: true,
      _count: { select: { goals: true, runs: true, snapshots: true } },
    },
  });
}

export async function listGoalPlusGoals(user: string, sourceId?: string | null) {
  const goals = await prismaRaw.goalPlusGoal.findMany({
    where: { source: { user, ...(sourceId ? { sourceId } : {}) } },
    orderBy: { observedAt: 'desc' },
    include: {
      source: { select: { sourceId: true, label: true, lastScanCompletedAt: true } },
      runs: {
        select: {
          id: true,
          runId: true,
          state: true,
          strategy: true,
          metricName: true,
          metricDirection: true,
          bestScore: true,
          selectedScore: true,
          observedAt: true,
          _count: { select: { candidates: true, agentSessions: true } },
        },
      },
    },
  });
  const completeness = await calculateGoalPlusCompletenessMany(goals.map(goal => goal.id));
  return goals.map(goal => ({
    id: goal.id,
    goalPlusId: goal.goalPlusId,
    currentRevision: goal.currentRevision,
    status: goal.status,
    phase: goal.phase,
    boundedGoal: goal.boundedGoal,
    observedAt: goal.observedAt,
    source: goal.source,
    runs: goal.runs,
    completeness: completeness.get(goal.id),
  }));
}

export async function getGoalPlusGoal(user: string, sourceId: string, goalPlusId: string) {
  const goal = await prismaRaw.goalPlusGoal.findFirst({
    where: { goalPlusId, source: { user, sourceId } },
    include: {
      source: true,
      links: { include: { execution: { select: executionSelect } } },
      runs: {
        orderBy: { observedAt: 'asc' },
        include: {
          links: { include: { execution: { select: executionSelect } } },
          candidates: {
            orderBy: { candidateId: 'asc' },
            include: {
              iterations: { orderBy: { iteration: 'asc' } },
              links: { include: { execution: { select: executionSelect } } },
            },
          },
          agentSessions: {
            orderBy: { sourceCreatedAt: 'asc' },
            include: { links: { include: { execution: { select: executionSelect } } } },
          },
        },
      },
    },
  });
  if (!goal) return null;
  return {
    ...goal,
    policy: parseJson(goal.policyJson, {}),
    triage: parseJson(goal.triageJson, null),
    revisions: parseJson(goal.revisionsJson, []),
    workItems: parseJson(goal.workItemsJson, []),
    searchTasks: parseJson(goal.searchTasksJson, []),
    finalChecks: parseJson(goal.finalChecksJson, []),
    activeSession: parseJson(goal.activeSessionJson, null),
    nextAction: parseJson(goal.nextActionJson, null),
    completeness: await calculateGoalPlusCompleteness(goal.id),
    runs: goal.runs.map(run => ({
      ...run,
      budgetUsed: parseJson(run.budgetUsedJson, {}),
      selectedModels: parseJson(run.selectedModelsJson, []),
      best: parseJson(run.bestJson, null),
      report: parseJson(run.reportJson, null),
      candidates: run.candidates.map(candidate => ({
        ...candidate,
        task: parseJson(candidate.taskJson, {}),
        scoreReport: parseJson(candidate.scoreReportJson, null),
        promotion: parseJson(candidate.promotionJson, null),
        iterations: candidate.iterations.map(iteration => ({
          ...iteration,
          changedFiles: parseJson(iteration.changedFilesJson, []),
          metrics: parseJson(iteration.metricsJson, {}),
        })),
      })),
      agentSessions: run.agentSessions.map(session => ({
        ...session,
        usage: parseJson(session.usageJson, {}),
        hostMetadata: parseJson(session.hostMetadataJson, {}),
        counters: parseJson(session.countersJson, {}),
      })),
    })),
  };
}

export async function getGoalPlusRunTrace(user: string, sourceId: string, runId: string) {
  const run = await prismaRaw.goalPlusRun.findFirst({
    where: { runId, source: { user, sourceId } },
    include: {
      goal: { select: { goalPlusId: true, boundedGoal: true } },
      links: { include: { execution: { select: executionSelect } } },
      candidates: {
        include: {
          iterations: { orderBy: { iteration: 'asc' } },
          links: { include: { execution: { select: executionSelect } } },
        },
      },
      agentSessions: {
        include: { links: { include: { execution: { select: executionSelect } } } },
      },
    },
  });
  if (!run) return null;
  const links = [
    ...run.links,
    ...run.candidates.flatMap(candidate => candidate.links),
    ...run.agentSessions.flatMap(session => session.links),
  ].filter(link => link.linkState !== 'superseded');
  return {
    runId: run.runId,
    state: run.state,
    goal: run.goal,
    executions: [...new Map(links.map(link => [link.executionId, {
      role: link.role,
      linkMethod: link.linkMethod,
      linkState: link.linkState,
      priority: link.priority,
      execution: link.execution,
    }])).values()],
  };
}
