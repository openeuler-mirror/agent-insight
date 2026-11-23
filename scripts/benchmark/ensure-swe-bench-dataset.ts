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

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAgentInsightEnv } from '../../src/lib/env'
export * from '../../benchmarks/swe-bench/dataset/prepare'

export async function ensureSweBenchDataset() {
  const [{ ensureBenchmarkDataset }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-preparation'), import('../../src/lib/storage/prisma'),
  ])
  try { return await ensureBenchmarkDataset('swe-bench') }
  finally { await prisma.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadAgentInsightEnv()
  void ensureSweBenchDataset().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
