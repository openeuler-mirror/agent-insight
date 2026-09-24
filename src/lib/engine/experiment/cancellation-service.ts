import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/storage/prisma';
import { createCommand, markSent } from '@/lib/reliability/command-bus';
import { dispatchCommand } from '@/lib/reliability/control-dispatch';

type Target = {
  kind: 'ordinary' | 'benchmark' | 'evaluation' | 'local';
  runId: string; clientId?: string; baseUrl?: string; requestDigest?: string;
  commandId?: string; confirmed?: boolean; error?: string;
};
const terminalRun = ['completed', 'evaluated', 'blocked', 'execution_failed', 'evaluation_failed', 'dispatch_failed', 'submission_invalid', 'cancelled'];
const terminalEvaluation = ['completed', 'failed', 'normalization_failed', 'submission_invalid', 'cancelled'];

export async function deleteExperimentExecution(user: string, experimentId: string, caseId?: string) {
  const experiment = await prisma.experiment.findFirst({ where: { id: experimentId, user } });
  if (!experiment) throw Object.assign(new Error('实验不存在'), { status: 404 });
  const snapshot = JSON.parse(experiment.configSnapshotJson || '{}');
  const skillScope = ['skill-workbench', 'skill-case-analysis', 'grayscale-ab'].includes(experiment.scope);
  if (skillScope && !Array.isArray(snapshot.caseIds)) {
    const tasks = [...await prisma.grayscaleTask.findMany({ where: { user, configJson: { contains: experimentId } } }),
      ...await prisma.batchEvalTask.findMany({ where: { user, configJson: { contains: experimentId } } })];
    snapshot.caseIds = tasks.filter((task) => JSON.parse(task.configJson || '{}').evalExperimentId === experimentId)
      .flatMap((task) => Object.keys(JSON.parse(task.caseStatesJson || '{}')));
  }
  let datasetCaseId = caseId?.startsWith('dataset:') ? caseId.slice(8) : undefined;
  const caseRow = caseId && !datasetCaseId ? await prisma.experimentCase.findFirst({ where: { id: caseId, experimentId } }) : null;
  if (skillScope && caseRow) {
    const values = JSON.parse(caseRow.caseValuesJson || '{}');
    datasetCaseId = values.__agentInsightDatasetCase?.caseId;
    if (datasetCaseId) caseId = `dataset:${datasetCaseId}`;
  }
  if (caseId && !datasetCaseId && !caseRow) {
    throw Object.assign(new Error('Case 不属于该实验'), { status: 404 });
  }
  const existing = await prisma.experimentCancellation.findUnique({ where: { experimentId_caseKey: { experimentId, caseKey: caseId || '' } } });
  if (existing) {
    void reconcileCancellation(existing.id).catch((error) => console.error('[experiment-cancellation]', error));
    return existing;
  }
  if (datasetCaseId && (!skillScope || !snapshot.caseIds?.includes(datasetCaseId))) {
    throw Object.assign(new Error('Case 不属于该 Skill 实验'), { status: 404 });
  }
  const id = randomUUID();
  try {
  await prisma.$transaction(async (tx: any) => {
    const cases = await tx.experimentCase.findMany({ where: { experimentId, ...(caseId && !datasetCaseId ? { id: caseId } : {}) }, select: { id: true, caseValuesJson: true } });
    const caseIds = cases.filter((item: any) => !datasetCaseId || JSON.parse(item.caseValuesJson || '{}').__agentInsightDatasetCase?.caseId === datasetCaseId).map((item: { id: string }) => item.id);
    await tx.experimentCase.updateMany({ where: { id: { in: caseIds } }, data: { deletedAt: new Date() } });
    const remainingCases = await tx.experimentCase.count({ where: { experimentId, deletedAt: null } });
    const cancelledDatasetCases = skillScope && caseId
      ? new Set((await tx.experimentCancellation.findMany({ where: { experimentId, caseKey: { startsWith: 'dataset:' } }, select: { caseKey: true } })).map((row: { caseKey: string }) => row.caseKey))
      : new Set<string>();
    if (caseId) cancelledDatasetCases.add(caseId);
    const remainingPlannedCases = skillScope && Array.isArray(snapshot.caseIds)
      && snapshot.caseIds.some((key: string) => !cancelledDatasetCases.has(`dataset:${key}`));
    const deleteExperiment = !caseId || (remainingCases === 0 && !remainingPlannedCases);
    const attempts = await tx.experimentTraceAttempt.findMany({ where: { caseId: { in: caseIds } } });
    const runs = await tx.benchmarkCaseRun.findMany({ where: { experimentId, experimentCaseId: { in: caseIds } }, include: { evaluations: true } });
    const targets: Target[] = [
      ...(deleteExperiment ? [{ kind: 'local' as const, runId: '' }] : []),
      ...caseIds.map((runId: string) => ({ kind: 'local' as const, runId })),
      ...(skillScope ? (datasetCaseId ? [datasetCaseId] : snapshot.caseIds || []).map((key: string) => ({ kind: 'local' as const, runId: `dataset:${key}` })) : []),
      ...attempts.filter((item: any) => item.commandId).map((item: any) => ({ kind: 'ordinary' as const, runId: item.commandId, clientId: item.workerId })),
    ];
    for (const run of runs) {
      if (!terminalRun.includes(run.status) && run.status !== 'pending') targets.push({ kind: 'benchmark', runId: run.id, clientId: run.clientId });
      for (const evaluation of run.evaluations) {
        if (!terminalEvaluation.includes(evaluation.status)) targets.push({ kind: 'evaluation', runId: evaluation.id,
          baseUrl: evaluation.evaluatorBaseUrl || undefined, requestDigest: evaluation.requestDigest });
      }
    }
    await tx.experimentCancellation.create({ data: { id, user, experimentId, caseKey: caseId || '', targetsJson: JSON.stringify(targets) } });
    if (deleteExperiment) await tx.experiment.update({ where: { id: experimentId }, data: { deletedAt: new Date(), status: 'cancelled', watchMode: false, watchEnabledAt: null } });
    await tx.experimentEvalResult.updateMany({ where: { caseId: { in: caseIds }, status: 'pending' }, data: { status: 'cancelled', errorMessage: '用户停止并删除' } });
    await tx.experimentTraceAttempt.updateMany({ where: { caseId: { in: caseIds }, status: { notIn: ['ready', 'failed', 'superseded'] } }, data: { status: 'cancelled', finishedAt: new Date() } });
    await tx.benchmarkCaseRun.updateMany({ where: { experimentCaseId: { in: caseIds }, status: { notIn: terminalRun } }, data: { status: 'cancelled', finishedAt: new Date() } });
    await tx.benchmarkEvaluation.updateMany({ where: { caseRun: { experimentCaseId: { in: caseIds } }, status: { notIn: terminalEvaluation } }, data: { status: 'cancelled', continuationStatus: 'completed', finishedAt: new Date() } });
  });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const duplicate = await prisma.experimentCancellation.findUnique({ where: { experimentId_caseKey: { experimentId, caseKey: caseId || '' } } });
    if (!duplicate) throw error;
    return duplicate;
  }
  void reconcileCancellation(id).catch((error) => console.error('[experiment-cancellation]', error));
  return prisma.experimentCancellation.findUniqueOrThrow({ where: { id } });
}

const reconciling = new Map<string, Promise<unknown>>();
export async function reconcileCancellation(id: string): Promise<any> {
  const existing = reconciling.get(id);
  if (existing) return existing;
  const work = (async () => {
    const record = await prisma.experimentCancellation.findUnique({ where: { id } });
    if (!record || record.status === 'completed') return record;
    const targets: Target[] = JSON.parse(record.targetsJson);
    for (const target of targets) {
      if (target.confirmed) continue;
      try {
        if (target.kind === 'local') {
          const { isExperimentCaseExecuting } = await import('./run-experiment');
          const active = await prisma.experimentLocalExecution.count({ where: { experimentId: record.experimentId, caseKey: target.runId } });
          target.confirmed = active === 0 && !await isExperimentCaseExecuting(target.runId, record.experimentId);
        } else if (target.kind === 'evaluation') {
          if (!target.baseUrl) {
            const evaluation = await prisma.benchmarkEvaluation.findUnique({ where: { id: target.runId } });
            const outbox = await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId: target.runId } });
            target.baseUrl = evaluation?.evaluatorBaseUrl || outbox?.destinationBaseUrl || undefined;
            if (!target.baseUrl && (!outbox || outbox.attemptCount === 0)) {
              target.confirmed = true;
              delete target.error;
              continue;
            }
            if (!target.baseUrl) throw new Error('评测下发正在确定目标，等待对账');
          }
          const response = await fetch(`${target.baseUrl.replace(/\/$/, '')}/api/v1/evaluations`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation: 'cancel', runId: target.runId, requestDigest: target.requestDigest }),
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error(`评测服务取消返回 ${response.status}`);
          const result = await response.json();
          target.confirmed = result.runId === target.runId && result.status === 'cancelled';
        } else {
          if (target.kind === 'ordinary') {
            const original = await prisma.reliabilityCommand.findUnique({ where: { commandId: target.runId } });
            if (original && ['SUCCEEDED', 'FAILED'].includes(original.status) && original.errorCode !== 'CANCELLATION_UNCONFIRMED') {
              target.confirmed = true;
              delete target.error;
              continue;
            }
          }
          const command = target.commandId ? await prisma.reliabilityCommand.findUnique({ where: { commandId: target.commandId } }) : null;
          if (command?.status === 'SUCCEEDED') {
            const result = JSON.parse(command.resultJson || '{}');
            target.confirmed = result.runId === target.runId && result.status === 'cancelled';
          }
          if (command?.status === 'FAILED' && command.errorCode === 'ACTION_NOT_ALLOWED') {
            const client = await prisma.reliabilityClient.findUnique({
              where: { clientId: target.clientId! }, select: { processStartedAt: true },
            });
            if (!client?.processStartedAt || client.processStartedAt <= (command.completedAt || command.updatedAt)) {
              throw new Error('执行客户端不支持停止指令；请更新并重启该客户端，平台会自动重试确认退出');
            }
          }
          if (!target.confirmed && (!command || new Date(command.expiresAt).getTime() < Date.now() || ['SUCCEEDED', 'FAILED', 'EXPIRED', 'DELIVERY_FAILED'].includes(command.status))) {
            const frame = await createCommand({ user: record.user, clientId: target.clientId!, action: 'CANCEL_EXPERIMENT_RUN',
              payload: { kind: target.kind, runId: target.runId } });
            target.commandId = frame.commandId;
            // Persist before dispatch so a lost response cannot lose the cancellation intent.
            await prisma.experimentCancellation.update({ where: { id }, data: { targetsJson: JSON.stringify(targets) } });
            const sent = await dispatchCommand(target.clientId!, frame);
            if (sent.delivered) await markSent(frame.commandId, 'wss');
          }
        }
        delete target.error;
      } catch (error) { target.error = error instanceof Error ? error.message : String(error); }
    }
    const completed = targets.every((target) => target.confirmed);
    await prisma.experimentCancellation.update({ where: { id }, data: {
      targetsJson: JSON.stringify(targets), status: 'pending',
      error: targets.filter((target) => target.error).map((target) => target.error).join('; ') || null,
    } });
    if (record.caseKey) {
      const experiment = await prisma.experiment.findUnique({ where: { id: record.experimentId } });
      if (experiment && !experiment.deletedAt && !['skill-workbench', 'skill-case-analysis', 'grayscale-ab'].includes(experiment.scope)
        && await prisma.experimentCase.count({ where: { experimentId: record.experimentId, deletedAt: null } }) === 0) {
        await prisma.experiment.updateMany({ where: { id: record.experimentId, deletedAt: null }, data: {
          deletedAt: new Date(), status: 'cancelled', watchMode: false, watchEnabledAt: null,
        } });
      } else if (completed && experiment?.scope === 'benchmark' && !experiment.deletedAt) {
        const { continueAfterCaseCancellation } = await import('@/lib/benchmark/experiment-lifecycle');
        await continueAfterCaseCancellation(record.experimentId);
      } else if (completed && experiment && !experiment.deletedAt) {
        const { settleExperimentStatus } = await import('./run-experiment');
        await settleExperimentStatus(record.experimentId);
      }
    }
    return prisma.experimentCancellation.update({ where: { id }, data: { status: completed ? 'completed' : 'pending' } });
  })().finally(() => reconciling.delete(id));
  reconciling.set(id, work);
  return work;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startExperimentCancellationWatchdog() {
  if (timer) return;
  let busy = false;
  const sweep = async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = await prisma.experimentCancellation.findMany({ where: { status: 'pending' }, orderBy: { updatedAt: 'asc' }, take: 20 });
      for (const row of rows) await reconcileCancellation(row.id);
    } catch (error) { console.error('[experiment-cancellation]', error); }
    finally { busy = false; }
  };
  timer = setInterval(() => void sweep(), 3000);
  timer.unref?.();
}
