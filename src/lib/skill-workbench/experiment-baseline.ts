import { prismaRaw } from '@/lib/storage/prisma';

export interface WorkbenchExperimentSnapshot {
  datasetId?: string;
  caseIds?: string[];
  evaluatorIds?: string[];
  repeatRounds?: number;
  grayscaleTaskId?: string;
  baselineSide?: 'a' | 'b';
  runtime?: {
    modelConfigId?: string | null;
    modelOptions?: Record<string, unknown>;
    interactionPolicy?: 'auto-allow' | 'auto-deny';
    timeoutMs?: number;
    idleTimeoutMs?: number;
  };
}

export interface WorkbenchExperimentBaseline {
  experiment: {
    id: string;
    name: string;
    preset: string | null;
    skillName: string;
    skillVersion: number | null;
  };
  snapshot: WorkbenchExperimentSnapshot;
  score: number;
}

function parseJson<T>(value: string | null, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null;
}

async function loadBaselines(user: string, experiments: Array<{
  id: string;
  name: string;
  preset: string | null;
  skillName: string;
  skillVersion: number | null;
  configSnapshotJson: string | null;
}>) {
  const parsed = experiments.map((experiment) => ({
    experiment,
    snapshot: parseJson<WorkbenchExperimentSnapshot>(experiment.configSnapshotJson, {}),
  }));
  const taskIds = parsed.map(({ snapshot }) => snapshot.grayscaleTaskId || '').filter(Boolean);
  const tasks = taskIds.length ? await prismaRaw.grayscaleTask.findMany({
    where: { id: { in: taskIds }, user },
    select: { id: true, caseStatesJson: true },
  }) : [];
  const taskMap = new Map(tasks.map((task) => [task.id, task.caseStatesJson]));

  return parsed.flatMap(({ experiment, snapshot }) => {
    if (!snapshot.datasetId || !snapshot.caseIds?.length || !snapshot.evaluatorIds?.length || !snapshot.grayscaleTaskId) return [];
    const states = parseJson<Record<string, {
      a?: { runs?: Array<{ status?: string; score?: number }> };
      b?: { runs?: Array<{ status?: string; score?: number }> };
    }>>(taskMap.get(snapshot.grayscaleTaskId) || null, {});
    const baselineSide = snapshot.baselineSide || 'b';
    const scores = snapshot.caseIds.flatMap((caseId) => states[caseId]?.[baselineSide]?.runs || [])
      .filter((run) => run.status === 'pass' && typeof run.score === 'number' && Number.isFinite(run.score))
      .map((run) => run.score as number);
    const score = average(scores);
    return score == null ? [] : [{
      experiment: {
        id: experiment.id,
        name: experiment.name,
        preset: experiment.preset,
        skillName: experiment.skillName,
        skillVersion: experiment.skillVersion,
      },
      snapshot,
      score,
    }];
  });
}

export async function getRetestableExperimentBaseline(input: {
  user: string;
  experimentId: string;
  skillName: string;
  skillVersion: number;
}) {
  const experiment = await prismaRaw.experiment.findFirst({
    where: {
      id: input.experimentId,
      user: input.user,
      scope: 'skill-workbench',
      skillName: input.skillName,
      skillVersion: input.skillVersion,
      preset: { in: ['trigger', 'use-case', 'skill-ab'] },
      configSnapshotJson: { not: null },
    },
    select: {
      id: true, name: true, preset: true, skillName: true, skillVersion: true, configSnapshotJson: true,
    },
  });
  if (!experiment) return null;
  return (await loadBaselines(input.user, [experiment]))[0] || null;
}

export async function findLatestRetestableExperimentBaseline(input: {
  user: string;
  skillName: string;
  skillVersion: number;
}) {
  const experiments = await prismaRaw.experiment.findMany({
    where: {
      user: input.user,
      scope: 'skill-workbench',
      skillName: input.skillName,
      skillVersion: input.skillVersion,
      preset: { in: ['trigger', 'use-case', 'skill-ab'] },
      configSnapshotJson: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true, name: true, preset: true, skillName: true, skillVersion: true, configSnapshotJson: true,
    },
  });
  return (await loadBaselines(input.user, experiments))[0] || null;
}

export async function resolveRetestableExperimentBaseline(input: {
  user: string;
  skillName: string;
  skillVersion: number;
  sourceExperimentId?: string | null;
}) {
  if (input.sourceExperimentId) {
    const linked = await getRetestableExperimentBaseline({
      ...input,
      experimentId: input.sourceExperimentId,
    });
    if (linked) return linked;
  }
  return findLatestRetestableExperimentBaseline(input);
}
