import type {
  BenchmarkManifest,
} from '../../../packages/benchmark-protocol/src/contracts'
import type { BenchmarkAdapter } from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { generatedBenchmarkAdapters } from '../../../.generated/benchmark-catalog/platform'

const registry = new Map<string, BenchmarkAdapter>()

export function registerBenchmarkAdapter(adapter: BenchmarkAdapter): void {
  const key = adapter.manifest.adapterKey.trim()
  if (!key) {
    throw new BenchmarkProtocolError('ADAPTER_KEY_INVALID', 'Adapter key 不能为空')
  }
  if (registry.has(key)) {
    throw new BenchmarkProtocolError('ADAPTER_KEY_DUPLICATE', `Adapter key 重复：${key}`)
  }
  registry.set(key, adapter)
}

export function getBenchmarkAdapter(adapterKey: string): BenchmarkAdapter {
  const adapter = registry.get(adapterKey)
  if (!adapter) {
    throw new BenchmarkProtocolError('ADAPTER_NOT_FOUND', `未注册 Benchmark Adapter：${adapterKey}`, 404)
  }
  return adapter
}

export function listBenchmarkAdapters(): readonly BenchmarkManifest[] {
  return [...registry.values()].map((adapter) => adapter.manifest)
}

for (const adapter of generatedBenchmarkAdapters) registerBenchmarkAdapter(adapter)
