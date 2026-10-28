import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('completed reviewer uploads persist evidence without scheduling automatic analysis', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'reviewer-upload-'))
  process.env.AGENT_INSIGHT_HOME = root
  process.env.DATABASE_URL = 'file:' + path.join(root, 'test.db')
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' })
  const { prisma } = await import('@/lib/storage/prisma')
  const { POST } = await import('@/app/api/ingest/upload/route')
  const taskId = 'ses_internal_reviewer_regression'
  const interactions = [
    { role: 'user', agent: 'ras-judge', content: 'internal detector request' },
    { role: 'assistant', agent: 'ras-judge', content: 'internal verdict' },
  ]
  try {
    const response = await POST(new Request('http://localhost/api/ingest/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'reviewer-regression', task_id: taskId,
        framework: 'opencode', query: 'internal detector request', interactions,
        opencode_cli_completed: true, trace_completed_at: new Date().toISOString() }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.background_analysis, false)
    assert.equal(body.analysis_skip_reason, 'internal_ras_reviewer')
    const saved = await prisma.session.findUniqueOrThrow({ where: { taskId } })
    assert.ok(saved.endTime)
    assert.ok(saved.interactions?.includes('internal verdict'))
    assert.ok(await prisma.execution.findFirst({ where: { taskId } }))
  } finally {
    await prisma.$disconnect()
    rmSync(root, { recursive: true, force: true })
  }
})
