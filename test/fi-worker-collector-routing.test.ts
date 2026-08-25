import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildCollectorArgs, resolvePython } = require('../scripts/fi-worker.js')

test('resolvePython does not fall back to a system Python', () => {
  const prevFi = process.env.AGENT_FI_PYTHON
  const prevPy = process.env.PYTHON
  try {
    delete process.env.AGENT_FI_PYTHON
    process.env.PYTHON = '/usr/bin/python3'
    assert.equal(resolvePython(), '')
    assert.equal(resolvePython({ python: '/managed/venv/bin/python' }), '/managed/venv/bin/python')
  } finally {
    if (prevFi === undefined) delete process.env.AGENT_FI_PYTHON
    else process.env.AGENT_FI_PYTHON = prevFi
    if (prevPy === undefined) delete process.env.PYTHON
    else process.env.PYTHON = prevPy
  }
})

test('buildCollectorArgs always uses FI CLI (never RAS runner)', () => {
  const args = buildCollectorArgs(
    {
      platform: 'xiaoo',
      agent: 'default',
      fault: 'thinking-dead-loop',
      prompt: 'go',
      runId: 'run-1',
      model: 'm',
      submode: '2',
      timeoutSeconds: 120,
    },
    '/tmp/ws',
    '/tmp/out',
  )
  assert.equal(args[0], '-I')
  assert.equal(args[1], '-m')
  assert.equal(args[2], 'agent_fault_injection.cli')
  assert.ok(!args.some((a: unknown) => String(a).includes('fi_daemon_runner')))
  assert.ok(!args.some((a: unknown) => String(a).includes('platform_adapter.xiaoo')))
  assert.deepEqual(
    args.slice(3, 17),
    [
      'run',
      '--platform',
      'xiaoo',
      '--agent',
      'default',
      '--fault',
      'thinking-dead-loop',
      '--prompt',
      'go',
      '--workspace',
      '/tmp/ws',
      '--output-dir',
      '/tmp/out',
      '--run-id',
    ],
  )
  assert.equal(args[17], 'run-1')
  assert.ok(args.includes('--model') && args.includes('m'))
  assert.ok(args.includes('--submode') && args.includes('2'))
  assert.ok(args.includes('--timeout-seconds') && args.includes('120'))
})

test('buildCollectorArgs works for opencode the same way', () => {
  const args = buildCollectorArgs(
    {
      platform: 'opencode',
      agent: 'build',
      fault: 'tool-argument-error',
      prompt: 'x',
      runId: 'run-oc',
    },
    '/ws',
    '/out',
  )
  assert.equal(args[2], 'agent_fault_injection.cli')
  assert.equal(args[args.indexOf('--platform') + 1], 'opencode')
})
