import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-swe-bench-official-'))
const databasePath = path.join(testDir, 'benchmark.db')
const datasetPath = process.env.SWE_BENCH_DATASET_PATH
  || path.join(os.homedir(), '.agent-insight', 'data', 'imports', 'swe-bench-verified', 'test.parquet')
const pythonPath = process.env.SWE_BENCH_PYTHON
  || path.join(
    os.homedir(),
    '.agent-insight',
    'vendor',
    'SWE-bench',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
const bridgePath = path.resolve('scripts/benchmark/load_official_swebench_dataset.py')
const missingPrerequisite = [datasetPath, pythonPath, bridgePath].find((item) => !fs.existsSync(item))

process.env.DATABASE_URL = `file:${databasePath}`

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey)
  if (!value || typeof value !== 'object') return false
  const forbidden = new Set([
    'patch',
    'test_patch',
    'FAIL_TO_PASS',
    'PASS_TO_PASS',
    'environment_setup_commit',
    'image',
    'eval_script',
    'eval_type',
    'log_parser',
    'goldPatch',
    'testPatch',
    'failToPass',
    'passToPass',
    'environmentSetupCommit',
    'evaluation',
  ])
  return Object.entries(value).some(([key, item]) => forbidden.has(key) || hasForbiddenKey(item))
}

test('official SWE-bench Verified imports 500 real cases without leaking evaluator data', {
  skip: missingPrerequisite ? `missing external prerequisite: ${missingPrerequisite}` : false,
  timeout: 180_000,
}, async () => {
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

  const [{ importOfficialSweBenchVerifiedDataset }, { sweBenchAdapter }, { prisma }] = await Promise.all([
    import('../benchmarks/swe-bench/dataset'),
    import('../benchmarks/swe-bench/adapter'),
    import('@/lib/storage/prisma'),
  ])

  try {
    const imported = await importOfficialSweBenchVerifiedDataset({
      user: 'official-swe-bench-test',
      name: 'official SWE-bench Verified',
      datasetPath,
      pythonPath,
    })
    assert.equal(imported.caseCount, 500)
    assert.equal(imported.reused, false)

    const dataset = await prisma.benchmarkDataset.findUnique({
      where: { id: imported.id },
      include: { cases: { orderBy: { ordinal: 'asc' } } },
    })
    assert.ok(dataset)
    assert.equal(dataset.adapterKey, 'swe-bench')
    assert.equal(dataset.cases.length, 500)
    assert.equal(new Set(dataset.cases.map((item: { externalCaseId: string }) => item.externalCaseId)).size, 500)
    assert.equal(JSON.parse(dataset.sourceJson).loader, 'swebench.harness.utils.load_swebench_dataset')

    for (const [index, item] of dataset.cases.entries()) {
      const publicPayload = JSON.parse(item.publicPayloadJson)
      const privatePayload = JSON.parse(item.privatePayloadJson)
      assert.equal(hasForbiddenKey(publicPayload), false, `public Case leaked at ${item.externalCaseId}`)
      assert.equal(typeof privatePayload.goldPatch, 'string')
      assert.equal(typeof privatePayload.evaluation.image, 'string')
      assert.equal(typeof privatePayload.evaluation.script, 'string')

      const task = sweBenchAdapter.buildAgentTask({
        publicPayload,
        runConfig: { platform: 'opencode', agent: 'build', timeoutSeconds: 1800 },
        context: {
          runId: `real_run_${index}`,
          experimentId: 'real_experiment',
          caseId: item.id,
        },
      })
      assert.equal(hasForbiddenKey(task), false, `task leaked at ${item.externalCaseId}`)
      assert.equal(task.workspace.revision, publicPayload.baseCommit)
      assert.equal(task.workspace.repository, `https://github.com/${publicPayload.repo}.git`)
    }
  } finally {
    await prisma.$disconnect()
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})
