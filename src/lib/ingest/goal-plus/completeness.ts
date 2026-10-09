import type { Prisma } from '@prisma/client';
import { prismaRaw } from '@/lib/storage/prisma';

export interface GoalPlusTraceCompleteness {
  status: 'collecting' | 'complete' | 'partial' | 'unsupported';
  expectedNativeExecutions: number;
  linkedNativeExecutions: number;
  expectedIterations: number;
  observedIterations: number;
  semanticCheckpointCaughtUp: boolean;
  missingCategories: string[];
  timingFidelity: 'exact' | 'mixed' | 'derived' | 'summary-only';
  contentFidelity: 'bounded' | 'metadata-only' | 'mixed';
}

function parseObject(raw: string | null): Record<string, unknown> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function parseArray(raw: string | null): Record<string, unknown>[] {
  try {
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

const completenessInclude = {
  source: true,
  runs: {
    include: {
      candidates: { include: { iterations: true } },
      agentSessions: { include: { links: true } },
      links: true,
    },
  },
  links: true,
} satisfies Prisma.GoalPlusGoalInclude;

type LoadedGoal = Prisma.GoalPlusGoalGetPayload<{ include: typeof completenessInclude }>;
type SnapshotFact = {
  sourceDbId: string;
  kind: string;
  objectKey: string;
  parentKeysJson: string;
  sourceSchemaVersion: number | null;
  sanitizedPayloadJson: string;
  redactionJson: string;
};

function calculateLoadedGoalCompleteness(
  goal: LoadedGoal,
  snapshots: SnapshotFact[],
  executions: Map<string, { taskId: string | null; framework: string | null }>,
): GoalPlusTraceCompleteness {

  const activeSession = parseObject(goal.activeSessionJson);
  const workItems = parseArray(goal.workItemsJson).filter(item => item.route !== 'search');
  const finalChecks = parseArray(goal.finalChecksJson);
  const semanticExpected = [
    ...(typeof activeSession.sessionId === 'string' ? ['main'] : []),
    ...workItems
      .filter(item => typeof item.agentId === 'string' || typeof item.taskName === 'string')
      .map(item => `work-item:${String(item.workItemId || 'unknown')}`),
    ...finalChecks
      .filter(item => item.status !== 'pending')
      .map(item => `final-check:${String(item.checkId || 'unknown')}`),
  ];
  const sessions = goal.runs.flatMap(run => run.agentSessions);
  const expectedRoles = new Set([
    ...semanticExpected,
    ...sessions.map(session => `${session.role}:${session.id}`),
  ]);
  const linkedExecutionIds = new Set<string>();
  const linkedRoles = new Set<string>();
  let ambiguous = false;
  for (const link of [goal.links, ...goal.runs.map(run => run.links), ...sessions.map(session => session.links)].flat()) {
    if (link.linkState === 'ambiguous') ambiguous = true;
    if (link.linkState !== 'linked') continue;
    linkedExecutionIds.add(link.executionId);
    if (link.agentSessionDbId) linkedRoles.add(`${link.role}:${link.agentSessionDbId}`);
    else linkedRoles.add(link.role);
  }
  const missingCategories = [...expectedRoles]
    .filter(role => !linkedRoles.has(role))
    .map(role => `native_execution:${role}`);
  if (ambiguous) missingCategories.push('ambiguous_link');

  const expectedIterations = goal.runs.reduce(
    (sum, run) => sum + run.candidates.reduce((inner, candidate) => inner + candidate.iterations.length, 0),
    0,
  );
  const observedIterations = goal.runs.reduce(
    (sum, run) => sum + run.candidates.reduce(
      (inner, candidate) => inner + candidate.iterations.filter(iteration => (
        iteration.disposition != null || iteration.processPassed != null || iteration.failureClass != null
      )).length,
      0,
    ),
    0,
  );
  if (observedIterations < expectedIterations) missingCategories.push('verifier_settlement');
  for (const run of goal.runs) {
    if (run.selectedCandidateId && (!run.selectedIteration || !run.selectedArtifactHash)) {
      missingCategories.push(`selection_evidence:${run.runId}`);
    }
    if (run.state === 'promoted' && !run.reportJson) missingCategories.push(`report_metadata:${run.runId}`);
  }

  const relevantSnapshots = snapshots.filter(snapshot => {
    if (snapshot.sourceDbId !== goal.sourceDbId) return false;
    if (snapshot.kind === 'goal' && snapshot.objectKey === goal.goalPlusId) return true;
    const parents = parseObject(snapshot.parentKeysJson);
    return parents.goalId === goal.goalPlusId;
  });
  const unsupported = relevantSnapshots.some(snapshot => {
    const payload = parseObject(snapshot.sanitizedPayloadJson);
    return payload.parserStatus === 'unsupported' || (snapshot.sourceSchemaVersion || 1) > 1;
  });
  const contentModes = new Set(relevantSnapshots.map(snapshot => String(parseObject(snapshot.redactionJson).contentMode || 'bounded')));
  const contentFidelity = contentModes.size > 1
    ? 'mixed'
    : contentModes.has('metadata-only') ? 'metadata-only' : 'bounded';
  const linkedExecutions = [...linkedExecutionIds]
    .map(id => executions.get(id))
    .filter((execution): execution is { taskId: string | null; framework: string | null } => Boolean(execution));
  const hasDerived = linkedExecutions.some(execution => execution.taskId?.startsWith('goal-plus:'));
  const hasExact = linkedExecutions.some(execution => !execution.taskId?.startsWith('goal-plus:'));
  const timingFidelity = linkedExecutions.length === 0
    ? 'summary-only'
    : hasDerived && hasExact ? 'mixed' : hasDerived ? 'derived' : 'exact';

  const terminalGoal = ['complete', 'blocked', 'abandoned'].includes(goal.status);
  const terminalRuns = goal.runs.every(run => ['promoted', 'aborted', 'failed', 'selection_blocked'].includes(run.state));
  const semanticCheckpointCaughtUp = Boolean(goal.source.lastScanCompletedAt)
    && (!goal.source.lastScanCompletedAt || goal.source.lastScanCompletedAt >= goal.observedAt);
  const status = unsupported
    ? 'unsupported'
    : !terminalGoal || !terminalRuns || !semanticCheckpointCaughtUp
      ? 'collecting'
      : missingCategories.length > 0 ? 'partial' : 'complete';

  return {
    status,
    expectedNativeExecutions: expectedRoles.size,
    linkedNativeExecutions: linkedRoles.size,
    expectedIterations,
    observedIterations,
    semanticCheckpointCaughtUp,
    missingCategories: [...new Set(missingCategories)].sort(),
    timingFidelity,
    contentFidelity,
  };
}

export async function calculateGoalPlusCompletenessMany(goalDbIds: string[]): Promise<Map<string, GoalPlusTraceCompleteness>> {
  if (!goalDbIds.length) return new Map();
  const goals = await prismaRaw.goalPlusGoal.findMany({
    where: { id: { in: goalDbIds } },
    include: completenessInclude,
  });
  const sourceDbIds = [...new Set(goals.map(goal => goal.sourceDbId))];
  const snapshots = await prismaRaw.goalPlusSemanticSnapshot.findMany({
    where: { sourceDbId: { in: sourceDbIds } },
    select: { sourceDbId: true, kind: true, objectKey: true, parentKeysJson: true, sourceSchemaVersion: true, sanitizedPayloadJson: true, redactionJson: true },
  });
  const executionIds = [...new Set(goals.flatMap(goal => [
    ...goal.links.map(link => link.executionId),
    ...goal.runs.flatMap(run => [
      ...run.links.map(link => link.executionId),
      ...run.agentSessions.flatMap(session => session.links.map(link => link.executionId)),
    ]),
  ]))];
  const executionRows = executionIds.length
    ? await prismaRaw.execution.findMany({
      where: { id: { in: executionIds } },
      select: { id: true, taskId: true, framework: true },
    })
    : [];
  const executions = new Map(executionRows.map(execution => [execution.id, execution]));
  return new Map(goals.map(goal => [
    goal.id,
    calculateLoadedGoalCompleteness(goal, snapshots, executions),
  ]));
}

export async function calculateGoalPlusCompleteness(goalDbId: string): Promise<GoalPlusTraceCompleteness> {
  const result = await calculateGoalPlusCompletenessMany([goalDbId]);
  const completeness = result.get(goalDbId);
  if (!completeness) throw new Error('Goal Plus goal not found');
  return completeness;
}
