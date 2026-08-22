import { NextResponse } from 'next/server'
import type { FaultInjectionRun } from '@prisma/client'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ taskId: string }> },
) {
  try {
    const { username } = await resolveUser(req)
    const { taskId } = await ctx.params
    const decoded = decodeURIComponent(taskId)

    const task = await prisma.faultInjectionTask.findFirst({
      where: {
        OR: [{ taskKey: decoded }, { id: decoded }],
      },
      include: { runs: { orderBy: { createdAt: 'asc' } } },
    })

    if (!task) {
      return NextResponse.json({ error: 'not found', taskId: decoded }, { status: 404 })
    }

    // Ownership: allow if no user on task, or matches resolved user, or no auth user (local).
    if (task.user && username && task.user !== username) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    return NextResponse.json({
      task: {
        task_id: task.taskKey,
        id: task.id,
        name: task.name,
        status: task.status,
        platform: task.platform,
        agent: task.agent,
        model: task.model,
        workspace: task.workspace,
        prompt: task.prompt,
        items: JSON.parse(task.itemsJson || '[]'),
        progress: JSON.parse(task.progressJson || '{}'),
        started_at: task.startedAt?.toISOString() || null,
        runs: task.runs.map((run: FaultInjectionRun) => ({
          run_id: run.runId,
          fault: run.fault,
          submode: run.submode,
          status: run.status,
          outcome: run.outcome,
          fault_containment_status: run.faultContainmentStatus,
          judge_reason: run.judgeReason,
          // Trace ID (= platform session / Execution.taskId). Keep session_task_id alias.
          trace_id: run.sessionTaskId,
          session_task_id: run.sessionTaskId,
          error: run.error,
        })),
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[FI task detail]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
