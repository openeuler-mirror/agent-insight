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

import type {
  BenchmarkManifest,
} from '../../../packages/benchmark-protocol/src/contracts'
import type { BenchmarkAdapter } from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { generatedBenchmarkAdapters } from '../../../generated/benchmark-catalog/adapters'

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

export function benchmarkEvaluatorId(adapterKey: string): string {
  return `benchmark:${getBenchmarkAdapter(adapterKey).manifest.evaluation.evaluatorKey}`
}

export function listBenchmarkAdapters(): readonly BenchmarkManifest[] {
  return [...registry.values()].map((adapter) => adapter.manifest)
}

for (const adapter of generatedBenchmarkAdapters) registerBenchmarkAdapter(adapter)
