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

import { loadAgentInsightEnv } from '../../src/lib/env'

function datasetIdFrom(args: string[]): string {
  const index = args.indexOf('--dataset')
  const datasetId = index >= 0 ? String(args[index + 1] || '').trim() : ''
  if (!datasetId) {
    throw new Error('用法：npx tsx scripts/benchmark/refresh-dataset-presentation.ts --dataset <dataset-id>')
  }
  return datasetId
}

async function main(): Promise<void> {
  loadAgentInsightEnv()
  const datasetId = datasetIdFrom(process.argv.slice(2))
  const [{ refreshSystemBenchmarkDatasetPresentation }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-admin-service'),
    import('../../src/lib/storage/prisma'),
  ])
  try {
    const result = await refreshSystemBenchmarkDatasetPresentation(datasetId)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
