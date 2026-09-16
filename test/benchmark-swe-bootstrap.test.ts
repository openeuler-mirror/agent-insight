import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('SWE-bench bootstrap skips every local prerequisite after the dataset is installed', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-swe-bootstrap-'))
  const databasePath = path.join(testDir, 'benchmark.db')
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AGENT_INSIGHT_DATA_DIR = path.join(testDir, 'missing-managed-home')

  const sqliteModule = 'node:sqlite'
  const { DatabaseSync } = await import(sqliteModule) as {
    DatabaseSync: new (filename: string) => {
      exec(sql: string): void
      close(): void
    }
  }
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE BenchmarkDataset (
      id TEXT PRIMARY KEY,
      agentEvalDatasetId TEXT NOT NULL UNIQUE,
      user TEXT NOT NULL,
      name TEXT NOT NULL,
      adapterKey TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      caseCount INTEGER NOT NULL DEFAULT 0,
      sourceJson TEXT NOT NULL DEFAULT '{}',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user, name)
    );
    INSERT INTO BenchmarkDataset (
      id, agentEvalDatasetId, user, name, adapterKey, contentHash, status, caseCount, sourceJson
    ) VALUES (
      'benchmark-ready',
      'public-ready',
      '__agent_insight_system__',
      'SWE-bench Verified',
      'swe-bench',
      'sha256:ready',
      'ready',
      500,
      '{"profileKey":"verified"}'
    );
  `)
  database.close()

  try {
    const { ensureSweBenchDataset } = await import('../scripts/benchmark/ensure-swe-bench-dataset')
    const result = await ensureSweBenchDataset()
    assert.deepEqual(result, {
      action: 'already-installed',
      id: 'benchmark-ready',
      caseCount: 500,
    })
    assert.equal(fs.existsSync(process.env.AGENT_INSIGHT_DATA_DIR), false)
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})
