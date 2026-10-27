import { generatedBenchmarkDatasetPreparers } from '../../../generated/benchmark-catalog/dataset-preparers'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { findInstalledSystemBenchmarkDataset, installBenchmarkDataset } from './dataset-admin-service'

export async function ensureBenchmarkDataset(benchmarkKey: string, options: { refresh?: boolean; name?: string } = {}) {
  const entry = generatedBenchmarkDatasetPreparers.find(item => item.adapterKey === benchmarkKey)
  if (!entry) throw new BenchmarkProtocolError('DATASET_PREPARER_NOT_FOUND', `Benchmark ${benchmarkKey} 未注册数据准备器`, 400)
  const profileKey = entry.preparer.profileKey
  if (!options.refresh) {
    const installed = await findInstalledSystemBenchmarkDataset({ benchmarkKey, profileKey })
    if (installed) return { action: 'already-installed' as const, id: installed.id, caseCount: installed.caseCount }
  }
  const source = await entry.preparer.prepareSource()
  const imported = await installBenchmarkDataset({ benchmarkKey, profileKey, sourcePath: source.sourcePath, name: options.name || source.name })
  return { action: 'imported' as const, id: imported.id, caseCount: imported.caseCount }
}
