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
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-benchmark-admin-'))
const databasePath = path.join(testDir, 'benchmark.db')
process.env.DATABASE_URL = `file:${databasePath}`

test('admin installs one shared dataset, optionally removes the source, and safely removes datasets', async t => {
  const sqliteModule = 'node:sqlite'
  const { DatabaseSync } = await import(sqliteModule) as {
    DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void }
  }
  const database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE AgentEvalDataset (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      targetAgent TEXT NOT NULL DEFAULT '', targetSkill TEXT NOT NULL DEFAULT '', tagsJson TEXT NOT NULL DEFAULT '[]',
      fieldsJson TEXT NOT NULL DEFAULT '[]', casesJson TEXT NOT NULL DEFAULT '[]', caseCount INTEGER NOT NULL DEFAULT 0,
      generationSource TEXT, generationStatus TEXT,
      referenceCasesJson TEXT NOT NULL DEFAULT '[]', projectionReady INTEGER NOT NULL DEFAULT 0,
      datasetKind TEXT NOT NULL DEFAULT 'ideal_output', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE BenchmarkDataset (
      id TEXT PRIMARY KEY, agentEvalDatasetId TEXT NOT NULL UNIQUE, user TEXT NOT NULL, name TEXT NOT NULL,
      adapterKey TEXT NOT NULL, contentHash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      caseCount INTEGER NOT NULL DEFAULT 0, sourceJson TEXT NOT NULL DEFAULT '{}',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agentEvalDatasetId) REFERENCES AgentEvalDataset(id) ON DELETE CASCADE,
      UNIQUE (user, name)
    );
    CREATE TABLE BenchmarkDatasetCase (
      id TEXT PRIMARY KEY, datasetId TEXT NOT NULL, externalCaseId TEXT NOT NULL, rawCaseJson TEXT NOT NULL,
      publicPayloadJson TEXT NOT NULL, privatePayloadJson TEXT NOT NULL, sourceFingerprint TEXT NOT NULL,
      publicFingerprint TEXT NOT NULL, privateFingerprint TEXT NOT NULL, ordinal INTEGER NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id) ON DELETE CASCADE,
      UNIQUE (datasetId, externalCaseId), UNIQUE (datasetId, ordinal)
    );
    CREATE TABLE BenchmarkExperimentBinding (
      experimentId TEXT PRIMARY KEY, datasetId TEXT NOT NULL, datasetContentHash TEXT NOT NULL,
      adapterKey TEXT NOT NULL, selectionJson TEXT NOT NULL, runConfigJson TEXT NOT NULL,
      schedulerStatus TEXT NOT NULL DEFAULT 'idle', expectedCaseCount INTEGER NOT NULL,
      callbackOrigin TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (datasetId) REFERENCES BenchmarkDataset(id)
    );
  `)
  database.close()

  const [registry, admin, storage, ownership, prismaModule] = await Promise.all([
    import('@/lib/benchmark/adapter-registry'),
    import('@/lib/benchmark/dataset-admin-service'),
    import('@/server/agent_datasets_storage'),
    import('@/lib/benchmark/dataset-ownership'),
    import('@/lib/storage/prisma'),
  ])
  const fixtureAdapter = {
    manifest: {
      adapterKey: 'fixture-dataset',
      displayName: 'Fixture Benchmark',
      protocols: { agentTask: 'agent-task/v1', evaluation: 'benchmark-evaluation/v1' },
      requiredCapabilities: ['fixture/v1'],
      defaultTimeoutSeconds: 30,
      requiredArtifacts: [{ name: 'answer.txt', mediaType: 'text/plain', collector: 'fixture/v1', maxBytes: 1024 }],
      schemas: { case: { type: 'object' }, rawResult: { type: 'object' } },
      evaluation: {
        evaluatorKey: 'fixture-grader',
        defaultTimeoutSeconds: 30,
        defaultResources: { cpu: 1, memoryMiB: 128 },
      },
      result: { primaryMetric: { key: 'passed', aggregation: 'boolean-rate' } },
      dataset: {
        profiles: [{ key: 'default', displayName: 'Fixture Dataset', acceptedExtensions: ['.json'] }],
      },
      presentation: {
        caseTable: {
          searchPaths: ['externalCaseId', 'values.metadata.group'],
          columns: [
            { path: 'input', label: '任务', type: 'text', truncate: 120 },
            { path: 'externalCaseId', label: 'Case', type: 'code', width: 160 },
            { path: 'values.metadata.group', label: '分组', type: 'code', description: '嵌套业务字段' },
          ],
        },
      },
    },
    validateAndSplitCase(raw: unknown) {
      const value = raw as { id?: unknown; input?: unknown; group?: unknown }
      const id = String(value.id || '').trim()
      const input = String(value.input || '').trim()
      if (!id || !input) throw new Error('fixture case invalid')
      return {
        externalCaseId: id,
        publicPayload: { input },
        privatePayload: { expected: `expected:${id}` },
        catalogProjection: { input, values: { metadata: { group: String(value.group || '') } } },
        publicFingerprint: `sha256:${'a'.repeat(64)}`,
        privateFingerprint: `sha256:${'b'.repeat(64)}`,
      }
    },
  }
  registry.registerBenchmarkAdapter(fixtureAdapter as never)
  assert.equal(registry.benchmarkEvaluatorId('fixture-dataset'), 'benchmark:fixture-grader')

  const sourcePath = path.join(testDir, 'fixture.json')
  fs.writeFileSync(sourcePath, JSON.stringify([{ id: 'case-1', input: 'do work', group: 'a' }]))
  const imported = await admin.installBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
    sourcePath,
    deleteSourceAfterImport: true,
  })
  assert.equal(imported.caseCount, 1)
  assert.equal(imported.sourceDeleted, true)
  assert.equal(fs.existsSync(sourcePath), false)
  const installed = await admin.findInstalledSystemBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
  })
  assert.equal(installed?.id, imported.id)
  assert.equal(installed?.caseCount, 1)

  const dataset = await prismaModule.prisma.benchmarkDataset.findUnique({ where: { id: imported.id } })
  assert.equal(dataset?.user, ownership.SYSTEM_BENCHMARK_DATASET_OWNER)
  assert.equal(dataset?.sourceJson.includes(testDir), false)
  const publicDataset = await prismaModule.prisma.agentEvalDataset.findUnique({
    where: { id: dataset?.agentEvalDatasetId },
  })
  assert.equal(publicDataset?.casesJson.includes('expected:case-1'), false)
  assert.deepEqual(JSON.parse(publicDataset?.fieldsJson || '[]'), [
    {
      id: 'input', key: 'input', path: 'input', label: '任务', type: 'text',
      displayType: 'text', truncate: 120, system: true,
    },
    {
      id: 'externalCaseId', key: 'externalCaseId', path: 'externalCaseId', label: 'Case',
      type: 'text', displayType: 'code', width: 160, system: true,
    },
    {
      id: 'metadata_group', key: 'metadata_group', path: 'values.metadata.group', label: '分组',
      type: 'text', displayType: 'code', description: '嵌套业务字段', system: true,
    },
  ])
  assert.equal(
    JSON.parse(publicDataset?.casesJson || '[]')[0]?.values?.metadata?.group,
    'a',
  )

  await prismaModule.prisma.agentEvalDataset.create({
    data: {
      id: 'system-private-fixture',
      user: ownership.SYSTEM_BENCHMARK_DATASET_OWNER,
      name: 'Not shared',
      datasetKind: 'ideal_output',
    },
  })

  const visible = await storage.readAgentDatasetSummaries('user-a')
  assert.equal(visible.some((item) => item.id === dataset?.agentEvalDatasetId), true)
  assert.equal(visible.some((item) => item.id === 'system-private-fixture'), false)
  const visibleToSecondUser = await storage.readAgentDatasetSummaries('user-b')
  assert.equal(visibleToSecondUser.some((item) => item.id === dataset?.agentEvalDatasetId), true)
  const decorated = await import('@/lib/benchmark/public-dataset')
  const publicRows = await decorated.decoratePublicBenchmarkDatasets('user-b', visibleToSecondUser)
  assert.equal(publicRows[0]?.shared, true)
  assert.equal(publicRows[0]?.benchmark?.presentation?.caseTable.columns[2]?.label, '分组')

  fixtureAdapter.manifest.presentation.caseTable.columns[0].label = '更新后的任务列'
  const frozenBeforeRefresh = await prismaModule.prisma.agentEvalDataset.findUnique({
    where: { id: dataset?.agentEvalDatasetId },
  })
  assert.equal(JSON.parse(frozenBeforeRefresh?.fieldsJson || '[]')[0]?.label, '任务')
  await admin.refreshSystemBenchmarkDatasetPresentation(imported.id)
  const refreshed = await prismaModule.prisma.agentEvalDataset.findUnique({
    where: { id: dataset?.agentEvalDatasetId },
  })
  assert.equal(JSON.parse(refreshed?.fieldsJson || '[]')[0]?.label, '更新后的任务列')

  const duplicatePath = path.join(testDir, 'duplicate.json')
  fs.writeFileSync(duplicatePath, JSON.stringify([{ id: 'case-1', input: 'do work', group: 'a' }]))
  const duplicate = await admin.installBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
    sourcePath: duplicatePath,
  })
  assert.equal(duplicate.reused, true)
  assert.equal(duplicate.id, imported.id)
  assert.equal(fs.existsSync(duplicatePath), true)
  assert.equal(await prismaModule.prisma.benchmarkDataset.count({
    where: { user: ownership.SYSTEM_BENCHMARK_DATASET_OWNER, adapterKey: 'fixture-dataset' },
  }), 1)

  const removed = await admin.removeSystemBenchmarkDataset(imported.id)
  assert.equal(removed.action, 'deleted')

  const referencedPath = path.join(testDir, 'referenced.json')
  fs.writeFileSync(referencedPath, JSON.stringify([{ id: 'case-2', input: 'do more', group: 'b' }]))
  const referenced = await admin.installBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
    sourcePath: referencedPath,
  })
  await prismaModule.prisma.$executeRawUnsafe(
    `INSERT INTO BenchmarkExperimentBinding
      (experimentId, datasetId, datasetContentHash, adapterKey, selectionJson, runConfigJson, expectedCaseCount)
     VALUES (?, ?, ?, ?, '{}', '{}', 1)`,
    'experiment-1',
    referenced.id,
    referenced.contentHash,
    'fixture-dataset',
  )
  const archived = await admin.removeSystemBenchmarkDataset(referenced.id)
  assert.equal(archived.action, 'archived')
  const archivedDataset = await prismaModule.prisma.benchmarkDataset.findUnique({ where: { id: referenced.id } })
  assert.equal(archivedDataset?.status, 'archived')
  assert.equal(await admin.findInstalledSystemBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
  }), null)

  const invalidPath = path.join(testDir, 'invalid.json')
  fs.writeFileSync(invalidPath, JSON.stringify([]))
  await assert.rejects(() => admin.installBenchmarkDataset({
    benchmarkKey: 'fixture-dataset',
    profileKey: 'default',
    sourcePath: invalidPath,
    deleteSourceAfterImport: true,
  }))
  assert.equal(fs.existsSync(invalidPath), true)

  const officialDirectory = path.join(testDir, 'official-zsoft')
  const taskDirectory = path.join(officialDirectory, 'tasks/synthetic-case')
  fs.mkdirSync(path.join(taskDirectory, 'public'), { recursive: true })
  fs.writeFileSync(path.join(taskDirectory, 'task.json'), JSON.stringify({
    task_id: 'synthetic-case', title: 'Synthetic official task', description: 'metadata only',
    tags: ['python'], submission: { max_bytes: 128 },
  }))
  fs.writeFileSync(path.join(taskDirectory, 'public/README.md'), 'Synthetic public instructions')
  fs.writeFileSync(path.join(taskDirectory, 'verify.py'), 'Private judge; never executed')
  const configDir = path.join(testDir, 'config')
  fs.mkdirSync(configDir)
  const previousConfig = process.env.AGENT_INSIGHT_CONFIG_DIR
  process.env.AGENT_INSIGHT_CONFIG_DIR = configDir
  t.after(() => {
    if (previousConfig === undefined) delete process.env.AGENT_INSIGHT_CONFIG_DIR
    else process.env.AGENT_INSIGHT_CONFIG_DIR = previousConfig
  })
  const configureZsoft = (source: string, autoImport = true) => fs.writeFileSync(path.join(configDir, 'platform.local.yaml'), JSON.stringify({
    benchmarks: { 'zsoft-l1': { dataset: { source, autoImport } } },
  }))
  const bootstrap = () => spawnSync(process.execPath, ['scripts/benchmark/bootstrap-zsoft-dataset.cjs'], {
    env: { ...process.env, AGENT_INSIGHT_HOME: path.join(testDir, 'managed') }, encoding: 'utf8', timeout: 15_000,
  })
  configureZsoft(officialDirectory)
  const startup = bootstrap()
  assert.equal(startup.status, 0, startup.stderr)
  assert.doesNotMatch(startup.stderr, /导入失败|导入配置无效|自动准备或日志写入失败/)
  assert.match(startup.stdout, /ZSoft L1 数据集已就绪/)
  const logPath = path.join(testDir, 'managed/logs/zsoft-l1-bootstrap.log')
  assert.match(fs.readFileSync(logPath, 'utf8'), /"action": "imported"/)
  const zsoft = await admin.installBenchmarkDataset({ benchmarkKey: 'zsoft-l1', profileKey: 'l1', sourcePath: officialDirectory })
  assert.equal(zsoft.caseCount, 1)
  const zsoftRow = await prismaModule.prisma.benchmarkDataset.findUnique({ where: { id: zsoft.id }, include: { cases: true, agentEvalDataset: true } })
  const metadata = JSON.parse(zsoftRow!.sourceJson)
  assert.equal(metadata.sourceKind, 'directory')
  assert.equal(metadata.profileVersion, 'official-directory/v1')
  assert.equal(zsoftRow!.agentEvalDataset.casesJson.includes('sourceTaskDigest'), false)
  assert.equal(zsoftRow!.cases[0].publicPayloadJson.includes('sourceTaskDigest'), false)
  assert.match(JSON.parse(zsoftRow!.cases[0].privatePayloadJson).sourceTaskDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(zsoftRow!.cases[0].rawCaseJson.includes('Private judge'), false)
  assert.equal((await admin.installBenchmarkDataset({ benchmarkKey: 'zsoft-l1', profileKey: 'l1', sourcePath: officialDirectory })).id, zsoft.id)
  await assert.rejects(admin.installBenchmarkDataset({ benchmarkKey: 'zsoft-l1', profileKey: 'l1', sourcePath: duplicatePath }), /directory/)
  await assert.rejects(admin.installBenchmarkDataset({ benchmarkKey: 'zsoft-l1', profileKey: 'l1', sourcePath: officialDirectory, deleteSourceAfterImport: true }), /不支持导入后删除/)
  assert.equal(fs.existsSync(officialDirectory), true)
  await prismaModule.prisma.benchmarkDataset.update({ where: { id: zsoft.id }, data: { sourceJson: JSON.stringify({ profileKey: 'l1' }) } })
  assert.equal(await admin.findInstalledSystemBenchmarkDataset({ benchmarkKey: 'zsoft-l1', profileKey: 'l1' }), null)
  await prismaModule.prisma.benchmarkDataset.update({ where: { id: zsoft.id }, data: { sourceJson: zsoftRow!.sourceJson } })
  configureZsoft(path.join(testDir, 'does-not-exist'))
  const restarted = bootstrap()
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.doesNotMatch(restarted.stderr, /导入失败|导入配置无效|自动准备或日志写入失败/)
  assert.match(fs.readFileSync(logPath, 'utf8'), /"action": "already-installed"/)
  {
    const { ensureBenchmarkDataset } = await import('@/lib/benchmark/dataset-preparation')
    assert.deepEqual(await ensureBenchmarkDataset('zsoft-l1'), { action: 'already-installed', id: zsoft.id, caseCount: 1 })
    await assert.rejects(ensureBenchmarkDataset('zsoft-l1', { refresh: true }), /官方/)
    configureZsoft(officialDirectory, false)
    await prismaModule.prisma.$executeRawUnsafe(
      `INSERT INTO BenchmarkExperimentBinding (experimentId, datasetId, datasetContentHash, adapterKey, selectionJson, runConfigJson, expectedCaseCount)
       VALUES (?, ?, ?, ?, '{}', '{}', 1)`, 'zsoft-experiment', zsoft.id, zsoft.contentHash, 'zsoft-l1',
    )
    fs.writeFileSync(path.join(taskDirectory, 'public/README.md'), 'Updated official instructions')
    await assert.rejects(ensureBenchmarkDataset('zsoft-l1', { refresh: true, name: zsoftRow!.name }), /新的数据集名称/)
    const nextVersion = await ensureBenchmarkDataset('zsoft-l1', { refresh: true, name: 'ZSoft new version' })
    assert.notEqual(nextVersion.id, zsoft.id)
    assert.equal((await prismaModule.prisma.benchmarkDataset.findUnique({ where: { id: zsoft.id } }))?.contentHash, zsoft.contentHash)
  }

  await prismaModule.prisma.$disconnect()
  fs.rmSync(testDir, { recursive: true, force: true })
})
