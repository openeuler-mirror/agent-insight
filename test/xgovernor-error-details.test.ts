import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BenchmarkFailureNotice } from '@/components/eval/BenchmarkFailureNotice'

const require = createRequire(import.meta.url)
const { XGovernorClient } = require('../services/executor/src/xgovernor/client.cjs')
const { BenchmarkExecutionRunner, ExecutionBackendRegistry, FileRunStore } = require('../services/executor/src/index.cjs')
const probeFailure = 'Pi exited without a model probe result'

async function rejected(response: Response): Promise<Error & { code: string }> {
  const client = new XGovernorClient('http://127.0.0.1:1', 'private-admin-token', async () => response)
  try { await client.request('/sessions/open', {}); assert.fail('Expected HTTP rejection') }
  catch (cause) {
    assert.equal((cause as { code: string }).code, 'XGOVERNOR_REJECTED')
    return cause as Error & { code: string }
  }
}

test('actual flat SessionWireError JSON preserves a safe Pi probe failure reason', async () => {
  const failure = await rejected(Response.json({ code: 'invalid_request', message: probeFailure }, { status: 400 }))
  assert.match(failure.message, /HTTP 400/)
  assert.match(failure.message, /Pi 在返回模型探测结果前退出/)
  assert.ok(failure.message.includes(probeFailure))
  assert.match(failure.message, /扩展路径/)
})

test('known model errors expose fixed reasons without credentials, endpoints, headers or local paths', async () => {
  const secrets = ['private-api-key', 'private-token', 'private-password', 'https://private-model.example/v1?api_key=private-query', '/root/private-agent/auth.json']
  for (const [message, expected] of [
    ['Failed to start isolated Pi model probe', '无法启动 Pi 模型探测进程'],
    ['Pi model probe timed out', 'Pi 模型探测超时'],
    ['Model authentication failed', '模型认证失败'],
    ['Model not found or unavailable', '所选模型不存在或不可用'],
    ['Model endpoint connection failed', '无法连接模型服务'],
    ['Invalid model protocol or capabilities', '模型 API 协议或能力配置不合法'],
  ]) {
    const failure = await rejected(Response.json({ error: { message: `${message}: ${secrets.join(' ')} Authorization: Bearer private-token`, details: { api_key: secrets[0], password: secrets[2] } } }, { status: 400 }))
    assert.ok(failure.message.includes(expected))
    for (const secret of [...secrets, 'private-admin-token']) assert.equal(failure.message.includes(secret), false)
    assert.equal('details' in failure, false)
    assert.equal('cause' in failure, false)
  }
})

test('unknown, malformed and oversized error bodies fall back to HTTP status without echoing raw data', async () => {
  for (const response of [
    Response.json({ code: 'private-token', message: 'Unexpected response private-api-key' }, { status: 502 }),
    new Response('<html>private-api-key</html>', { status: 502 }),
    new Response('{broken private-api-key', { status: 502 }),
    Response.json({ message: `${probeFailure}${'x'.repeat(20000)}private-api-key` }, { status: 502 }),
    new Response(null, { status: 502 }),
  ]) {
    const failure = await rejected(response)
    assert.equal(failure.message, 'xGovernor /sessions/open 返回 HTTP 502')
  }
})

test('known invalid request fields identify the field without echoing unknown names or values', async () => {
  const missing = await rejected(new Response('Failed to deserialize JSON: missing field `runtime_id`', { status: 422 }))
  assert.match(missing.message, /缺少必填字段：runtime_id/)
  const unknown = await rejected(Response.json({ message: 'unknown field `api`, expected provider: private-api-key' }, { status: 400 }))
  assert.match(unknown.message, /包含不支持的字段：api/)
  assert.equal(unknown.message.includes('private-api-key'), false)
  const privateField = await rejected(Response.json({ message: 'unknown field `private_token`' }, { status: 400 }))
  assert.equal(privateField.message.includes('private_token'), false)
})

test('failed or stalled error body streams retain the HTTP rejection and are cancelled', async () => {
  const failed = await rejected(new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-stream-error')) } }), { status: 500 }))
  assert.equal(failed.message, 'xGovernor /sessions/open 返回 HTTP 500')
  let cancelled = false
  const pending = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 500 })
  const failure = await rejected(pending)
  assert.equal(failure.message, 'xGovernor /sessions/open 返回 HTTP 500')
  assert.equal(cancelled, true)
})

test('safe xGovernor rejection survives executor completion and renders in the Case failure notice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-error-flow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const client = new XGovernorClient('http://127.0.0.1:1', 'private-admin-token', async () => {
    calls++
    return Response.json({ code: 'invalid_request', message: `${probeFailure}; token=private-api-key; /root/private-path` }, { status: 400 })
  })
  let completion: any
  const backend = {
    async prepare() { await client.request('/sessions/open', {}) },
    async runAgent() { assert.fail('Agent must not start after session rejection') },
    async collect() { assert.fail('No artifacts exist before a session opens') },
    async cancel() {}, async close() {}, async recover() {},
  }
  const store = new FileRunStore(root)
  const runner = new BenchmarkExecutionRunner({ store, executionBackends: new ExecutionBackendRegistry([['local', backend]]), callback: {
    async progress() {}, async complete(_request: unknown, value: unknown) { completion = value },
  } })
  const request = { runId: 'run_error', timeoutSeconds: 30, task: {
    context: { runId: 'run_error' }, benchmark: { key: 'swe-bench' }, workspace: { provider: 'git' },
    agentConfig: { platform: 'pi-agent', agent: 'pi-agent', timeoutSeconds: 30 }, task: { instruction: 'fix it' }, submission: { requiredArtifacts: [] },
  } }
  await store.accept(request)
  await runner.execute(request)
  assert.equal(calls, 1, 'A rejected open request must not be replayed')
  assert.equal(completion.status, 'failed')
  assert.equal(completion.error.code, 'XGOVERNOR_REJECTED')
  assert.equal((await store.state(request.runId)).completion.error.message, completion.error.message)
  const markup = renderToStaticMarkup(createElement(BenchmarkFailureNotice, completion.error))
  assert.match(markup, /执行环境请求被拒绝/)
  assert.match(markup, /HTTP 400/)
  assert.ok(markup.includes(probeFailure))
  for (const value of ['private-admin-token', 'private-api-key', '/root/private-path']) assert.equal(markup.includes(value), false)
})
