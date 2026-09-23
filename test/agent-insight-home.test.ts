import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { getAgentInsightHome, loadAgentInsightEnv } from '../src/lib/env'
import { getExistingInsightDir } from '../src/lib/agent-insight-paths'

const homeTools = require('../scripts/agent-insight-home.cjs')
const { getDataRoot } = require('../scripts/utils.js')
const { resolveStartupDatabaseUrl } = require('../scripts/start.js')

test('home resolver rejects legacy values, including when the new variable is present', () => {
  for (const root of [undefined, '/data/agent-insight', '/srv/custom']) {
    assert.throws(() => homeTools.getAgentInsightHome({
      AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_DATA_DIR: '/srv/legacy',
    }), /AGENT_INSIGHT_DATA_DIR is no longer supported/)
  }
  assert.equal(homeTools.getAgentInsightHome({ AGENT_INSIGHT_DATA_DIR: '' }), path.join(os.homedir(), '.agent-insight'))
})

test('server, JS tools and Trace paths resolve the same custom home', () => {
  const previous = { ...process.env }
  try {
    delete process.env.AGENT_INSIGHT_DATA_DIR
    for (const value of ['~/home-check', '$HOME/home-check', '${HOME}/home-check']) {
      process.env.AGENT_INSIGHT_HOME = value
      const expected = path.join(os.homedir(), 'home-check')
      assert.equal(getAgentInsightHome(), expected)
      assert.equal(getDataRoot(), expected)
      assert.equal(getExistingInsightDir(), expected)
    }
  } finally {
    process.env = previous
  }
})

test('npm database selection respects process, file and default precedence', () => {
  const root = '/tmp/insight-test-root'
  const file = { DATABASE_URL: 'file:/tmp/file-config.db' }
  assert.equal(resolveStartupDatabaseUrl(file, { DATABASE_URL: 'file:/tmp/process.db' }, root), 'file:/tmp/process.db')
  assert.equal(resolveStartupDatabaseUrl(file, {}, root), file.DATABASE_URL)
  assert.equal(resolveStartupDatabaseUrl(file, { DATABASE_URL: '' }, root), `file:${root}/data/witty_insight.db`)
  assert.equal(resolveStartupDatabaseUrl({}, {}, root), `file:${root}/data/witty_insight.db`)
  assert.throws(() => resolveStartupDatabaseUrl({ AGENT_INSIGHT_DATA_DIR: '/old' }, {}, root), /no longer supported/)
})

test('Node env loader rejects a legacy .env even when the process value is empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-node-env-'))
  const previous = { ...process.env }
  try {
    fs.writeFileSync(path.join(root, '.env'), 'AGENT_INSIGHT_DATA_DIR=/old-root\n')
    process.env.AGENT_INSIGHT_HOME = root
    process.env.AGENT_INSIGHT_DATA_DIR = ''
    assert.throws(() => loadAgentInsightEnv(), /AGENT_INSIGHT_DATA_DIR is no longer supported/)
  } finally {
    process.env = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const [shell, script] of [
  ['bash', 'scripts/start.sh'],
  ['bash', 'scripts/develop_start.sh'],
  ['sh', 'scripts/docker-entrypoint.sh'],
]) {
  test(`${script} rejects legacy process and .env values before starting services`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-home-reject-'))
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_SOURCE_DIR: '' }
    try {
      const direct = spawnSync(shell, [script], {
        env: { ...env, AGENT_INSIGHT_DATA_DIR: '/old-root' }, encoding: 'utf8', timeout: 5000,
      })
      assert.equal(direct.status, 1)
      assert.match(direct.stderr, /AGENT_INSIGHT_DATA_DIR is no longer supported/)
      assert.deepEqual(fs.readdirSync(root), [])
      fs.writeFileSync(path.join(root, '.env'), 'AGENT_INSIGHT_DATA_DIR=/old-root\n')
      delete env.AGENT_INSIGHT_DATA_DIR
      const fromFile = spawnSync(shell, [script], { env, encoding: 'utf8', timeout: 5000 })
      assert.equal(fromFile.status, 1)
      assert.match(fromFile.stderr, /AGENT_INSIGHT_DATA_DIR is no longer supported/)
      assert.doesNotMatch(fromFile.stdout, /Syncing database schema|prisma|Starting server/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('shell root expansion matches Node without running startup side effects', () => {
  for (const script of ['scripts/start.sh', 'scripts/develop_start.sh', 'scripts/docker-entrypoint.sh']) {
    const source = fs.readFileSync(script, 'utf8')
    const prefix = source.slice(0, source.indexOf('RESOLVED_AGENT_INSIGHT_HOME='))
    for (const value of ['~/home-check', '$HOME/home-check', '${HOME}/home-check']) {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: value }
      delete env.AGENT_INSIGHT_DATA_DIR
      const result = spawnSync('bash', ['-c', `${prefix}\nprintf '%s' "$AGENT_INSIGHT_HOME"`, script], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, path.join(os.homedir(), 'home-check'))
    }
  }
})

test('client installation bundle contains the shared path module', () => {
  const bundle = fs.readFileSync('src/app/api/ingest/setup/bundle/route.ts', 'utf8')
  assert.equal((bundle.match(/'scripts\/agent-insight-home.cjs'/g) || []).length, 2)
  const installer = fs.readFileSync('scripts/install-ras-client.js', 'utf8')
  assert.match(installer, /RUNTIME_FILES = .*'agent-insight-home.cjs'/)
  assert.match(installer, /Environment=\$\{quoteSystemdValue\(`AGENT_INSIGHT_HOME=/)
  assert.match(installer, /<key>AGENT_INSIGHT_HOME<\/key>/)
})
