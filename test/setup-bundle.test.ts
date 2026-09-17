import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { GET } from '@/app/api/ingest/setup/bundle/route'

const repositoryRoot = path.resolve(__dirname, '..')
const clientFiles = [
  'scripts/install-ras-client.js',
  'scripts/reliability-client.cjs',
  'scripts/ws-client.cjs',
  'scripts/install-fault-injection.js',
  'scripts/lib/fi-python-runtime.js',
  'scripts/fi-worker.js',
  'services/executor/src/index.cjs',
  'agent_ras/platform_adapter/opencode/config_sync.js',
  'agent_fault_injection/pyproject.toml',
]

function usePackageRoot(t: TestContext, root: string) {
  const previousRoot = process.env.AGENT_INSIGHT_PACKAGE_ROOT
  const previousUser = process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
  process.env.AGENT_INSIGHT_PACKAGE_ROOT = root
  process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = 'setup-bundle-test'
  t.after(() => {
    if (previousRoot === undefined) delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
    else process.env.AGENT_INSIGHT_PACKAGE_ROOT = previousRoot
    if (previousUser === undefined) delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
    else process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = previousUser
  })
}

test('standalone cwd still serves complete client and RAS archives from the package root', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-'))
  const previousCwd = process.cwd()
  const standalone = path.join(temporary, '.next', 'standalone')
  fs.mkdirSync(standalone, { recursive: true })
  usePackageRoot(t, repositoryRoot)
  process.chdir(standalone)
  t.after(() => {
    process.chdir(previousCwd)
    fs.rmSync(temporary, { recursive: true, force: true })
  })

  for (const [name, required] of [
    ['client', clientFiles],
    ['ras', [
      'scripts/install-ras.js',
      'scripts/xiaoo-trace-collector/install.js',
      'scripts/xiaoo-trace-collector/manifest.js',
      'scripts/xiaoo-trace-collector/otel_spans.py',
      'agent_ras/platform_adapter/opencode/plugin.js',
    ]],
  ] as const) {
    const response = await GET(new Request(`http://localhost/api/ingest/setup/bundle?name=${name}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const archive = Buffer.from(await response.arrayBuffer())
    const listing = spawnSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    const entries = new Set(listing.stdout.split('\n'))
    for (const file of required) {
      assert.ok(entries.has(file), `${name} bundle must contain ${file}`)
      const extracted = spawnSync('tar', ['-xzOf', '-', file], { input: archive })
      assert.equal(extracted.status, 0, extracted.stderr.toString())
      assert.deepEqual(extracted.stdout, fs.readFileSync(path.join(repositoryRoot, file)))
    }
  }
})

test('incomplete client bundle returns missing entries instead of a partial archive', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-missing-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  usePackageRoot(t, temporary)
  for (const file of clientFiles.filter((file) => !file.startsWith('services/executor/'))) {
    const target = path.join(temporary, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'fixture')
  }
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=client'))
  assert.equal(response.status, 503)
  assert.deepEqual((await response.json()).missing, ['services/executor/src'])
})

test('an existing RAS installer alone cannot produce a successful RAS bundle', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-ras-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  usePackageRoot(t, temporary)
  fs.mkdirSync(path.join(temporary, 'scripts'))
  fs.writeFileSync(path.join(temporary, 'scripts/install-ras.js'), 'fixture')
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=ras'))
  assert.equal(response.status, 503)
  assert.deepEqual(
    (await response.json()).missing,
    ['scripts/xiaoo-trace-collector', 'agent_ras'],
  )
})

test('bundle whitelist and authentication still apply with a configured package root', async (t) => {
  usePackageRoot(t, repositoryRoot)
  for (const name of ['../scripts', '__proto__', 'constructor']) {
    const response = await GET(new Request(`http://localhost/api/ingest/setup/bundle?name=${name}`))
    assert.equal(response.status, 400)
  }
  delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=client'))
  assert.equal(response.status, 401)
})
