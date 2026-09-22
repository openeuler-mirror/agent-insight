import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activateIsolatedHome } from './isolated-home'

export function createIsolatedDatabase() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-test-db-'))
  const restore = activateIsolatedHome(home)
  const dispose = () => {
    restore()
    fs.rmSync(home, { recursive: true, force: true })
  }
  try {
    fs.closeSync(fs.openSync(path.join(home, 'test.db'), 'wx'))
    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/prisma/build/index.js'), 'db', 'push',
      '--schema', path.resolve('prisma/schema.prisma'), '--skip-generate',
    ], { env: process.env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr || 'Temporary test database initialization failed')
    return { home, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
