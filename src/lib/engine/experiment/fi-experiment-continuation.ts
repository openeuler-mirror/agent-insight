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

import { prisma } from '@/lib/storage/prisma'
import { awaitFiSessionsAndBindExperimentCases } from './fi-orchestrate'
import { startExperimentRun } from './run-experiment'

const STATE_KEY = Symbol.for('agent-insight.fi-experiment-continuations')
interface ContinuationState {
  runs: Map<string, Promise<void>>
  timer?: ReturnType<typeof setInterval>
  scan?: Promise<number>
}

/** Share ownership across Next.js request modules and development hot reloads. */
function state(): ContinuationState {
  const global = globalThis as unknown as Record<symbol, ContinuationState>
  return global[STATE_KEY] ??= { runs: new Map() }
}

/** Recognize the persisted FI generation contract without trusting malformed historical JSON. */
function isFiSnapshot(value: string | null): boolean {
  try {
    const snapshot = JSON.parse(value || '{}')
    return snapshot?.traceSource === 'generate' && snapshot.fiOrchestrate === true
  } catch { return false }
}

/** Resume binding and evaluation without submitting or replaying any FI Agent work. */
async function continueFiExperiment(experimentId: string, user: string): Promise<void> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, user, status: 'running', deletedAt: null, scope: '', type: 'single' },
    select: { configSnapshotJson: true, cases: {
      where: { deletedAt: null }, select: { id: true, fiRunId: true },
    } },
  })
  if (!experiment || !isFiSnapshot(experiment.configSnapshotJson)) return
  const cases: Array<{ id: string; fiRunId: string | null }> = experiment.cases
  const runIds = cases.flatMap((item) => item.fiRunId ? [item.fiRunId] : [])
  if (!runIds.length) return

  const stillActive = async () => Boolean(await prisma.experiment.findFirst({
    where: { id: experimentId, user, status: 'running', deletedAt: null }, select: { id: true },
  }))
  const bound = await awaitFiSessionsAndBindExperimentCases({
    runIds, waitForActiveRuns: true, shouldContinue: stillActive,
  })
  if (!(await stillActive())) return
  const ready = new Set(bound.readyRunIds)
  const caseIds = cases.filter((item) => item.fiRunId && ready.has(item.fiRunId)).map((item) => item.id)
  if (!caseIds.length) {
    await prisma.experiment.updateMany({
      where: { id: experimentId, user, status: 'running', deletedAt: null }, data: { status: 'failed' },
    })
    return
  }
  console.info(`[fi-recovery] Continuing ${experimentId}: ${caseIds.length} usable Cases, ${bound.failedRunIds.length} unavailable`)
  const result = await startExperimentRun(experimentId, user, {
    allowPersistedRunning: true, caseIds, resumeIncomplete: true,
  })
  await result?.completion
}

/** Keep one continuation per experiment; failures remain recoverable on the next scan. */
export function ensureFiExperimentContinuation(experimentId: string, user: string): Promise<void> {
  const current = state()
  const existing = current.runs.get(experimentId)
  if (existing) return existing
  const pending = continueFiExperiment(experimentId, user)
    .catch((error) => { console.warn(`[fi-recovery] Continuation interrupted for ${experimentId}:`, error) })
    .finally(() => { if (current.runs.get(experimentId) === pending) current.runs.delete(experimentId) })
  current.runs.set(experimentId, pending)
  return pending
}

/** Discover persisted FI runs after crashes without waiting for their collectors to finish. */
export function resumeFiExperimentContinuations(): Promise<number> {
  const current = state()
  if (current.scan) return current.scan
  const scan = (async () => {
    const experiments = await prisma.experiment.findMany({
      where: { status: 'running', deletedAt: null, scope: '', type: 'single',
        cases: { some: { deletedAt: null, fiRunId: { not: null } } } },
      select: { id: true, user: true, configSnapshotJson: true },
    })
    let resumed = 0
    for (const experiment of experiments) {
      if (!experiment.user || !isFiSnapshot(experiment.configSnapshotJson) || current.runs.has(experiment.id)) continue
      void ensureFiExperimentContinuation(experiment.id, experiment.user)
      resumed++
    }
    return resumed
  })().finally(() => { if (current.scan === scan) current.scan = undefined })
  current.scan = scan
  return scan
}

/** Run startup recovery plus a single periodic scan, including when dev modules reload. */
export function startFiExperimentRecovery(): void {
  const current = state()
  if (current.timer) return
  const scan = () => { void resumeFiExperimentContinuations().catch((error) => {
    console.warn('[fi-recovery] Recovery scan failed:', error)
  }) }
  current.timer = setInterval(scan, 30_000)
  current.timer.unref()
  scan()
}
