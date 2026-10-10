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
    assert.match(datasetCenter, /disabled=\{isBuiltinReliabilityDataset\(item\)\}/)
    assert.match(datasetRoute, /if \(isBuiltinReliabilityDataset\(current\)\)/)
    assert.match(datasetRoute, /status: 403/)
    assert.match(backflowRoute, /if \(isBuiltinReliabilityDataset\(current\)\)/)
    assert.match(backflowDialog, /filter\(item => !isBuiltinReliabilityDataset\(item\)\)/)
  })
})
