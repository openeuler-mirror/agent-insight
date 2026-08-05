import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import { buildStubCollectPayload } from '@/lib/fault-injection/engine'
import {
  createTaskWithRuns,
  ingestCollectAndJudge,
  refreshTaskProgress,
} from '@/lib/fault-injection/store'
import { normalizeFiWorkspaceInput } from '@/lib/fault-injection/workspace'

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
    if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return NextResponse.json({ error: 'prompt required' }, { status: 400 })
    }
    for (const item of items) {
      if (!item?.fault || typeof item.fault !== 'string') {
        return NextResponse.json({ error: 'each item requires fault' }, { status: 400 })
      }
    }

    const envForcesDry = process.env.AGENT_INSIGHT_FI_DRY_RUN === '1'
    const wantReal = !envForcesDry && body.dryRun !== true
    const workspace = normalizeFiWorkspaceInput(body.workspace)
    const timeoutSeconds =
      typeof body.timeout_seconds === 'number' ? body.timeout_seconds : wantReal ? 180 : null

    const { task, runs } = await createTaskWithRuns({
      user: effectiveUser,
      name: body.name,
      platform: body.platform,
      agent: body.agent,
      prompt: body.prompt.trim(),
      workspace,
      model: body.model || null,
      timeoutSeconds,
      initialStatus: wantReal ? 'queued' : 'running',
      items: items.map((item: { fault: string; submode?: string }) => ({
        fault: item.fault,
        submode: item.submode,
      })),
    })

    // D-005: dry-run stays on server as zero-process stub (no Worker, no spawn).
    if (!wantReal) {
      for (const run of runs) {
        try {
          const payload = buildStubCollectPayload({
            runId: run.runId,
            fault: run.fault,
            platform: task.platform,
            prompt: task.prompt,
          })
          await ingestCollectAndJudge({
            runId: run.runId,
            user: task.user,
            payload,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          await prisma.faultInjectionRun.update({
            where: { id: run.id },
            data: { status: 'failed', error: message },
          })
        }
      }
      const updated = await refreshTaskProgress(task.id)
      return NextResponse.json({ task: serializeTask(updated || task), async: false, dryRun: true })
    }

    // Real collect: queue only; FI Worker claims on user machine.
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
