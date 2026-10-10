import { prismaRaw } from '@/lib/storage/prisma';
import type { GoalPlusBatchV1, GoalPlusSnapshotEnvelopeV1 } from './contracts';
import {
  dateValue,
  finiteNumber,
  jsonArray,
  jsonObject,
  jsonString,
  positiveInt,
  sanitizeGoalPlusLabel,
  sanitizeGoalPlusPayload,
  text,
} from './normalize';

type Tx = Omit<
  typeof prismaRaw,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface GoalPlusRejectedSnapshot {
  index: number;
  snapshotId?: string;
  code: string;
  message: string;
}

export interface GoalPlusPersistResult {
  accepted: number;
  duplicate: number;
  rejected: GoalPlusRejectedSnapshot[];
}

export class GoalPlusSourceConflictError extends Error {
  constructor() {
    super('Goal Plus sourceId is already bound to a different workspace fingerprint');
    this.name = 'GoalPlusSourceConflictError';
  }
}

function selectedModelName(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  const model = jsonObject(value);
  return text(model.model) || text(model.model_id);
}

async function projectGoal(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const goalPlusId = text(payload.goalPlusId) || snapshot.parentKeys.goalId || snapshot.objectKey;
  const currentRevision = positiveInt(payload.currentRevision) || snapshot.parentKeys.goalRevision || 1;
  const observedAt = new Date(snapshot.observedAt);
  const data = {
    currentRevision,
    status: text(payload.status) || 'active',
    phase: text(payload.phase) || 'intake',
    goalDigest: text(payload.goalDigest) || snapshot.contentHash,
    boundedGoal: text(payload.boundedGoal),
    policyJson: jsonString(payload.policy, {}),
    triageJson: payload.triage == null ? null : jsonString(payload.triage, {}),
    revisionsJson: jsonString(payload.revisions, []),
    workItemsJson: jsonString(payload.workItems, []),
    searchTasksJson: jsonString(payload.searchTasks, []),
    finalChecksJson: jsonString(payload.finalChecks, []),
    activeSessionJson: payload.activeSession == null ? null : jsonString(payload.activeSession, {}),
    nextActionJson: payload.nextAction == null ? null : jsonString(payload.nextAction, {}),
    sourceCreatedAt: dateValue(payload.createdAt),
    sourceUpdatedAt: dateValue(payload.updatedAt),
    observedAt,
  };
  const goal = await tx.goalPlusGoal.upsert({
    where: { sourceDbId_goalPlusId: { sourceDbId, goalPlusId } },
    create: { sourceDbId, goalPlusId, ...data },
    update: data,
  });

  const runIds = jsonArray(payload.searchTasks)
    .map(item => text(jsonObject(item).runId))
    .filter((value): value is string => Boolean(value));
  if (runIds.length) {
    await tx.goalPlusRun.updateMany({
      where: { sourceDbId, runId: { in: runIds } },
      data: { goalDbId: goal.id },
    });
  }
}

async function projectRun(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const runId = text(payload.runId) || snapshot.parentKeys.runId || snapshot.objectKey;
  const goalId = snapshot.parentKeys.goalId;
  const goal = goalId
    ? await tx.goalPlusGoal.findUnique({ where: { sourceDbId_goalPlusId: { sourceDbId, goalPlusId: goalId } } })
    : null;
  const data = {
    goalDbId: goal?.id || null,
    frozenSpecId: text(payload.frozenSpecId) || snapshot.parentKeys.specId || 'unknown',
    sourceRunId: text(payload.sourceRunId),
    replacementRunId: text(payload.replacementRunId),
    state: text(payload.state) || 'frozen_spec',
    strategy: text(payload.strategy),
    metricName: text(payload.metricName),
    metricDirection: text(payload.metricDirection),
    bestCandidateId: text(payload.bestCandidateId),
    bestScore: finiteNumber(payload.bestScore),
    selectedCandidateId: text(payload.selectedCandidateId),
    selectedIteration: positiveInt(payload.selectedIteration),
    selectedScore: finiteNumber(payload.selectedScore),
    selectedGitHead: text(payload.selectedGitHead),
    selectedArtifactHash: text(payload.selectedArtifactHash),
    invalidationReason: text(payload.invalidationReason),
    invalidationSummary: text(payload.invalidationSummary),
    budgetUsedJson: jsonString(payload.budgetUsed, {}),
    selectedModelsJson: jsonString(payload.selectedModels, []),
    sourceCreatedAt: dateValue(payload.createdAt),
    invalidatedAt: dateValue(payload.invalidatedAt),
    observedAt: new Date(snapshot.observedAt),
  };
  await tx.goalPlusRun.upsert({
    where: { sourceDbId_runId: { sourceDbId, runId } },
    create: { sourceDbId, runId, ...data },
    update: data,
  });
}

async function projectCandidate(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const runId = snapshot.parentKeys.runId || text(payload.runId);
  const candidateId = snapshot.parentKeys.candidateId || text(payload.candidateId);
  if (!runId || !candidateId) return;
  const run = await tx.goalPlusRun.findUnique({ where: { sourceDbId_runId: { sourceDbId, runId } } });
  if (!run) return;
  const task = jsonObject(payload.task);
  const scoreReport = jsonObject(payload.scoreReport);
  const iterations = jsonArray(payload.iterations).map(jsonObject);
  const validIterations = iterations
    .map(item => ({ source: item, iteration: positiveInt(item.iteration) }))
    .filter((item): item is { source: Record<string, unknown>; iteration: number } => item.iteration != null);
  const bestIteration = positiveInt(scoreReport.bestIteration)
    || validIterations.filter(item => item.source.processPassed === true)
      .sort((left, right) => (finiteNumber(right.source.score) || -Infinity) - (finiteNumber(left.source.score) || -Infinity))[0]?.iteration
    || null;
  const bestRecord = validIterations.find(item => item.iteration === bestIteration)?.source;
  const selectedModel = selectedModelName(task.selectedModel) || selectedModelName(payload.selectedModel);
  const candidate = await tx.goalPlusCandidate.upsert({
    where: { runDbId_candidateId: { runDbId: run.id, candidateId } },
    create: {
      runDbId: run.id,
      candidateId,
      status: text(payload.status) || 'created',
      selectedModel,
      baseGitHead: text(task.workspaceBaseRevision) || text(task.baseGitHead),
      bestIteration,
      bestScore: finiteNumber(scoreReport.aggregateScore) ?? finiteNumber(bestRecord?.score),
      bestArtifactHash: text(bestRecord?.artifactHash),
      taskJson: jsonString(task, {}),
      scoreReportJson: payload.scoreReport == null ? null : jsonString(payload.scoreReport, {}),
      promotionJson: payload.promotion == null ? null : jsonString(payload.promotion, {}),
      observedAt: new Date(snapshot.observedAt),
    },
    update: {
      status: text(payload.status) || 'created',
      selectedModel,
      baseGitHead: text(task.workspaceBaseRevision) || text(task.baseGitHead),
      bestIteration,
      bestScore: finiteNumber(scoreReport.aggregateScore) ?? finiteNumber(bestRecord?.score),
      bestArtifactHash: text(bestRecord?.artifactHash),
      taskJson: jsonString(task, {}),
      scoreReportJson: payload.scoreReport == null ? null : jsonString(payload.scoreReport, {}),
      promotionJson: payload.promotion == null ? null : jsonString(payload.promotion, {}),
      observedAt: new Date(snapshot.observedAt),
    },
  });

  const retained = validIterations.map(item => item.iteration);
  await tx.goalPlusIteration.deleteMany({
    where: {
      candidateDbId: candidate.id,
      ...(retained.length ? { iteration: { notIn: retained } } : {}),
    },
  });
  for (const { source: iteration, iteration: index } of validIterations) {
    const data = {
      agentSessionId: text(iteration.agentSessionId),
      selectedModel: text(iteration.selectedModel),
      score: finiteNumber(iteration.score),
      processPassed: typeof iteration.processPassed === 'boolean' ? iteration.processPassed : null,
      disposition: text(iteration.disposition),
      failureClass: text(iteration.failureClass),
      gitHead: text(iteration.gitHead),
      ledgerGitHead: text(iteration.ledgerGitHead),
      artifactHash: text(iteration.artifactHash),
      changedFilesJson: jsonString(iteration.changedFiles, []),
      metricsJson: jsonString(iteration.metrics, {}),
      summary: text(iteration.summary),
      hypothesis: text(iteration.hypothesis),
      sourceCreatedAt: dateValue(iteration.createdAt),
      observedAt: new Date(snapshot.observedAt),
    };
    await tx.goalPlusIteration.upsert({
      where: { candidateDbId_iteration: { candidateDbId: candidate.id, iteration: index } },
      create: { candidateDbId: candidate.id, iteration: index, ...data },
      update: data,
    });
  }
}

async function projectAgentSession(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const runId = snapshot.parentKeys.runId || text(payload.runId);
  const agentSessionId = snapshot.parentKeys.agentSessionId || text(payload.agentSessionId);
  if (!runId || !agentSessionId) return;
  const run = await tx.goalPlusRun.findUnique({ where: { sourceDbId_runId: { sourceDbId, runId } } });
  if (!run) return;
  const candidateId = snapshot.parentKeys.candidateId || text(payload.candidateId);
  const candidate = candidateId
    ? await tx.goalPlusCandidate.findUnique({ where: { runDbId_candidateId: { runDbId: run.id, candidateId } } })
    : null;
  const hostHandle = jsonObject(payload.hostHandle);
  const data = {
    candidateDbId: candidate?.id || null,
    host: text(payload.host) || 'codex',
    role: text(payload.role) || 'candidate-worker',
    nativeSessionId: text(payload.nativeSessionId) || text(hostHandle.externalId),
    taskName: text(payload.taskName) || text(hostHandle.taskName),
    transcriptFingerprint: text(payload.transcriptFingerprint),
    selectedModel: selectedModelName(payload.selectedModel),
    usageJson: jsonString(payload.usage, {}),
    hostMetadataJson: jsonString(payload.hostMetadata ?? hostHandle.metadata, {}),
    countersJson: jsonString(payload.counters, {}),
    sourceCreatedAt: dateValue(payload.createdAt),
    sourceUpdatedAt: dateValue(payload.updatedAt),
    observedAt: new Date(snapshot.observedAt),
  };
  await tx.goalPlusAgentSession.upsert({
    where: { runDbId_agentSessionId: { runDbId: run.id, agentSessionId } },
    create: { runDbId: run.id, agentSessionId, ...data },
    update: data,
  });
}

async function projectBest(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const runId = snapshot.parentKeys.runId || text(payload.runId) || snapshot.objectKey;
  await tx.goalPlusRun.updateMany({
    where: { sourceDbId, runId },
    data: {
      bestJson: JSON.stringify(payload),
      bestCandidateId: text(payload.candidateId) || undefined,
      bestScore: finiteNumber(payload.score) ?? undefined,
      observedAt: new Date(snapshot.observedAt),
    },
  });
}

async function projectReport(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  const runId = snapshot.parentKeys.runId || text(payload.runId) || snapshot.objectKey;
  await tx.goalPlusRun.updateMany({
    where: { sourceDbId, runId },
    data: { reportJson: JSON.stringify(payload), observedAt: new Date(snapshot.observedAt) },
  });
}

async function projectSnapshot(tx: Tx, sourceDbId: string, snapshot: GoalPlusSnapshotEnvelopeV1, payload: Record<string, unknown>) {
  switch (snapshot.kind) {
    case 'goal': return projectGoal(tx, sourceDbId, snapshot, payload);
    case 'run': return projectRun(tx, sourceDbId, snapshot, payload);
    case 'candidate': return projectCandidate(tx, sourceDbId, snapshot, payload);
    case 'agent_session': return projectAgentSession(tx, sourceDbId, snapshot, payload);
    case 'best': return projectBest(tx, sourceDbId, snapshot, payload);
    case 'report_meta': return projectReport(tx, sourceDbId, snapshot, payload);
    default: return undefined;
  }
}

async function replaySourceProjection(sourceDbId: string): Promise<void> {
  const snapshots = await prismaRaw.goalPlusSemanticSnapshot.findMany({
    where: { sourceDbId },
    orderBy: [{ observedAt: 'asc' }, { ingestedAt: 'asc' }],
  });
  const priority: Record<string, number> = { goal: 0, run: 1, candidate: 2, agent_session: 3, best: 4, report_meta: 5 };
  snapshots.sort((left, right) => (priority[left.kind] ?? 10) - (priority[right.kind] ?? 10));
  for (const row of snapshots) {
    const payload = JSON.parse(row.sanitizedPayloadJson) as Record<string, unknown>;
    const snapshot: GoalPlusSnapshotEnvelopeV1 = {
      format: 'agent-insight.goal-plus-snapshot',
      version: 1,
      snapshotId: row.snapshotId,
      sourceId: '',
      kind: row.kind as GoalPlusSnapshotEnvelopeV1['kind'],
      objectKey: row.objectKey,
      parentKeys: JSON.parse(row.parentKeysJson),
      sourceSchemaVersion: row.sourceSchemaVersion || undefined,
      contentHash: row.contentHash,
      observedAt: row.observedAt.toISOString(),
      payload,
      redaction: JSON.parse(row.redactionJson),
    };
    await prismaRaw.$transaction(tx => projectSnapshot(tx, sourceDbId, snapshot, payload));
  }
}

export async function persistGoalPlusBatch(user: string, batch: GoalPlusBatchV1): Promise<GoalPlusPersistResult> {
  const sourceLabel = sanitizeGoalPlusLabel(batch.source.label);
  const sourceSchemaVersion = batch.snapshots.reduce<number | null>((highest, snapshot) => (
    snapshot.sourceSchemaVersion && snapshot.sourceSchemaVersion > (highest || 0)
      ? snapshot.sourceSchemaVersion
      : highest
  ), null);
  const existingSource = await prismaRaw.goalPlusSource.findUnique({
    where: { user_sourceId: { user, sourceId: batch.source.sourceId } },
    select: { workspaceFingerprint: true },
  });
  if (existingSource && existingSource.workspaceFingerprint !== batch.source.workspaceFingerprint) {
    throw new GoalPlusSourceConflictError();
  }
  const source = await prismaRaw.goalPlusSource.upsert({
    where: { user_sourceId: { user, sourceId: batch.source.sourceId } },
    create: {
      user,
      sourceId: batch.source.sourceId,
      workspaceFingerprint: batch.source.workspaceFingerprint,
      label: sourceLabel,
      collectorVersion: batch.source.collectorVersion,
      sourceSchemaVersion,
      lastScanCompletedAt: null,
      semanticCheckpointJson: null,
    },
    update: {
      collectorVersion: batch.source.collectorVersion,
      ...(sourceSchemaVersion ? { sourceSchemaVersion } : {}),
      lastSeenAt: new Date(),
      ...(sourceLabel ? { label: sourceLabel } : {}),
    },
  });
  if (source.workspaceFingerprint !== batch.source.workspaceFingerprint) {
    throw new GoalPlusSourceConflictError();
  }

  let accepted = 0;
  let duplicate = 0;
  const rejected: GoalPlusRejectedSnapshot[] = [];
  for (let index = 0; index < batch.snapshots.length; index += 1) {
    const snapshot = batch.snapshots[index];
    const normalized = sanitizeGoalPlusPayload(snapshot);
    try {
      const existing = await prismaRaw.goalPlusSemanticSnapshot.findUnique({
        where: { sourceDbId_snapshotId: { sourceDbId: source.id, snapshotId: snapshot.snapshotId } },
        select: { id: true },
      });
      if (existing) {
        duplicate += 1;
        continue;
      }
      await prismaRaw.$transaction(async tx => {
        await tx.goalPlusSemanticSnapshot.create({
          data: {
            sourceDbId: source.id,
            snapshotId: snapshot.snapshotId,
            kind: snapshot.kind,
            objectKey: snapshot.objectKey,
            parentKeysJson: JSON.stringify(snapshot.parentKeys),
            contentHash: snapshot.contentHash,
            sourceSchemaVersion: snapshot.sourceSchemaVersion,
            sanitizedPayloadJson: JSON.stringify(normalized.payload),
            redactionJson: JSON.stringify({
              contentMode: snapshot.redaction.contentMode,
              truncatedFields: normalized.truncatedFields,
              removedFields: normalized.removedFields,
            }),
            observedAt: new Date(snapshot.observedAt),
          },
        });
        await projectSnapshot(tx, source.id, snapshot, normalized.payload);
      });
      accepted += 1;
    } catch (error) {
      rejected.push({
        index,
        snapshotId: snapshot.snapshotId,
        code: 'projection_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (accepted > 0) await replaySourceProjection(source.id);
  if (rejected.length === 0 && (batch.source.scanCompletedAt || batch.source.semanticCheckpoint)) {
    await prismaRaw.goalPlusSource.update({
      where: { id: source.id },
      data: {
        ...(batch.source.scanCompletedAt ? { lastScanCompletedAt: new Date(batch.source.scanCompletedAt) } : {}),
        ...(batch.source.semanticCheckpoint ? { semanticCheckpointJson: JSON.stringify(batch.source.semanticCheckpoint) } : {}),
      },
    });
  }
  return { accepted, duplicate, rejected };
}
