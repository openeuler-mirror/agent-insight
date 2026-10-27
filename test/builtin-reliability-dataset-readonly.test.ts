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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  BUILTIN_RELIABILITY_DATASET_NAME,
  isBuiltinReliabilityDataset,
} from '@/lib/agent-dataset-builtin'

describe('内置可靠性数据集只读契约', () => {
  it('支持按固定名称或内置标签识别', () => {
    assert.equal(isBuiltinReliabilityDataset({ name: BUILTIN_RELIABILITY_DATASET_NAME }), true)
    assert.equal(isBuiltinReliabilityDataset({ tags: ['内置', 'reliability'] }), true)
    assert.equal(isBuiltinReliabilityDataset({ tags: ['reliability'] }), false)
  })

  it('页面禁用编辑入口，公开 PATCH 执行服务端保护', () => {
    const itemsPage = readFileSync('src/components/DatasetItemsPage.tsx', 'utf8')
    const datasetCenter = readFileSync('src/components/AgentDatasetCenter.tsx', 'utf8')
    const datasetRoute = readFileSync('src/app/api/agent-datasets/route.ts', 'utf8')
    const backflowRoute = readFileSync('src/app/api/agent-datasets/backflow/route.ts', 'utf8')
    const backflowDialog = readFileSync('src/components/observe/TraceBackflowDialog.tsx', 'utf8')

    assert.match(itemsPage, /disabled=\{saving \|\| isReadOnly\}/)
    assert.match(itemsPage, /disabled=\{isReadOnly\}/)
    assert.match(datasetCenter, /disabled=\{deletingId === item\.id \|\| item\.generationStatus === 'generating' \|\| isBuiltinReliabilityDataset\(item\) \|\| item\.readOnly \|\| item\.datasetKind === 'benchmark'\}/)
    assert.match(datasetRoute, /if \(isBuiltinReliabilityDataset\(current\)\)/)
    assert.match(datasetRoute, /status: 403/)
    assert.match(backflowRoute, /if \(isBuiltinReliabilityDataset\(current\)\)/)
    assert.match(backflowDialog, /filter\(item => !isBuiltinReliabilityDataset\(item\)\)/)
  })
})
