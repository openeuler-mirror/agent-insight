import { fingerprintJson, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { defaultEvaluatorTargetResolver } from './evaluator-target'

type PreparationWindow = {
  benchmarkKey: string
  evaluatorKey: string
  experimentId: string
  revision: number
  cases: JsonValue[]
}

const activeWindows = new Map<string, { input: PreparationWindow; baseUrl: string; expiresAt: number }>()
let lastRevision = 0
export function nextImagePreparationRevision(): number {
  lastRevision = Math.max(Date.now(), lastRevision + 1)
  return lastRevision
}

export async function sendImagePreparationWindow(input: PreparationWindow, fetcher: typeof fetch = fetch, baseUrl?: string): Promise<void> {
  const token = process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN
  if (!token) return
  const key = JSON.stringify([input.benchmarkKey, input.experimentId])
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
      'x-agent-insight-image-pool-token': token,
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
