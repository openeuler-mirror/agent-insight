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
} = require('../scripts/install-fault-injection.js')
const {
  ensureManagedFiRuntime,
} = require('../scripts/lib/fi-python-runtime.js')

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

test('resolvePython uses only the configured managed runtime', () => {
  const prevFi = process.env.AGENT_FI_PYTHON
  const prevPy = process.env.PYTHON
  try {
    delete process.env.AGENT_FI_PYTHON
    process.env.PYTHON = '/usr/bin/python3'
    assert.equal(resolvePython(), '', 'generic PYTHON must not select the system environment')
    assert.equal(resolvePython({ python: '/managed/venv/bin/python' }), '/managed/venv/bin/python')
    process.env.AGENT_FI_PYTHON = '/opt/custom/python'
    assert.equal(resolvePython(), '/opt/custom/python')
  } finally {
    if (prevFi === undefined) delete process.env.AGENT_FI_PYTHON
    else process.env.AGENT_FI_PYTHON = prevFi
    if (prevPy === undefined) delete process.env.PYTHON
    else process.env.PYTHON = prevPy
  }
})

test('standalone setup delegates Python selection to the managed runtime installer', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/fault-injection/setup/route.ts'),
    'utf8',
  )
  assert.doesNotMatch(source, /command -v python3/)
  assert.doesNotMatch(source, /python3 is required/)
})

test('managed runtime never invokes pip with the bootstrap Python', () => {
  const fiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-managed-runtime-'))
  const sourceRoot = path.join(process.cwd(), 'agent_fault_injection')
  const bootstrap = '/opt/homebrew/bin/python3'
  const calls: Array<{ command: string; args: string[] }> = []
  try {
    const runner = (command: string, args: string[]) => {
      calls.push({ command, args: [...args] })
      if (args[0] === '-c') {
        return {
          status: 0,
          stdout: JSON.stringify({ executable: bootstrap, version: [3, 13, 7] }),
        }
      }
      if (command === bootstrap && args[0] === '-m' && args[1] === 'venv') {
        const python = path.join(args[2], 'bin', 'python')
        fs.mkdirSync(path.dirname(python), { recursive: true })
        fs.writeFileSync(python, '')
        return { status: 0 }
      }
      if (args[0] === '-I') {
        return {
          status: 0,
          stdout: JSON.stringify({
            prefix: path.join(fiHome, 'venv'),
            base_prefix: '/opt/homebrew',
            module: path.join(fiHome, 'site-packages', 'agent_fault_injection', '__init__.py'),
          }),
        }
      }
      return { status: 0 }
    }

    const runtime = ensureManagedFiRuntime({
      sourceRoot,
      fiHome,
      editable: false,
      env: { PYTHON: bootstrap },
      runner,
    })
    assert.match(runtime.python, /fault-injection|fi-managed-runtime/)
    assert.equal(runtime.runtimeMode, 'managed-venv')

    const pipCalls = calls.filter((call) => call.args[0] === '-m' && call.args[1] === 'pip')
    assert.equal(pipCalls.length, 1)
    assert.equal(pipCalls[0].command, runtime.python)
    assert.notEqual(pipCalls[0].command, bootstrap)
    assert.ok(pipCalls[0].args.includes('--no-input'))

    const reused = ensureManagedFiRuntime({
      sourceRoot,
      fiHome,
      editable: false,
      env: { PYTHON: bootstrap },
      runner,
    })
    assert.equal(reused.reused, true)
    assert.equal(reused.runtimeId, runtime.runtimeId)
    assert.equal(
      calls.filter((call) => call.args[0] === '-m' && call.args[1] === 'pip').length,
      1,
      'reusing a verified runtime must not invoke pip again',
    )
  } finally {
    fs.rmSync(fiHome, { recursive: true, force: true })
  }
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
