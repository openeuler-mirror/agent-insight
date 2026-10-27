import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'

const require = createRequire(import.meta.url)
const { failureCodes, ledgerFailureCodes, summarizeFailures } = require('../services/executor/src/mcts-failure.cjs')
const { MctsProxyCore } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/core.cjs')
const BALANCE = 'MCTS_LLM_INSUFFICIENT_BALANCE'
const TRUNCATED = 'MCTS_LLM_OUTPUT_TRUNCATED'
const cutoff = 'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.'

async function fixture(t: TestContext, maxQueuedObservations = 10_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcts-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const statePath = path.join(root, 'ledger.json')
  const events: Array<Record<string, unknown>> = []
  const core = new MctsProxyCore({ writer: { append: async (value: Record<string, unknown>) => { events.push(value) } }, statePath, maxQueuedObservations })
  const body = { runtime_id: 'fixture-runtime', lease: { client_id: 'fixture-run' } }
  await core.observeRequest({ id: 'open', path: '/api/v1/sessions/open', body, startedAt: 1 })
  async function begin(turnId: string) {
    await core.observeRequest({ id: turnId, path: '/api/v1/sessions/turns', body, startedAt: 2 })
    await core.observeResponse({ id: turnId, status: 200, body: { turn_id: turnId } })
  }
  const event = (turnId: string, value: Record<string, unknown>) => core.observeSse({ runtimeId: body.runtime_id, turnId, event: value })
  const tool = (turnId: string, activity: string, status: string, summary: unknown) => event(turnId, {
    kind: 'tool_activity', phase: 'end', activity_id: activity, name: 'write', status, summary: JSON.stringify(summary),
  })
  const ledger = async () => JSON.parse(await fs.readFile(statePath, 'utf8'))
  return { core, events, begin, event, tool, ledger, body }
}

test('MCTS diagnostics classify explicit errors, not generic 404, cancellation or arbitrary length fields', () => {
  assert.deepEqual(failureCodes({ message: '402: {"message":"Insufficient Balance"}' }), [BALANCE])
  assert.deepEqual(failureCodes({ code: 'insufficient_balance' }), [BALANCE])
  assert.deepEqual(failureCodes({ content: [{ text: cutoff }] }), [TRUNCATED])
  assert.deepEqual(failureCodes({ stopReason: 'length' }), [TRUNCATED])
  for (const value of ['404 Not Found verify.py', '402 unrelated-file-count', { length: 100 }, { message: 'cancelled' }, { stopReason: 'stop' }]) {
    assert.deepEqual(failureCodes(value), [])
  }
  const summary = summarizeFailures([BALANCE, TRUNCATED, 'Bearer secret-credential'])
  assert.match(summary, /余额或付费额度不足/)
  assert.match(summary, /token 上限/)
  assert.doesNotMatch(summary, /secret-credential|Bearer/)
})

test('failed truncated writes survive observation backpressure and are not labelled as successful turns', async t => {
  const f = await fixture(t, 0)
  await f.begin('cutoff')
  await f.tool('cutoff', 'write-1', 'failed', { content: [{ type: 'text', text: cutoff }] })
  await f.event('cutoff', { kind: 'turn_completed' })
  const ledger = await f.ledger()
  assert.deepEqual(ledgerFailureCodes(ledger.runs[0]), [TRUNCATED])
  const turn = f.events.find(event => event.kind === 'llm')!
  assert.equal(turn.status, 'error')
  assert.match(String(turn.error), /token 上限/)
  assert.deepEqual(ledger.runs[0].runtimes[0].turns[0].failureCodes, [TRUNCATED])
})

test('HTTP and SSE balance failures retain only fixed diagnostic codes, never provider credentials', async t => {
  const f = await fixture(t)
  const error = { message: '402 Insufficient Balance; Authorization: Bearer secret-credential' }
  await f.core.observeResponse({ id: 'open', status: 503, body: { error } })
  assert.deepEqual(ledgerFailureCodes((await f.ledger()).runs[0]), [BALANCE])
  await f.begin('balance')
  await f.event('balance', { kind: 'turn_failed', error })
  const ledger = await f.ledger()
  assert.deepEqual(ledgerFailureCodes(ledger.runs[0]), [BALANCE])
  assert.doesNotMatch(JSON.stringify(ledger), /secret-credential|Authorization/)
  assert.equal(f.events.find(event => event.kind === 'llm')?.status, 'error')
  assert.match(String(f.events.find(event => event.kind === 'llm')?.error), /余额/)
})

test('a later successful write resolves truncation, and successful tool output is never diagnosed as a failure', async t => {
  const f = await fixture(t)
  await f.begin('recovered')
  await f.tool('recovered', 'write-1', 'failed', { content: [{ text: cutoff }] })
  await f.tool('recovered', 'write-2', 'succeeded', { content: [{ text: 'Fixture text contains: Insufficient Balance' }] })
  await f.event('recovered', { kind: 'turn_completed' })
  assert.deepEqual(ledgerFailureCodes((await f.ledger()).runs[0]), [])
  assert.equal(f.events.find(event => event.kind === 'llm')?.status, 'success')
})

test('empty recovery turns cannot erase earlier evidence, but a substantive successful recovery can', async t => {
  const f = await fixture(t)
  await f.begin('first')
  await f.tool('first', 'write-1', 'failed', { content: [{ text: cutoff }] })
  await f.event('first', { kind: 'turn_completed' })
  await f.begin('empty')
  await f.event('empty', { kind: 'turn_completed' })
  assert.deepEqual(ledgerFailureCodes((await f.ledger()).runs[0]), [TRUNCATED])
  await f.begin('recovered')
  await f.tool('recovered', 'write-2', 'succeeded', { content: [{ text: 'file written' }] })
  await f.event('recovered', { kind: 'turn_completed' })
  assert.deepEqual(ledgerFailureCodes((await f.ledger()).runs[0]), [])
})

test('missing upstream billing evidence never fabricates a balance failure from an empty success or 404', async t => {
  const f = await fixture(t)
  await f.begin('empty')
  await f.event('empty', { kind: 'turn_completed' })
  await f.core.observeRequest({ id: 'read', path: '/api/v1/sessions/files/read', body: f.body })
  await f.core.observeResponse({ id: 'read', status: 404, body: { code: 'not_found' } })
  assert.deepEqual(ledgerFailureCodes((await f.ledger()).runs[0]), [])
})

test('recovered billing does not mask a later failure, and read-only recovery does not resolve a failed write', () => {
  assert.deepEqual(ledgerFailureCodes({ runtimes: [{ turns: [
    { failureCodes: [BALANCE], terminal: true, status: 'error' },
    { terminal: true, status: 'success', hasOutput: true },
  ] }] }), [])
  assert.deepEqual(ledgerFailureCodes({ runtimes: [{ turns: [
    { failureCodes: [TRUNCATED], terminal: true, status: 'error' },
    { terminal: true, status: 'success', hasOutput: true, tools: [{ name: 'read', status: 'succeeded' }] },
  ] }] }), [TRUNCATED])
  for (const run of [null, {}, { runtimes: {} }, { runtimes: [null, { turns: [null] }] }]) assert.deepEqual(ledgerFailureCodes(run), [])
})
