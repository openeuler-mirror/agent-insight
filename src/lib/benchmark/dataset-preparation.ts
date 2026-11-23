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
