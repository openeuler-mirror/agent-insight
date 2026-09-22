import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { SETUP_BASH_HOME } from '../src/lib/ingest/setup/home'
import { GET as setup } from '../src/app/api/ingest/setup/route'
import { GET as autoSetup } from '../src/app/api/ingest/setup/auto/route'

test('both installers render valid Bash and share root configuration on both platforms', async () => {
  for (const [get, url] of [
    [setup, 'http://localhost/api/ingest/setup?yes=1&nokey=1&frameworks=claude,codeagent,opencode'],
    [autoSetup, 'http://localhost/api/ingest/setup/auto?apiKey=test-key&host=localhost&frameworks=claude,codeagent,opencode'],
  ] as const) {
    for (const platform of ['unix', 'windows']) {
      const response = await get(new Request(url, { headers: { 'x-platform': platform } }))
      assert.equal(response.status, 200)
      const script = await response.text()
      if (platform === 'unix') {
        const check = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
        assert.equal(check.status, 0, check.stderr)
        assert.ok(script.includes(SETUP_BASH_HOME))
        assert.ok(script.includes('AGENT_INSIGHT_CONFIG_FILE="$AGENT_INSIGHT_HOME/.env"'))
        assert.ok(script.includes('agent_insight_write_script > "$AGENT_INSIGHT_HOME/claude_otel_env.sh"'))
      } else {
        assert.match(script, /AGENT_INSIGHT_DATA_DIR is no longer supported/)
        assert.ok(script.includes('$env:AGENT_INSIGHT_HOME'))
        assert.ok(script.includes('$env:AGENT_INSIGHT_HOME = $PSScriptRoot'))
      }
    }
  }
})

test('generated shell wrappers retain the installation root in a fresh environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight wrapper space-'))
  const env = { ...process.env, AGENT_INSIGHT_HOME: root }
  delete env.AGENT_INSIGHT_DATA_DIR
  try {
    const result = spawnSync('bash', ['-c', SETUP_BASH_HOME + '\nagent_insight_write_script <<\'EOF\'\nprintf "%s" "$AGENT_INSIGHT_HOME"\nEOF'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const fresh = { ...env }
    delete fresh.AGENT_INSIGHT_HOME
    const run = spawnSync('bash', [], { input: result.stdout, env: fresh, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, root)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('standalone Qwen configuration and spool share the custom root', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { agentInsightEnvPath } from './scripts/qwencode-collector/configure.mjs';
    import { collectorBaseRoot } from './scripts/qwencode-collector/storage.mjs';
    console.log(JSON.stringify([agentInsightEnvPath, collectorBaseRoot]));
  `], { env: { ...process.env, AGENT_INSIGHT_HOME: '/tmp/insight-test-custom', AGENT_INSIGHT_DATA_DIR: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['/tmp/insight-test-custom/.env', '/tmp/insight-test-custom/otel_data/qwencode'])
})

test('shared collector transport uses the custom root without creating files', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const transport = require('./scripts/agent-trace-collectors/shared/trace-transport.cjs');
    console.log(transport.collectorStateDir('codex', 'test-key', '/tmp/mock-user'));
  `], { env: { ...process.env, AGENT_INSIGHT_HOME: '/tmp/insight-test-custom', AGENT_INSIGHT_DATA_DIR: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^\/tmp\/insight-test-custom\/otel_data\/codex\/[a-f0-9]{12}\n$/)
})

test('Hermes and LlamaIndex agree on custom, empty and expanded roots', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import os, runpy
from pathlib import Path
hermes = runpy.run_path('scripts/hermes_agent_insight_plugin.py')
llama = runpy.run_path('scripts/llamaindex_extension/src/agent_insight_llamaindex/config.py')
for value in ['', '~/insight-check', '$HOME/insight-check', '/tmp/insight-check']:
    os.environ['AGENT_INSIGHT_HOME'] = value
    expected = Path(os.path.expandvars(value or str(Path.home() / '.agent-insight'))).expanduser().resolve()
    assert hermes['_default_home']() == expected
    assert llama['_default_home']() == expected
os.environ['AGENT_INSIGHT_DATA_DIR'] = '/old'
for fn in [hermes['_default_home'], llama['_default_home']]:
    try:
        fn()
        raise AssertionError('legacy root accepted')
    except RuntimeError:
        pass
`], { env: { ...process.env, AGENT_INSIGHT_DATA_DIR: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('postinstall selects the requested database before any initialization or migration', () => {
  const source = fs.readFileSync('scripts/postinstall.js', 'utf8').split("  const standaloneDir =")[0] + '\n} catch (error) { throw error }'
  for (const selected of [undefined, '', 'file:/tmp/isolated.db']) {
    const env: NodeJS.ProcessEnv = { AGENT_INSIGHT_HOME: '/tmp/custom-root' }
    if (selected !== undefined) env.DATABASE_URL = selected
    let migrated = false
    vm.runInNewContext(source, {
      __dirname: path.resolve('scripts'), process: { env }, console: { log() {} },
      require(name: string) {
        if (name === 'fs') return { existsSync: () => true, readFileSync: () => Buffer.from('DATABASE_URL=file:/tmp/managed.db') }
        if (name === './utils.js') return { getDataRoot: () => env.AGENT_INSIGHT_HOME, ensureEnvFile() {}, ensureDataDirectory() {}, migrateDataIfNeeded() { migrated = true } }
        if (name === './agent-insight-home.cjs') return require('../scripts/agent-insight-home.cjs')
        if (name === './sync-prisma-client.js') return {}
        return require(name)
      },
    })
    assert.equal(env.DATABASE_URL, selected === undefined ? 'file:/tmp/managed.db' : selected || 'file:/tmp/custom-root/data/witty_insight.db')
    assert.equal(migrated, false)
  }
})
