import { createHash } from 'node:crypto'
import { prisma } from '@/lib/storage/prisma'

export async function findBenchmarkExecution(user: string, traceId: string) {
  try {
    const direct = await prisma.execution.findFirst({
      where: { user, isSubagent: false, OR: [{ id: traceId }, { taskId: traceId }, { agentSessionId: traceId }] },
      orderBy: { timestamp: 'desc' },
      select: { id: true, taskId: true, finalResult: true },
    })
    if (direct || !/^[0-9a-f]{32}$/.test(traceId)) return direct

    // Older MCTS clients returned the OTLP hash instead of the platform's session key.
    let cursor: string | undefined
    for (;;) {
      const roots = await prisma.execution.findMany({
        where: { user, isSubagent: false, framework: 'mcts-xgovernor',
          taskId: { startsWith: 'mcts.run.', not: { contains: '.runtime.' } } },
        orderBy: { id: 'asc' }, take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, taskId: true, finalResult: true },
      })
      for (const execution of roots) {
        if (!/^mcts\.run\.[0-9a-f]{32}$/.test(execution.taskId || '')) continue
        const otlpId = createHash('sha256').update(`mcts-xgovernor\u001f${execution.taskId}`).digest('hex').slice(0, 32)
        if (otlpId === traceId) return execution
      }
      if (roots.length < 100) return null
      cursor = roots.at(-1)!.id
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') return null
    throw error
  }
}
