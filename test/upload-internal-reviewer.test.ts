import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('completed reviewer uploads retain automatic secondary analysis', async () => {
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
  const previousDelay = process.env.UPLOAD_ASYNC_DEBOUNCE_MS
  process.env.UPLOAD_ASYNC_DEBOUNCE_MS = '98765'
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: ReturnType<typeof setTimeout>[] = []
  // 捕获正式分析调度并取消定时器，避免回归测试实际调用模型。
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const handle = originalSetTimeout(handler, delay, ...args)
    if (delay === 98765) scheduled.push(handle)
    return handle
  }) as typeof setTimeout
  try {
    const response = await POST(new Request('http://localhost/api/ingest/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'reviewer-regression', task_id: taskId,
        framework: 'opencode', query: 'internal detector request', interactions,
        opencode_cli_completed: true, trace_completed_at: new Date().toISOString() }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.background_analysis, true)
    assert.equal(scheduled.length, 1)
    assert.equal(body.analysis_skip_reason, undefined)
    const saved = await prisma.session.findUniqueOrThrow({ where: { taskId } })
    assert.ok(saved.endTime)
    assert.ok(saved.interactions?.includes('internal verdict'))
    assert.ok(await prisma.execution.findFirst({ where: { taskId } }))
  } finally {
    globalThis.setTimeout = originalSetTimeout
    for (const handle of scheduled) clearTimeout(handle)
    if (previousDelay === undefined) delete process.env.UPLOAD_ASYNC_DEBOUNCE_MS
    else process.env.UPLOAD_ASYNC_DEBOUNCE_MS = previousDelay
    await prisma.$disconnect()
    rmSync(root, { recursive: true, force: true })
  }
})
