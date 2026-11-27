/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomBytes } from 'crypto'
import { prisma } from '@/lib/storage/prisma'
import { composeFaultPrompt, findSubmode } from '@/lib/fault-injection/compose-prompt'
import { listFaultsViaPython, type CollectPayload } from '@/lib/fault-injection/engine'
import { isFiBusinessTraceUsable } from '@/lib/fault-injection/trace-readiness'

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
  targetWorkerId?: string | null
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
          targetWorkerId: input.targetWorkerId || null,
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

function looksLikeFiRunId(value: string): boolean {
  return /^ras-\d{8}T[0-9a-zA-Z_-]+$/.test(value.trim())
}

function looksLikeMessageOrPartId(value: string): boolean {
  return /^(msg_|prt_)[0-9a-zA-Z_-]+$/.test(value.trim())
}

/** True when value is a bare platform session usable as FI↔RAS join key. */
export function isPlatformSessionId(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false
  const s = value.trim()
  if (looksLikeFiRunId(s) || looksLikeMessageOrPartId(s)) return false
  return true
}

/**
 * Persist FI collection facts and finish collection without invoking a Judge.
 * Business traces belong to the independent collector; experiment orchestration
 * waits for late Session/Execution uploads before starting selected evaluators.
 */
export async function persistFiCollectIngress(input: {
  runId: string
  user: string | null
  payload: CollectPayload
  stopped?: boolean
}) {
  const rawTaskId =
    typeof input.payload.taskId === 'string' ? input.payload.taskId.trim() : ''
  const sessionAligned =
    input.payload.sessionAligned !== false && isPlatformSessionId(rawTaskId)
  const sessionTaskId = sessionAligned ? rawTaskId : null

  const updated = await prisma.faultInjectionRun.update({
    where: { runId: input.runId },
    data: {
      status: input.stopped ? 'stopped' : sessionAligned ? 'completed' : 'failed',
      error: input.stopped
        ? 'stopped by user'
        : sessionAligned ? null
          : 'session_unaligned: missing platform session id (FI runId is not a RAS join key)',
      sessionTaskId,
      faultActivated: Boolean(input.payload.faultActivated),
      faultActivatedAt: input.payload.faultActivatedAt
        ? new Date(input.payload.faultActivatedAt)
        : null,
      injectionMethod: input.payload.injectionMethod || null,
      markersJson: JSON.stringify((input.payload.markers || []).filter((marker) =>
        !marker || typeof marker !== 'object' || (marker as { kind?: unknown }).kind !== 'evaluation')),
    },
  })

  // 实验「生成 Trace」依赖 Case.taskId；collect 对齐后立刻回填（避免评测时空轨迹）。
  if (sessionTaskId) {
    const fiKeys = Array.from(new Set([input.runId, updated.id].filter(Boolean)))
    const trace = await loadBusinessSession(sessionTaskId, updated)
    await prisma.experimentCase.updateMany({
      where: {
        fiRunId: { in: fiKeys },
        OR: [{ taskId: null }, { taskId: '' }],
      },
      data: {
        taskId: sessionTaskId,
        ...(trace.ready && trace.execution ? { executionId: trace.execution.id } : {}),
      },
    })
  }

  return updated
}

/** Identity used to exclude RAS internal sessions from business Trace binding. */
type FiTraceIdentity = { platform: string; agent: string; user?: string | null }

/** Read the independent collector's business trace; never synthesize it from FI output. */
async function loadBusinessSession(sessionTaskId: string, identity: FiTraceIdentity) {
  const owner = identity.user ? { user: identity.user } : {}
  const [session, execution] = await Promise.all([
    prisma.session.findFirst({ where: { taskId: sessionTaskId, ...owner } }),
    prisma.execution.findFirst({
      where: { taskId: sessionTaskId, isSubagent: false, ...owner },
      orderBy: { timestamp: 'desc' },
      select: { id: true, agentName: true },
    }),
  ])
  const ready = isFiBusinessTraceUsable({
    platform: identity.platform, agent: identity.agent,
    executionAgent: execution?.agentName,
    interactions: session?.interactions, endTime: session?.endTime,
  })
  return {
    execution, ready,
  }
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
    // Historical judge_skipped rows remain terminal; new collections never create them.
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
