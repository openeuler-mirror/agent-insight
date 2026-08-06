import { randomBytes } from 'crypto'
import { prisma } from '@/lib/storage/prisma'
import { composeFaultPrompt, findSubmode } from '@/lib/fault-injection/compose-prompt'
import { listFaultsViaPython, type CollectPayload } from '@/lib/fault-injection/engine'
import { judgeFaultInjection } from '@/lib/fault-injection/judge'
import { mergeEvaluationMarkers } from '@/lib/fault-injection/trace-markers'

export function newTaskKey(): string {
  return `task-${randomBytes(4).toString('hex')}`
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 15)
  return `ras-${stamp}-${randomBytes(4).toString('hex')}`
}

export async function createTaskWithRuns(input: {
  user: string | null
  name?: string
  platform: string
  agent: string
  prompt: string
  workspace: string
  model?: string | null
  items: Array<{ fault: string; submode?: string | null }>
  timeoutSeconds?: number | null
  initialStatus?: 'queued' | 'running'
}) {
  const taskKey = newTaskKey()
  const items = input.items.map((item, index) => ({
    item_id: `item-${index + 1}`,
    fault: item.fault,
    submode: item.submode || null,
    run_id: null as string | null,
    status: 'queued',
    phase: 'queued',
    error: null as string | null,
    result: null as Record<string, unknown> | null,
  }))

  const initialStatus = input.initialStatus || 'queued'
  const requestJson = JSON.stringify({
    timeoutSeconds: input.timeoutSeconds ?? null,
  })

  const task = await prisma.faultInjectionTask.create({
    data: {
      taskKey,
      name: input.name || `注入任务 ${taskKey}`,
      status: initialStatus,
      platform: input.platform,
      agent: input.agent,
      prompt: input.prompt,
      workspace: input.workspace,
      model: input.model || null,
      requestJson,
      itemsJson: JSON.stringify(items),
      progressJson: JSON.stringify({
        total: items.length,
        queued: items.length,
        running: 0,
        completed: 0,
        failed: 0,
        judge_skipped: 0,
        stopped: 0,
      }),
      user: input.user,
      startedAt: initialStatus === 'queued' ? null : new Date(),
    },
  })

  const catalog = (await listFaultsViaPython(input.platform)) as Array<{
    id?: string
    name?: string
    skillName?: string
    skill_name?: string
    submodes?: Array<{ id: string; name: string }>
  }>
  const byFault = new Map(catalog.map((row) => [String(row.id || row.name || ''), row]))

  const runs = []
  for (const item of items) {
    const runId = newRunId()
    item.run_id = runId
    const faultMeta = byFault.get(item.fault)
    const skillName =
      faultMeta?.skillName || faultMeta?.skill_name || item.fault
    const selected = findSubmode(faultMeta?.submodes || [], item.submode)
    const prompt = composeFaultPrompt({
      skillName,
      basePrompt: input.prompt,
      submode: selected,
    })
    const run = await prisma.faultInjectionRun.create({
      data: {
        runId,
        fiTaskId: task.id,
        itemId: item.item_id,
        user: input.user,
        platform: input.platform,
        agent: input.agent,
        fault: item.fault,
        submode: item.submode,
        status: 'queued',
        queuedAt: new Date(),
        requestJson: JSON.stringify({
          prompt,
          workspace: input.workspace,
          model: input.model || null,
          timeoutSeconds: input.timeoutSeconds ?? null,
        }),
      },
    })
    runs.push(run)
  }

  const updatedTask = await prisma.faultInjectionTask.update({
    where: { id: task.id },
    data: { itemsJson: JSON.stringify(items) },
  })

  return { task: updatedTask, runs, items }
}

export async function ingestCollectAndJudge(input: {
  runId: string
  user: string | null
  payload: CollectPayload
}) {
  const interactionsJson = JSON.stringify(input.payload.interactions || [])
  const sessionTaskId = input.payload.taskId

  await prisma.session.upsert({
    where: { taskId: sessionTaskId },
    create: {
      taskId: sessionTaskId,
      label: `FI ${input.payload.fault}`,
      query: null,
      interactions: interactionsJson,
      user: input.user,
    },
    update: {
      interactions: interactionsJson,
      user: input.user || undefined,
    },
  })

  await prisma.faultInjectionRun.update({
    where: { runId: input.runId },
    data: {
      status: 'judging',
      error: null,
      sessionTaskId,
      faultActivated: Boolean(input.payload.faultActivated),
      faultActivatedAt: input.payload.faultActivatedAt
        ? new Date(input.payload.faultActivatedAt)
        : null,
      injectionMethod: input.payload.injectionMethod || null,
      markersJson: JSON.stringify(input.payload.markers || []),
      injectionEvidenceJson: JSON.stringify(input.payload.injectionEvidence || {}),
    },
  })

  const judged = await judgeFaultInjection({
    user: input.user,
    fault: input.payload.fault,
    injectionMethod: input.payload.injectionMethod,
    faultActivated: Boolean(input.payload.faultActivated),
    interactions: input.payload.interactions || [],
  })

  // Skipped judge stays judge_skipped (not completed).
  const status = judged.skipped ? 'judge_skipped' : 'completed'

  const markersJson = JSON.stringify(
    mergeEvaluationMarkers(input.payload.markers || [], {
      skipped: Boolean(judged.skipped),
      outcome: judged.outcome,
      reason: judged.reason,
      model: judged.model,
    }),
  )

  const updated = await prisma.faultInjectionRun.update({
    where: { runId: input.runId },
    data: {
      status,
      outcome: judged.outcome,
      faultContainmentStatus: judged.fault_containment_status,
      judgeReason: judged.reason,
      judgeRawJson: JSON.stringify({
        raw: judged.raw || null,
        model: judged.model || null,
        skipped: judged.skipped,
      }),
      markersJson,
      judgedAt: new Date(),
    },
  })

  return updated
}

export async function refreshTaskProgress(taskId: string) {
  const task = await prisma.faultInjectionTask.findUnique({ where: { id: taskId } })
  if (!task) return null
  const runs = await prisma.faultInjectionRun.findMany({ where: { fiTaskId: taskId } })
  type RunRow = (typeof runs)[number]
  const items = JSON.parse(task.itemsJson || '[]') as Array<Record<string, unknown>>
  for (const item of items) {
    const run = runs.find((r: RunRow) => r.runId === item.run_id)
    if (!run) continue
    item.status = run.status
    item.phase = run.status
    item.error = run.error
    item.result = run.outcome
      ? {
          outcome: run.outcome,
          fault_containment_status: run.faultContainmentStatus,
          reason: run.judgeReason,
        }
      : null
  }
  const progress = {
    total: runs.length,
    queued: runs.filter((r: RunRow) => r.status === 'queued').length,
    running: runs.filter((r: RunRow) => ['collecting', 'judging'].includes(r.status)).length,
    completed: runs.filter((r: RunRow) => r.status === 'completed').length,
    judge_skipped: runs.filter((r: RunRow) => r.status === 'judge_skipped').length,
    failed: runs.filter((r: RunRow) => r.status === 'failed').length,
    stopped: runs.filter((r: RunRow) => r.status === 'stopped').length,
  }
  const finished =
    progress.completed +
    progress.judge_skipped +
    progress.failed +
    progress.stopped
  let status = task.status
  if (progress.running > 0) {
    status = 'running'
  } else if (progress.queued === progress.total && progress.total > 0) {
    status = 'queued'
  } else if (progress.stopped && progress.stopped + progress.failed === progress.total) {
    status = 'stopped'
  } else if (progress.failed && finished === progress.total) status = 'failed'
  else if (finished === progress.total && progress.total > 0) {
    status = 'completed'
  } else if (progress.queued > 0) {
    status = 'queued'
  } else status = 'running'

  return prisma.faultInjectionTask.update({
    where: { id: taskId },
    data: {
      itemsJson: JSON.stringify(items),
      progressJson: JSON.stringify(progress),
      status,
      startedAt:
        status === 'running' && !task.startedAt ? new Date() : task.startedAt,
      finishedAt: status === 'running' || status === 'queued' ? null : new Date(),
    },
  })
}
