import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/storage/prisma';

type Scope = { experimentId: string; caseId?: string; signal: AbortSignal; cleanupUnconfirmed?: boolean };
const key = Symbol.for('agent-insight.experiment-cancellation-context');
const globals = globalThis as unknown as Record<symbol, AsyncLocalStorage<Scope>>;
const context = globals[key] ||= new AsyncLocalStorage<Scope>();
const activeKey = Symbol.for('agent-insight.experiment-cancellation-active');
const activeGlobals = globalThis as unknown as Record<symbol, Map<string, number>>;
const active = activeGlobals[activeKey] ||= new Map<string, number>();
const operationKey = (experimentId: string, caseId: string) => `${experimentId}\0${caseId}`;
export function activeCaseOperations(caseId: string, experimentId: string): number { return active.get(operationKey(experimentId, caseId)) || 0; }

export function experimentSignal(): AbortSignal | undefined { return context.getStore()?.signal; }
export function markExperimentCleanupUnconfirmed(): void {
  const scope = context.getStore();
  if (scope) scope.cleanupUnconfirmed = true;
}

export async function assertExperimentActive(experimentId: string, caseId?: string): Promise<void> {
  const experiment = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { deletedAt: true, status: true } });
  const row = caseId ? await prisma.experimentCase.findUnique({ where: { id: caseId }, select: { deletedAt: true } }) : null;
  const cancelled = await prisma.experimentCancellation.findFirst({
    where: { experimentId, caseKey: { in: ['', ...(caseId ? [caseId] : [])] } }, select: { id: true },
  });
  if (!experiment || experiment.deletedAt || experiment.status === 'cancelled' || row?.deletedAt || cancelled) {
    throw Object.assign(new Error('实验或 Case 已取消'), { code: 'EXPERIMENT_CANCELLED', status: 409 });
  }
}

export async function withExperimentCancellation<T>(experimentId: string, caseId: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try { await assertExperimentActive(experimentId, caseId); }
    catch (error) { controller.abort(error); }
    finally { checking = false; }
  };
  await check();
  controller.signal.throwIfAborted();
  const operationId = randomUUID();
  await prisma.experimentLocalExecution.create({ data: { id: operationId, experimentId, caseKey: caseId || '' } });
  if (caseId) active.set(operationKey(experimentId, caseId), activeCaseOperations(caseId, experimentId) + 1);
  const timer = setInterval(() => void check(), 500);
  timer.unref?.();
  const scope: Scope = { experimentId, caseId, signal: controller.signal };
  try {
    await assertExperimentActive(experimentId, caseId);
    return await context.run(scope, async () => {
      const result = await work(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    });
  } finally {
    clearInterval(timer);
    if (!scope.cleanupUnconfirmed) await prisma.experimentLocalExecution.deleteMany({ where: { id: operationId } });
    if (caseId) {
      const remaining = activeCaseOperations(caseId, experimentId) - 1;
      if (remaining > 0) active.set(operationKey(experimentId, caseId), remaining); else active.delete(operationKey(experimentId, caseId));
      if (remaining <= 0 && controller.signal.aborted) {
        await prisma.experimentEvalResult.updateMany({
          where: { caseId, status: 'running', OR: [{ case: { deletedAt: { not: null } } }, { case: { experiment: { deletedAt: { not: null } } } }] },
          data: { status: 'cancelled', errorMessage: '用户停止并删除' },
        });
      }
    }
  }
}
