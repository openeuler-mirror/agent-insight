import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'

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

    let deleted = 0
    for (const task of tasks) {
      if (task.status === 'running') continue
      await prisma.faultInjectionRun.deleteMany({ where: { fiTaskId: task.id } })
      await prisma.faultInjectionTask.delete({ where: { id: task.id } })
      deleted += 1
    }

    return NextResponse.json({ ok: true, deleted })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
