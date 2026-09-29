import type { Prisma } from '@prisma/client'
import { fingerprintJson, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { defaultEvaluatorTargetResolver } from './evaluator-target'

type PreparationWindow = {
  benchmarkKey: string
  evaluatorKey: string
  experimentId: string
  revision: number
  cases: JsonValue[]
  caseIds?: string[]
}

const activeWindows = new Map<string, { input: PreparationWindow; baseUrl: string; expiresAt: number }>()
let lastRevision = 0
export function nextImagePreparationRevision(): number {
  lastRevision = Math.max(Date.now(), lastRevision + 1)
  return lastRevision
}

export async function sendImagePreparationWindow(input: PreparationWindow, fetcher: typeof fetch = fetch, baseUrl?: string): Promise<void> {
  const key = JSON.stringify([input.benchmarkKey, input.experimentId])
  if (!input.cases.length && !activeWindows.has(key) && !baseUrl) return
  const targetUrl = baseUrl || (!input.cases.length ? activeWindows.get(key)?.baseUrl : undefined)
    || defaultEvaluatorTargetResolver.resolve(input.evaluatorKey).baseUrl
  if (input.cases.length && (activeWindows.get(key)?.input.revision ?? -1) < input.revision) {
    activeWindows.set(key, { input, baseUrl: targetUrl, expiresAt: Date.now() + 30 * 60_000 })
  }
  const payload = { operation: 'prepare-images', ...input }
  const digest = fingerprintJson(payload as unknown as JsonValue)
  const response = await fetcher(`${targetUrl}/api/v1/evaluations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-insight-request-digest': digest,
    },
    body: JSON.stringify({ ...payload, requestDigest: digest }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`镜像准备窗口下发失败 (${response.status})`)
  if (!input.cases.length && (activeWindows.get(key)?.input.revision ?? -1) <= input.revision) activeWindows.delete(key)
}

export async function retireImagePreparationWindows(isActive: (experimentId: string) => Promise<boolean>, fetcher: typeof fetch = fetch): Promise<void> {
  await Promise.all([...activeWindows.entries()].map(async ([key, window]) => {
    if (window.expiresAt <= Date.now()) { if (activeWindows.get(key) === window) activeWindows.delete(key); return }
    if (await isActive(window.input.experimentId)) return
    await sendImagePreparationWindow({ ...window.input, revision: nextImagePreparationRevision(), cases: [] }, fetcher, window.baseUrl)
  }))
}

let refreshing: Promise<void> | null = null
let refreshAgain = false

export function refreshBenchmarkImagePreparation(): Promise<void> {
  if (refreshing) { refreshAgain = true; return refreshing }
  refreshing = (async () => {
    do {
      refreshAgain = false
      await refreshWindows()
    } while (refreshAgain)
  })().finally(() => { refreshing = null })
  return refreshing
}

async function refreshWindows(): Promise<void> {
  const { prisma } = await import('@/lib/storage/prisma')
  const { getBenchmarkAdapter, listBenchmarkAdapters } = await import('./adapter-registry')
  const runs: Prisma.BenchmarkCaseRunGetPayload<{ include: { datasetCase: true; experiment: true } }>[] = await prisma.benchmarkCaseRun.findMany({
    where: { status: { in: ['submitted', 'running_agent', 'collecting', 'uploading', 'cleaning', 'preparing', 'dispatching', 'dispatch_unknown', 'pending'] },
      experiment: { status: 'running', deletedAt: null }, experimentCase: { deletedAt: null },
      evaluations: { none: { status: { in: ['running_evaluator', 'normalizing'] } } } },
    include: { datasetCase: true, experiment: true }, orderBy: [{ createdAt: 'asc' }, { ordinal: 'asc' }],
  })
  const targets = new Map<string, typeof runs>()
  for (const run of runs) {
    const adapter = getBenchmarkAdapter(run.adapterKey)
    if (!adapter.imagePreparationInput || !run.datasetCase) continue
    let url: string
    try { url = defaultEvaluatorTargetResolver.resolve(adapter.manifest.evaluation.evaluatorKey).baseUrl }
    catch { continue }
    targets.set(url, [...(targets.get(url) || []), run])
  }
  for (const adapter of listBenchmarkAdapters()) {
    try {
      const url = defaultEvaluatorTargetResolver.resolve(adapter.evaluation.evaluatorKey).baseUrl
      if (!targets.has(url)) targets.set(url, [])
    } catch { continue }
  }
  for (const window of activeWindows.values()) if (!targets.has(window.baseUrl)) targets.set(window.baseUrl, [])
  for (const [baseUrl, candidates] of targets) {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!health.ok) continue
    const report = await health.json()
    if (report.imagePool?.prefetch !== true) continue
    const capacity = Number.isSafeInteger(report.maxConcurrency) && report.maxConcurrency > 0 ? report.maxConcurrency : 1
    const groups = new Map<string, PreparationWindow>()
    let remaining = capacity + 1
    let futureSelected = false
    for (const statuses of [['submitted'], ['running_agent', 'collecting', 'uploading', 'cleaning', 'preparing', 'dispatching', 'dispatch_unknown'], ['pending']]) {
      const users = new Map<string, typeof runs>()
      for (const run of candidates.filter((item) => statuses.includes(item.status))) users.set(run.experiment.user, [...(users.get(run.experiment.user) || []), run])
      while (remaining && [...users.values()].some((items) => items.length)) {
        for (const items of users.values()) {
          if (!remaining) break
          const run = items.shift()
          if (!run || run.status === 'pending' && futureSelected) continue
          const adapter = getBenchmarkAdapter(run.adapterKey)
          const split = adapter.validateAndSplitCase(JSON.parse(run.datasetCase!.rawCaseJson))
          const value = adapter.imagePreparationInput!(split.publicPayload, split.privatePayload)
          if (!value) continue
          const key = `${run.adapterKey}:${run.experimentId}`
          const group = groups.get(key) || { benchmarkKey: run.adapterKey, evaluatorKey: adapter.manifest.evaluation.evaluatorKey,
            experimentId: run.experimentId, revision: nextImagePreparationRevision(), cases: [], caseIds: [] }
          group.cases.push(value)
          group.caseIds!.push(run.id)
          groups.set(key, group)
          remaining--
          if (run.status === 'pending') futureSelected = true
        }
      }
    }
    const payload = { operation: 'prepare-images', revision: nextImagePreparationRevision(), windows: [...groups.values()] }
    const digest = fingerprintJson(payload as unknown as JsonValue)
    const response = await fetch(`${baseUrl}/api/v1/evaluations`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json',
        'x-agent-insight-request-digest': digest },
      body: JSON.stringify({ ...payload, requestDigest: digest }), signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`镜像准备窗口下发失败 (${response.status})`)
    for (const [key, window] of activeWindows) if (window.baseUrl === baseUrl) activeWindows.delete(key)
    for (const window of groups.values()) activeWindows.set(JSON.stringify([window.benchmarkKey, window.experimentId]),
      { input: window, baseUrl, expiresAt: Date.now() + 30 * 60_000 })
  }
}
