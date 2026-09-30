import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-benchmark-admin-'))
const databasePath = path.join(testDir, 'benchmark.db')
process.env.DATABASE_URL = `file:${databasePath}`

test('admin installs one shared dataset, optionally removes the source, and safely removes datasets', async () => {
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

  await prismaModule.prisma.$disconnect()
  fs.rmSync(testDir, { recursive: true, force: true })
})
