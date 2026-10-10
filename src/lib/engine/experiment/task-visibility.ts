import { prisma } from '@/lib/storage/prisma';

export async function visibleExperimentTask<T extends { configJson?: object; caseStatesJson?: object }>(task: T): Promise<T | null> {
  const experimentId = (task.configJson as { evalExperimentId?: unknown } | undefined)?.evalExperimentId;
  if (typeof experimentId !== 'string' || !experimentId) return task;
  const experiment = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { deletedAt: true } });
  if (experiment?.deletedAt) return null;
  const cancellations: Array<{ caseKey: string }> = await prisma.experimentCancellation.findMany({ where: { experimentId }, select: { caseKey: true } });
  const deleted = new Set(cancellations.filter((row) => row.caseKey.startsWith('dataset:')).map((row) => row.caseKey.slice(8)));
  return { ...task, caseStatesJson: Object.fromEntries(Object.entries(task.caseStatesJson || {}).filter(([key]) => !deleted.has(key))) };
}
