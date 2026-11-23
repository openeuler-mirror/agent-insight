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

import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {coreFiRpc,coreFiOwner,listCoreFiWorkers} from '@/lib/storage-core/fault-injection'
import type { FaultInjectionWorker } from '@prisma/client'
import { prisma } from '@/lib/storage/prisma'
import { refreshTaskProgress } from '@/lib/fault-injection/store'
import { pickDisplayClientIp } from '@/lib/reliability/client-ip'

export function claimTimeoutMs(): number {
  const sec = Number(process.env.AGENT_INSIGHT_FI_CLAIM_TIMEOUT_SEC || 300)
  return Math.max(60, Number.isFinite(sec) ? sec : 300) * 1000
}

export function workerOnlineMs(): number {
  // Consider offline after 3x default poll or claim timeout, whichever smaller bound
  return Math.min(claimTimeoutMs(), 60_000)
}

/** Requeue or stop stale collecting leases. Call at heartbeat/claim entry. */
export async function sweepStaleClaims(user: string | null) {
  {coreFiOwner(user);return (await coreFiRpc<{reclaimed:number}>('sweep',{claimTimeoutMs:claimTimeoutMs()})).reclaimed}
}

export type ClaimedRunPayload = {
  runId: string
  taskKey: string | null
  platform: string
  agent: string
  fault: string
  submode: string | null
  prompt: string
  model: string | null
  workspaceLogical: string
  timeoutSeconds: number | null
  stopRequested: boolean
  claimToken?: string
}

export function runCanBeClaimedByWorker(
  requestJson: string | null | undefined,
  workerId: string,
): boolean {
  try {
    const request = JSON.parse(requestJson || '{}') as { targetWorkerId?: unknown }
    const targetWorkerId = String(request.targetWorkerId || '').trim()
    return !targetWorkerId || targetWorkerId === workerId
  } catch {
    return true
  }
}

export async function claimQueuedRuns(input: {
  user: string
  workerId: string
  limit: number
}): Promise<ClaimedRunPayload[]> {
  {coreFiOwner(input.user);return (await coreFiRpc<{runs:ClaimedRunPayload[]}>('claim',{workerId:input.workerId,limit:input.limit})).runs}
}

function parseTimeoutFromTask(requestJson?: string | null): number | null {
  if (!requestJson) return null
  try {
    const parsed = JSON.parse(requestJson) as { timeoutSeconds?: number }
    return typeof parsed.timeoutSeconds === 'number' ? parsed.timeoutSeconds : null
  } catch {
    return null
  }
}

export async function upsertWorkerHeartbeat(input: {
  user: string
  workerId: string
  hostname?: string | null
  version?: string | null
  inventory?: unknown
  busySlots?: number
  partial?: boolean
}) {
  {coreFiOwner(input.user);return (await coreFiRpc<{worker:FaultInjectionWorker}>('heartbeat',input)).worker}
}

export function mergeWorkerInventory(previous: string | null | undefined, patch: unknown): Record<string, unknown> & { platforms: Record<string, unknown> } {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  let current: Record<string, unknown> = {}
  try { current = record(JSON.parse(previous || '{}')) } catch {}
  const next = record(patch)
  const platforms = { ...record(current.platforms) }
  const mergeRows = (left: unknown, right: unknown) => [...new Map([
    ...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : []),
  ].map(item => [typeof item === 'string' ? item : record(item).id || record(item).name || JSON.stringify(item), item])).values()]
  for (const [key, value] of Object.entries(record(next.platforms))) {
    const entry = record(value)
    const old = record(platforms[key])
    platforms[key] = { ...old, ...entry, agents: mergeRows(old?.agents, entry.agents), models: mergeRows(old?.models, entry.models) }
  }
  return { ...current, ...next, platforms }
}

export async function listStopCommandsForWorker(user: string, workerId: string) {
  {coreFiOwner(user);return (await coreFiRpc<{commands:Array<{type:'stop';runId:string}>}>('commands',{workerId})).commands}
}

export async function getLatestWorkerInventory(user: string | null, platform: string) {
  if (!user) return null
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const worker = ((coreFiOwner(user), (await listCoreFiWorkers(cutoff.getTime()))[0]))
  if (!worker) return null
  try {
    const inv = JSON.parse(worker.inventoryJson || '{}') as {
      platforms?: Record<
        string,
        { agents?: unknown[]; models?: unknown[]; ready?: boolean; executable?: string | null }
      >
    }
    return {
      workerId: worker.workerId,
      lastSeenAt: worker.lastSeenAt,
      platformInventory: inv.platforms?.[platform] || null,
      inventory: inv,
    }
  } catch {
    return { workerId: worker.workerId, lastSeenAt: worker.lastSeenAt, platformInventory: null, inventory: {} }
  }
}

export type WorkerPlatformInfo = {
  id: string
  label: string
  executable: string | null
  readiness: 'ready' | 'not_ready'
  preflight_errors: string[]
}

export type OnlineWorkerSummary = {
  workerId: string
  hostname: string | null
  lastSeenAt: string
  version: string | null
}

export type WorkerExecutionTarget = {
  workerId: string
  host: string
  hostname: string | null
  platform: string
  agent: string
  agentLabel: string
  models: Array<{ id: string; label: string }>
  lastSeenAt: string
}

function inventoryOption(row: unknown): { id: string; label: string } | null {
  if (typeof row === 'string') {
    const id = row.trim()
    return id ? { id, label: id } : null
  }
  if (!row || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  const id = String(rec.id || rec.modelID || rec.name || '').trim()
  if (!id) return null
  const label = String(rec.label || rec.name || id).trim() || id
  const provider = String(rec.providerID || rec.providerId || rec.provider || '').trim()
  return { id, label: provider ? `${label} · ${provider}` : label }
}

export function executionTargetsFromWorker(
  worker: Pick<FaultInjectionWorker, 'workerId' | 'hostname' | 'inventoryJson' | 'lastSeenAt'>,
): WorkerExecutionTarget[] {
  try {
    const inventory = JSON.parse(worker.inventoryJson || '{}') as {
      reportedIp?: string
      ip?: string
      observedIp?: string
      platforms?: Record<string, { ready?: boolean; agents?: unknown[]; models?: unknown[] }>
    }
    const host = pickDisplayClientIp({
      reportedIp: inventory.reportedIp || inventory.ip || null,
      observedIp: inventory.observedIp || null,
    }) || worker.hostname || worker.workerId
    const out: WorkerExecutionTarget[] = []
    for (const [platform, info] of Object.entries(inventory.platforms || {})) {
      if (!info?.ready) continue
      const agents = (Array.isArray(info.agents) ? info.agents : [])
        .map(inventoryOption)
        .filter((row): row is { id: string; label: string } => Boolean(row))
      const models = (Array.isArray(info.models) ? info.models : [])
        .map(inventoryOption)
        .filter((row): row is { id: string; label: string } => Boolean(row))
      for (const agent of agents) {
        out.push({
          workerId: worker.workerId,
          host,
          hostname: worker.hostname,
          platform,
          agent: agent.id,
          agentLabel: agent.label,
          models: [{ id: '', label: '平台默认' }, ...models],
          lastSeenAt: worker.lastSeenAt.toISOString(),
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/** All executable Agent targets reported by online configured clients. */
export async function listWorkerExecutionTargets(user: string | null): Promise<WorkerExecutionTarget[]> {
  if (!user) return []
  const cutoff = new Date(Date.now() - workerOnlineMs())
  let workers: FaultInjectionWorker[]
  try {
    workers = ((coreFiOwner(user),await listCoreFiWorkers(cutoff.getTime())))
  } catch (error) {
    throw error
  }
  const out: WorkerExecutionTarget[] = []
  for (const worker of workers) {
    out.push(...executionTargetsFromWorker(worker))
  }
  return out
}

/** Platform readiness from online FI Worker inventory (not server PATH). */
export async function listPlatformsFromWorkers(user: string | null): Promise<{
  platforms: WorkerPlatformInfo[]
  workers: OnlineWorkerSummary[]
  ok: boolean
}> {
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const workers = user
    ? ((coreFiOwner(user),(await listCoreFiWorkers(cutoff.getTime())).slice(0,5)))
    : []

  const platforms = (['opencode', 'xiaoo'] as const).map((id) => {
    let ready = false
    let executable: string | null = null
    let errors: string[] = []
    for (const w of workers) {
      try {
        const inv = JSON.parse(w.inventoryJson || '{}') as {
          platforms?: Record<string, { ready?: boolean; executable?: string | null }>
        }
        const p = inv.platforms?.[id]
        if (p?.ready) {
          ready = true
          executable = p.executable || id
          errors = []
          break
        }
        if (p && !p.ready) {
          errors = [`${id} not ready on worker ${w.workerId}`]
        }
      } catch {
        /* ignore */
      }
    }
    if (!workers.length) {
      errors = [
        '无在线 FI Worker；请在「新建注入任务」页复制账号相关的 setup 命令并在本机执行',
      ]
    }
    return {
      id,
      label: id === 'xiaoo' ? 'xiaoO' : 'OpenCode',
      executable,
      readiness: ready ? ('ready' as const) : ('not_ready' as const),
      preflight_errors: errors,
    }
  })

  return {
    platforms,
    workers: workers.map((w: FaultInjectionWorker) => ({
      workerId: w.workerId,
      hostname: w.hostname,
      lastSeenAt: w.lastSeenAt.toISOString(),
      version: w.version,
    })),
    ok: workers.length > 0,
  }
}
