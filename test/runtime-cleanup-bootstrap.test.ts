import assert from 'node:assert/strict'
import test from 'node:test'
import { startRuntimeCleanup } from '../src/lib/runtime-cleanup'

const key = Symbol.for('@agent-insight/runtime-cleanup')

test('startup registers one unref timer without starting cleanup work', async t => {
  const globalState = globalThis as unknown as Record<symbol, unknown>
  delete globalState[key]
  let calls = 0
  let delay = 0
  let unref = 0
  t.mock.method(globalThis, 'setTimeout', (_fn: () => void, wait: number) => {
    calls++; delay = wait
    return { unref: () => { unref++ } }
  })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  t.mock.method(console, 'info', () => assert.fail('startup must not run a sweep'))
  const previous = process.env.AGENT_INSIGHT_CLEANUP_ENABLED
  delete process.env.AGENT_INSIGHT_CLEANUP_ENABLED
  const first = startRuntimeCleanup()
  assert.equal(startRuntimeCleanup(), first)
  assert.equal(calls, 1)
  assert.equal(delay, 60_000)
  assert.equal(unref, 1)
  await first?.stop()
  delete globalState[key]
  if (previous === undefined) delete process.env.AGENT_INSIGHT_CLEANUP_ENABLED
  else process.env.AGENT_INSIGHT_CLEANUP_ENABLED = previous
})

test('disabled cleanup registers no timer', async t => {
  const globalState = globalThis as unknown as Record<symbol, unknown>
  delete globalState[key]
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('disabled cleanup must not schedule'))
  const previous = process.env.AGENT_INSIGHT_CLEANUP_ENABLED
  process.env.AGENT_INSIGHT_CLEANUP_ENABLED = '0'
  const controller = startRuntimeCleanup()
  await controller?.stop()
  delete globalState[key]
  if (previous === undefined) delete process.env.AGENT_INSIGHT_CLEANUP_ENABLED
  else process.env.AGENT_INSIGHT_CLEANUP_ENABLED = previous
})

test('timer registration failure cannot throw into application startup', t => {
  const globalState = globalThis as unknown as Record<symbol, unknown>
  delete globalState[key]
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('timer unavailable') })
  t.mock.method(console, 'warn', () => {})
  assert.doesNotThrow(() => startRuntimeCleanup())
  delete globalState[key]
})
