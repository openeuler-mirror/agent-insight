import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'

import { generatedBenchmarkDatasetLoaders } from '../../../generated/benchmark-catalog/dataset-loaders'
import type { BenchmarkDatasetLoader, JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

const registry = new Map(
  generatedBenchmarkDatasetLoaders.map((item) => [item.adapterKey, item.loader] as const),
)

const genericJsonLoader: BenchmarkDatasetLoader = {
  async *loadCases(sourcePath: string) {
    const parsed = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as unknown
    const cases = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
        ? (parsed as { cases: unknown[] }).cases
        : null
    if (!cases) {
      throw new BenchmarkProtocolError('DATASET_SOURCE_INVALID', 'JSON 数据集必须是数组或包含 cases 数组', 400)
    }
    for (const rawCase of cases) yield rawCase as JsonValue
  },
}

const genericJsonlLoader: BenchmarkDatasetLoader = {
  async *loadCases(sourcePath: string) {
    const lines = readline.createInterface({
      input: createReadStream(sourcePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let lineNumber = 0
    for await (const line of lines) {
      lineNumber += 1
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as JsonValue
      } catch {
        throw new BenchmarkProtocolError(
          'DATASET_SOURCE_INVALID',
          `JSONL 第 ${lineNumber} 行不是合法 JSON`,
          400,
        )
      }
    }
  },
}

export function getBenchmarkDatasetLoader(
  adapterKey: string,
  sourcePath: string,
): BenchmarkDatasetLoader {
  const registered = registry.get(adapterKey)
  if (registered) return registered
  const extension = path.extname(sourcePath).toLowerCase()
  if (extension === '.json') return genericJsonLoader
  if (extension === '.jsonl') return genericJsonlLoader
  throw new BenchmarkProtocolError(
    'DATASET_LOADER_NOT_FOUND',
    `Benchmark ${adapterKey} 没有可用于 ${extension || '未知格式'} 的 Dataset Loader`,
    400,
  )
}
