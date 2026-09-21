import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/storage/prisma';
import { getTraceLifecycle } from '@/lib/observe/trace-lifecycle';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from './run-experiment';

interface WatchExperiment {
  id: string;
  user: string;
  agentName: string;
  watchEnabledAt: Date;
}

interface WatchTrace {
  id: string;
  taskId: string;
  framework: string | null;
  failures: string | null;
  endTime: Date;
}

function completedSuccessfully(trace: WatchTrace): boolean {
  let failures: unknown = [];
  try { failures = JSON.parse(trace.failures || '[]'); } catch { return false; }
  return getTraceLifecycle(trace.endTime, { framework: trace.framework, failures }).traceStatus === 'success';
}

export function createExperimentWatcher(options: {
  intervalMs?: number;
  pageSize?: number;
  concurrency?: number;
  evaluate?: typeof evaluateEvalExperimentCase;
} = {}) {
  const intervalMs = options.intervalMs ?? 5_000;
  const pageSize = options.pageSize ?? 100;
  const concurrency = options.concurrency ?? 4;
  const evaluate = options.evaluate ?? evaluateEvalExperimentCase;
  const cursors = new Map<string, string>();
  const active = new Set<Promise<void>>();
  let scanning = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let nextExperiment = 0;

  async function scanExperiment(experiment: WatchExperiment) {
    const cursor = cursors.get(experiment.id) ?? '';
    // 每轮分页后回到起点，不能用时间水位线，否则会漏掉晚到或稍后才完成的 Trace。
    const traces: WatchTrace[] = await prisma.$queryRaw(Prisma.sql`
      SELECT e."id", e."taskId", e."framework", e."failures", s."endTime"
      FROM "Execution" e JOIN "Session" s ON s."taskId" = e."taskId"
      WHERE e."user" = ${experiment.user} AND e."agentName" = ${experiment.agentName}
        AND e."isSubagent" = false
        AND s."startTime" > ${experiment.watchEnabledAt} AND s."endTime" IS NOT NULL
        AND e."id" > ${cursor}
        AND NOT EXISTS (
          SELECT 1 FROM "ExperimentCase" c
          WHERE c."experimentId" = ${experiment.id}
            AND (c."taskId" = e."taskId" OR c."executionId" = e."id")
        )
      ORDER BY e."id" ASC LIMIT ${pageSize}
    `);

    for (const trace of traces) {
      if (active.size >= concurrency) return;
      if (!completedSuccessfully(trace)) {
        cursors.set(experiment.id, trace.id);
        continue;
      }
      const enabled = await prisma.experiment.findFirst({
        where: {
          id: experiment.id, user: experiment.user, agentName: experiment.agentName,
          watchMode: true, watchEnabledAt: experiment.watchEnabledAt,
        },
        select: { id: true },
      });
      if (!enabled) return;

      const caseId = await addEvalExperimentCase(experiment.id, {
        executionId: trace.id, taskId: trace.taskId, input: '', actualOutput: '',
      }, { onlyIfNew: true });
      cursors.set(experiment.id, trace.id);
      if (!caseId) continue;

      const work = Promise.resolve()
        .then(() => evaluate(experiment.id, caseId, experiment.user))
        .then(() => undefined)
        .catch(error => {
          console.warn(`[experiment-watch] eval failed exp=${experiment.id} case=${caseId}:`, error);
        })
        .finally(() => active.delete(work));
      active.add(work);
    }
    if (traces.length < pageSize) cursors.delete(experiment.id);
  }

  async function scan() {
    if (scanning || active.size >= concurrency) return;
    scanning = true;
    try {
      const experiments: WatchExperiment[] = await prisma.experiment.findMany({
        where: { watchMode: true, watchEnabledAt: { not: null }, agentName: { not: '' } },
        select: { id: true, user: true, agentName: true, watchEnabledAt: true },
        orderBy: { id: 'asc' },
      });
      const enabledIds = new Set(experiments.map(experiment => experiment.id));
      for (const id of cursors.keys()) if (!enabledIds.has(id)) cursors.delete(id);
      const start = nextExperiment % Math.max(1, experiments.length);
      for (let i = 0; i < experiments.length && active.size < concurrency; i++) {
        const index = (start + i) % experiments.length;
        nextExperiment = index + 1;
        try {
          await scanExperiment(experiments[index]);
        } catch (error) {
          console.warn(`[experiment-watch] scan failed exp=${experiments[index].id}:`, error);
        }
      }
    } finally {
      scanning = false;
    }
  }

  function start() {
    if (timer) return;
    const tick = () => { void scan().catch(error => console.error('[experiment-watch] scan failed:', error)); };
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { scan, start, stop, waitForIdle: () => Promise.all([...active]) };
}

const WATCHER_KEY = Symbol.for('agent-insight.experiment.watcher');

export function startExperimentWatcher() {
  const state = globalThis as unknown as Record<symbol, ReturnType<typeof createExperimentWatcher>>;
  state[WATCHER_KEY] ??= createExperimentWatcher();
  state[WATCHER_KEY].start();
}
