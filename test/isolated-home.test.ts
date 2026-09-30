import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activateIsolatedHome, assertTemporaryHome, isolatedHomeEnv } from './helpers/isolated-home'

test('test environment pins all storage paths and drops inherited credentials', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-home-guard-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const previous = process.env.TEST_PRIVATE_API_KEY
  process.env.TEST_PRIVATE_API_KEY = 'synthetic-inherited-key'
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_PRIVATE_API_KEY
    else process.env.TEST_PRIVATE_API_KEY = previous
  })
  const env = isolatedHomeEnv(home, { AGENT_INSIGHT_HOME: '/unsafe', DATABASE_URL: 'file:/unsafe.db', AGENT_INSIGHT_API_KEY: 'test-only' })
  assert.equal(env.HOME, home)
  assert.equal(env.AGENT_INSIGHT_HOME, path.join(home, '.agent-insight'))
  assert.equal(env.DATABASE_URL, `file:${path.join(home, 'test.db')}`)
  assert.equal(env.TEST_PRIVATE_API_KEY, undefined)
  assert.equal(env.AGENT_INSIGHT_API_KEY, 'test-only')
  assert.equal(env.AGENT_INSIGHT_DATA_DIR, undefined)
})

test('installer test guard rejects real directories and symlinks escaping temporary storage', (t) => {
  const outside = path.dirname(fs.realpathSync(os.tmpdir()))
  assert.throws(() => assertTemporaryHome(outside), /temporary directory/)
  assert.throws(() => assertTemporaryHome(os.tmpdir()), /temporary directory/)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-home-symlink-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(home, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertTemporaryHome(path.join(home, 'outside', 'new-dir')), /temporary directory/)
})

test('in-process test environment restores the original paths', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-home-restore-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const previous = { home: process.env.HOME, root: process.env.AGENT_INSIGHT_HOME, database: process.env.DATABASE_URL }
  const restore = activateIsolatedHome(home)
  try {
    assert.equal(process.env.AGENT_INSIGHT_HOME, path.join(home, '.agent-insight'))
  } finally {
    restore()
  }
  assert.deepEqual({ home: process.env.HOME, root: process.env.AGENT_INSIGHT_HOME, database: process.env.DATABASE_URL }, previous)
})
