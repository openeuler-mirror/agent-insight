import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { GET as setup } from '../src/app/api/ingest/setup/route'
import { GET as autoSetup } from '../src/app/api/ingest/setup/auto/route'

import { GET } from '../src/app/api/ingest/setup/opencode/route'

test('downloaded OpenCode plugin exposes only the default plugin factory', async () => {
  const response = await GET(new Request('http://localhost/api/setup/opencode'))
  assert.equal(response.status, 200)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-artifact-'))
  const artifact = path.join(root, 'Witty-Skill-Insight.ts')
  try {
    fs.writeFileSync(artifact, await response.text(), 'utf8')
    const pluginModule = await import(`${pathToFileURL(artifact).href}?v=${Date.now()}`)
    assert.deepEqual(Object.keys(pluginModule), ['default'])
    assert.equal(typeof pluginModule.default, 'function')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode V2 download exports a native definition while default download keeps V1 compatibility', async () => {
  const response = await GET(new Request('http://localhost/api/setup/opencode?apiVersion=2'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-artifact-'))
  try {
    const artifact = path.join(root, 'plugin.ts')
    fs.writeFileSync(artifact, await response.text())
    const pluginModule = await import(`${pathToFileURL(artifact).href}?v=${Date.now()}`)
    assert.deepEqual(Object.keys(pluginModule), ['default'])
    assert.equal(pluginModule.default.id, 'agent-insight.trace')
    assert.equal(typeof pluginModule.default.setup, 'function')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test('both Unix installers select the native V2 collector and skip the V1-only TUI addon', async () => {
  for (const get of [setup, autoSetup]) {
    const script = await (await get(new Request('http://localhost/api/ingest/setup?yes=1&nokey=1&frameworks=opencode&apiKey=test&host=localhost', { headers: { 'x-platform': 'unix' } }))).text()
    const start = script.indexOf('if [ "$INSTALL_OPENCODE" = "true" ]; then', script.indexOf('# 3. Download Components'))
    const end = script.indexOf('if [ "$INSTALL_CLAUDE" = "true" ]; then', start)
    assert.ok(start >= 0 && end > start)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-installer-version-'))
    try {
      const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROBE_LOG"\n', { mode: 0o755 })
      for (const version of ['1.18.29', '2.0.32', 'opencode v2.0.32']) {
        fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 })
        const log = path.join(root, version + '.log')
        const run = spawnSync('bash', ['-c', script.slice(start, end)], { encoding: 'utf8', env: { NODE_ENV: 'test', HOME: root, PATH: bin + ':/usr/bin:/bin', INSTALL_OPENCODE: 'true', AGENT_INSIGHT_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, '.config/opencode'), AGENT_INSIGHT_BASE_URL: 'http://fixture', PROBE_LOG: log } })
        assert.equal(run.status, 0, run.stderr)
        const urls = fs.readFileSync(log, 'utf8')
        if (version.includes('2.0.32')) { assert.match(urls, /opencode\?apiVersion=2/); assert.doesNotMatch(urls, /opencode-tui/) }
        else { assert.doesNotMatch(urls, /apiVersion=2/); assert.match(urls, /opencode-tui/) }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('Unix setup skips legacy RAS only for an OpenCode V2-only selection', async () => {
  for (const get of [setup, autoSetup]) {
    const script = await (await get(new Request('http://localhost/api/ingest/setup?yes=1&nokey=1&frameworks=opencode&apiKey=test&host=localhost', { headers: { 'x-platform': 'unix' } }))).text()
    const start = script.indexOf('# 6.34 Install Agent RAS runtime')
    const end = script.indexOf('\nfi', start) + 3
    for (const [query, xiaoo, expected] of [['?apiVersion=2', 'false', false], ['', 'false', true], ['?apiVersion=2', 'true', true]] as const) {
      const run = spawnSync('bash', ['-c', 'install_agent_insight_ras() { echo RAS_CALLED; };\n' + script.slice(start, end)], { encoding: 'utf8', env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', INSTALL_OPENCODE: 'true', INSTALL_XIAOO: xiaoo, OPENCODE_PLUGIN_QUERY: query } })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(run.stdout.includes('RAS_CALLED'), expected)
    }
  }
})
