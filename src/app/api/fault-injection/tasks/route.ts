import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import { createTaskWithRuns, refreshTaskProgress } from '@/lib/fault-injection/store'
import { normalizeFiWorkspaceInput } from '@/lib/fault-injection/workspace'
import { listPlatformsFromWorkers } from '@/lib/fault-injection/worker-protocol'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { username } = await resolveUser(req)
  const status = new URL(req.url).searchParams.get('status')
  const tasks = await prisma.faultInjectionTask.findMany({
    where: {
      ...(username ? { user: username } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return NextResponse.json({
    tasks: tasks.map(serializeTask),
  })
}

export async function POST(req: Request) {
  try {
    const { username } = await resolveUser(req)
    const effectiveUser = username || process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || null
    const body = await req.json()
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (!body.platform || typeof body.platform !== 'string') {
      return NextResponse.json({ error: 'platform required' }, { status: 400 })
    }
    if (!body.agent || typeof body.agent !== 'string') {
      return NextResponse.json({ error: 'agent required' }, { status: 400 })
    }
    if (body.prompt != null && typeof body.prompt !== 'string') {
      return NextResponse.json({ error: 'prompt must be a string' }, { status: 400 })
    }
    for (const item of items) {
      if (!item?.fault || typeof item.fault !== 'string') {
        return NextResponse.json({ error: 'each item requires fault' }, { status: 400 })
      }
    }

    const { platforms, ok } = await listPlatformsFromWorkers(username)
    if (!ok) {
      return NextResponse.json(
        {
          error:
            '无在线 FI Worker；请在「新建注入任务」页复制账号相关的 setup 命令并在本机执行',
        },
        { status: 503 },
      )
    }
    const platformInfo = platforms.find((p) => p.id === body.platform)
    if (!platformInfo || platformInfo.readiness !== 'ready') {
      return NextResponse.json(
        { error: `平台 ${body.platform} 不可用（需在线 Worker 上报就绪）` },
        { status: 400 },
      )
    }

    const workspace = normalizeFiWorkspaceInput(body.workspace)
    const timeoutSeconds =
      typeof body.timeout_seconds === 'number' ? body.timeout_seconds : 180

    const { task } = await createTaskWithRuns({
      user: effectiveUser,
      name: body.name,
      platform: body.platform,
      agent: body.agent,
      prompt: typeof body.prompt === 'string' ? body.prompt.trim() : '',
      workspace,
      model: body.model || null,
      timeoutSeconds,
      initialStatus: 'queued',
      items: items.map((item: { fault: string; submode?: string }) => ({
        fault: item.fault,
        submode: item.submode,
      })),
    })

    const updated = await refreshTaskProgress(task.id)
    return NextResponse.json({
      task: serializeTask(updated || task),
      async: true,
      needsWorker: true,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function serializeTask(task: {
  id: string
  taskKey: string
  name: string
  status: string
  platform: string
  agent: string
  prompt: string
  workspace: string
  model: string | null
  itemsJson: string
  progressJson: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}) {
  return {
    task_id: task.taskKey,
    id: task.id,
    name: task.name,
    status: task.status,
    platform: task.platform,
    agent: task.agent,
    prompt: task.prompt,
    workspace: task.workspace,
    model: task.model,
    items: JSON.parse(task.itemsJson || '[]'),
    progress: JSON.parse(task.progressJson || '{}'),
    error: task.error,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
    started_at: task.startedAt?.toISOString() || null,
    finished_at: task.finishedAt?.toISOString() || null,
  }
}
