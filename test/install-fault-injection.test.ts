import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const {
  normalizeHost,
  credentialsMatch,
  shouldRestartWorker,
  packageRootChanged,
  resolvePython,
  pipInstall,
} = require('../scripts/install-fault-injection.js')

test("FI worker reuses the persisted machine client identity", () => {
  const { ensureClientIdentity } = require("../scripts/fi-worker.js")
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fi-client-id-"))
  try {
    const first = ensureClientIdentity({
      dataDir,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      hostname: "host-a",
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    })
    const second = ensureClientIdentity({
      dataDir,
      randomUUID: () => "ffffffff-ffff-ffff-ffff-ffffffffffff",
      hostname: "host-b",
    })

    assert.equal(first.clientId, "cli_12345678-1234-1234-1234-123456789abc")
    assert.deepEqual(second, first)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test("normalizeHost strips trailing slash and trims", () => {
  assert.equal(normalizeHost('http://localhost:3000/'), 'http://localhost:3000')
  assert.equal(normalizeHost('  http://127.0.0.1:3000  '), 'http://127.0.0.1:3000')
  assert.equal(normalizeHost(''), '')
})

test('credentialsMatch requires both apiKey and host', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000/' }),
    true,
  )
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_bbb', insightBaseUrl: 'http://localhost:3000' }),
    false,
  )
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_aaa', insightBaseUrl: 'http://127.0.0.1:3000' }),
    false,
  )
  assert.equal(credentialsMatch(desired, null), false)
})

test('shouldRestartWorker: missing running environ → restart', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(shouldRestartWorker(desired, null), true)
})

test('shouldRestartWorker: matching credentials → keep', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-pkg-'))
  try {
    const desired = {
      apiKey: 'wi_aaa',
      insightBaseUrl: 'http://localhost:3000',
      packageRoot: pkg,
    }
    assert.equal(
      shouldRestartWorker(
        desired,
        {
          apiKey: 'wi_aaa',
          insightBaseUrl: 'http://localhost:3000/',
          packageRoot: pkg,
        },
        pkg,
      ),
      false,
    )
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
  }
})

test('shouldRestartWorker: apiKey mismatch → restart', () => {
  const desired = { apiKey: 'wi_gmail', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    shouldRestartWorker(desired, {
      apiKey: 'wi_admin',
      insightBaseUrl: 'http://localhost:3000',
    }),
    true,
  )
})

test('shouldRestartWorker: host mismatch → restart', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    shouldRestartWorker(desired, {
      apiKey: 'wi_aaa',
      insightBaseUrl: 'http://127.0.0.1:3000',
    }),
    true,
  )
})

test('shouldRestartWorker: packageRoot change → restart', () => {
  const desired = {
    apiKey: 'wi_aaa',
    insightBaseUrl: 'http://localhost:3000',
    packageRoot: '/home/u/.agent-insight/fault-injection/python-pkg',
  }
  assert.equal(
    shouldRestartWorker(
      desired,
      {
        apiKey: 'wi_aaa',
        insightBaseUrl: 'http://localhost:3000',
        packageRoot: '/mnt/d/old/agent_fault_injection',
      },
      '/mnt/d/old/agent_fault_injection',
    ),
    true,
  )
  assert.equal(
    shouldRestartWorker(
      desired,
      {
        apiKey: 'wi_aaa',
        insightBaseUrl: 'http://localhost:3000',
        packageRoot: '',
      },
      '/mnt/d/old/agent_fault_injection',
    ),
    true,
  )
})

test('packageRootChanged compares resolved paths', () => {
  assert.equal(packageRootChanged('/a/b', '/a/b'), false)
  assert.equal(packageRootChanged('/a/b', '/a/c'), true)
  assert.equal(packageRootChanged(null, '/a'), false)
})

test('resolvePython respects AGENT_FI_PYTHON then PYTHON', () => {
  const prevFi = process.env.AGENT_FI_PYTHON
  const prevPy = process.env.PYTHON
  try {
    delete process.env.AGENT_FI_PYTHON
    delete process.env.PYTHON
    assert.equal(resolvePython(), 'python3')
    process.env.PYTHON = '/usr/bin/python3'
    assert.equal(resolvePython(), '/usr/bin/python3')
    process.env.AGENT_FI_PYTHON = '/opt/custom/python'
    assert.equal(resolvePython(), '/opt/custom/python')
  } finally {
    if (prevFi === undefined) delete process.env.AGENT_FI_PYTHON
    else process.env.AGENT_FI_PYTHON = prevFi
    if (prevPy === undefined) delete process.env.PYTHON
    else process.env.PYTHON = prevPy
  }
})

test('pip install uses the exact Python selected for the client runtime', () => {
  assert.equal(typeof pipInstall, 'function')
  const calls: Array<{ command: string; args: string[] }> = []
  const ok = pipInstall('/tmp/agent_fault_injection', {
    editable: true,
    python: '/opt/homebrew/bin/python3',
    runner: (command: string, args: string[]) => {
      calls.push({ command, args })
      return { status: 0 }
    },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [
    {
      command: '/opt/homebrew/bin/python3',
      args: ['-m', 'pip', 'install', '-e', '/tmp/agent_fault_injection'],
    },
  ])
})

test('resolveCollectorCwd never returns a missing packageRoot', () => {
  const {
    resolveCollectorCwd,
  } = require('../scripts/fi-worker.js')
  const missing = path.join(os.tmpdir(), `fi-missing-${Date.now()}`)
  const cwd = resolveCollectorCwd({ packageRoot: missing })
  assert.equal(fs.existsSync(cwd), true)
  assert.notEqual(cwd, missing)
})

test('formatSpawnError distinguishes missing cwd vs missing python', () => {
  const { formatSpawnError } = require('../scripts/fi-worker.js')
  const missing = path.join(os.tmpdir(), `fi-enoent-${Date.now()}`)
  const err = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })
  const msg = formatSpawnError(err, { python: 'python3', cwd: missing })
  assert.match(msg, /packageRoot missing/)
  const homeFi = path.join(os.homedir(), '.agent-insight', 'fault-injection')
  fs.mkdirSync(homeFi, { recursive: true })
  const msg2 = formatSpawnError(err, { python: 'python3', cwd: homeFi })
  assert.match(msg2, /python executable not found/)
})
