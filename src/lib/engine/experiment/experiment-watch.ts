// 监听模式实验（取代旧 autoWatch）：某 Agent 新上报的 trace 自动进入其监听实验并评测。
// 触发点：trace 摄取完成的钩子（ingest/observe），传入 (user, taskId)。
import { prisma } from '@/lib/storage/prisma';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from './run-experiment';

// 同一 (user,taskId) 并发去重（多个摄取钩子可能同时触发）
const inFlight = new Set<string>();

/**
 * 新 trace 到达 → 找该 Agent 的监听实验（watchMode=true 且 agentName 匹配 且 watchEnabledAt≤trace 时间）
 * → 若该 trace 尚未在实验中 → 加 case + 同步评测。多实验监听同一 Agent 时逐个处理。
 */
export async function triggerExperimentWatchForTask(
  user: string | null | undefined,
  taskId: string | null | undefined,
): Promise<void> {
  const safeUser = String(user || '').trim();
  const safeTaskId = String(taskId || '').trim();
  if (!safeUser || !safeTaskId) return;
  const key = `${safeUser}::${safeTaskId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const execution = await prisma.execution.findFirst({
      where: { taskId: safeTaskId, OR: [{ user: safeUser }, { user: null }] },
      orderBy: { timestamp: 'desc' },
      select: { id: true, agentName: true, timestamp: true },
    });
    const agentName = String(execution?.agentName || '').trim();
    if (!execution || !agentName) return;

    // trace 完成（session 有 endTime）才评，避免评到进行中的半截 trace
    const session = await prisma.session.findUnique({ where: { taskId: safeTaskId }, select: { endTime: true } });
    if (!session?.endTime) return;

    const watchExps = await prisma.experiment.findMany({
      where: { user: safeUser, watchMode: true, agentName },
      select: { id: true, watchEnabledAt: true },
    });
    const traceAt = execution.timestamp instanceof Date ? execution.timestamp.getTime() : 0;

    for (const exp of watchExps) {
      // 只评监听开启之后新产生的 trace
      const enabledAt = exp.watchEnabledAt instanceof Date ? exp.watchEnabledAt.getTime() : 0;
      if (enabledAt && traceAt && traceAt < enabledAt) continue;
      // 幂等：该 trace 已在本实验里则跳过
      const existing = await prisma.experimentCase.findFirst({
        where: { experimentId: exp.id, taskId: safeTaskId },
        select: { id: true },
      });
      if (existing) continue;
      try {
        const caseId = await addEvalExperimentCase(exp.id, {
          taskId: safeTaskId, input: '', actualOutput: '', referenceOutput: null,
        });
        await evaluateEvalExperimentCase(exp.id, caseId, safeUser);
      } catch (e) {
        console.warn(`[experiment-watch] eval failed exp=${exp.id} task=${safeTaskId}:`, (e as Error)?.message);
      }
    }
  } catch (error) {
    console.error('[experiment-watch] failed:', error);
  } finally {
    inFlight.delete(key);
  }
}
