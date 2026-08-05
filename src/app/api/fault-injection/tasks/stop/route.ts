import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import { refreshTaskProgress } from '@/lib/fault-injection/store'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { username } = await resolveUser(req)
    const body = await req.json()
    const taskIds: string[] = Array.isArray(body.taskIds) ? body.taskIds : []
    if (!taskIds.length) {
      return NextResponse.json({ error: 'taskIds required' }, { status: 400 })
    }

    const tasks = await prisma.faultInjectionTask.findMany({
      where: {
        OR: [{ taskKey: { in: taskIds } }, { id: { in: taskIds } }],
        ...(username ? { user: username } : {}),
      },
    })

    for (const task of tasks) {
      if (!['running', 'queued'].includes(task.status)) continue

      // queued → stopped immediately; collecting → stopRequested for Worker
      await prisma.faultInjectionRun.updateMany({
        where: { fiTaskId: task.id, status: 'queued' },
        data: { status: 'stopped', stopRequested: true, error: 'stopped by user' },
      })
      await prisma.faultInjectionRun.updateMany({
        where: { fiTaskId: task.id, status: { in: ['collecting', 'judging'] } },
        data: { stopRequested: true },
      })
      await refreshTaskProgress(task.id).catch(() => undefined)
    }

    return NextResponse.json({ ok: true, count: tasks.length })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
