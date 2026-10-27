/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BenchmarkFailureNotice } from '@/components/eval/BenchmarkFailureNotice'

const require = createRequire(import.meta.url)
const { XGovernorClient } = require('../services/executor/src/xgovernor/client.cjs')
const { BenchmarkExecutionRunner, ExecutionBackendRegistry, FileRunStore, atomicWriteJson } = require('../services/executor/src/index.cjs')
const { XGovernorExecutionBackend } = require('../services/executor/src/xgovernor/backend.cjs')
const probeFailure = 'Pi exited without a model probe result'

function commandBackend(t: TestContext, result: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-command-error-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const backend = new XGovernorExecutionBackend({ config: { profiles: {} }, baseDir: root, atomicWriteJson,
    async fetchImpl() { return Response.json(result) },
  })
  const directory = path.join(root, 'xgovernor-runs', 'run_error')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'admin.auth'), 'private-admin-token')
  const handle = { backendKey: 'xgovernor', runId: 'run_error', opaque: { directory, runtimeId: 'runtime-error', adminPort: 1, workspaceRoot: '/testbed' } }
  return { root, backend, handle, directory }
}

test('nonzero sandbox commands persist fixed diagnostics and never expose raw output or command arguments', async t => {
  const secrets = 'https://private-host.example/key?api_key=private-api-key /root/private-path Authorization: Bearer private-token'
  for (const [stderr, expected] of [
    ['fatal: detected dubious ownership in repository', 'GIT_OWNERSHIP'],
    ['fatal: not a git repository', 'GIT_REPOSITORY_MISSING'],
    ['error: Permission denied', 'WORKSPACE_PERMISSION'],
    ['No space left on device', 'DISK_FULL'],
    ["fatal: Unable to create 'index.lock': File exists", 'GIT_INDEX_LOCKED'],
    ['fatal: bad object', 'GIT_REVISION_MISSING'],
    ['Unexpected error', 'COMMAND_FAILED'],
  ]) {
    const f = commandBackend(t, { exit_code: 128, stderr: `${stderr} ${secrets}`, stdout: secrets, timed_out: false })
    let failure: any
    await assert.rejects(f.backend.exec(f.handle, ['git', 'private-command-argument'], undefined, undefined, 'workspace-head'), (cause: any) => { failure = cause; return cause.code === 'SANDBOX_COMMAND_FAILED' })
    assert.equal(failure.runFacts.sandboxDiagnostic.reason, expected)
    assert.match(failure.message, /工作区准备失败.*读取镜像初始 Git HEAD.*退出码 128/)
    const persisted = fs.readFileSync(path.join(f.directory, 'diagnostic.json'), 'utf8')
    assert.equal(JSON.parse(persisted).reason, expected)
    const markup = renderToStaticMarkup(createElement(BenchmarkFailureNotice, { code: failure.code, message: failure.message }))
    for (const secret of ['private-host', 'private-api-key', 'private-path', 'private-token', 'private-admin-token', 'private-command-argument']) {
      assert.equal(`${persisted}${markup}${JSON.stringify(failure)}`.includes(secret), false)
    }
  }
})

test('command timeout and oversized or unknown stderr only expose bounded fixed reasons', async t => {
  const f = commandBackend(t, { exit_code: 0, timed_out: true, stderr: 'private-secret' })
  await assert.rejects(f.backend.exec(f.handle, ['git'], undefined, undefined, 'patch-diff'), (cause: any) => cause.runFacts.sandboxDiagnostic.reason === 'COMMAND_TIMEOUT' && /提交物收集失败.*超时/.test(cause.message))
  const { commandFailure } = require('../services/executor/src/xgovernor/command-diagnostics.cjs')
  const failure = commandFailure({ exit_code: 'private-secret', stderr: `${'x'.repeat(20000)}Permission denied private-secret` }, 'private-secret')
  assert.equal(failure.runFacts.sandboxDiagnostic.reason, 'COMMAND_FAILED')
  assert.equal(failure.runFacts.sandboxDiagnostic.operation, 'sandbox-command')
  assert.equal(failure.message.includes('private-secret'), false)
  assert.ok(failure.message.length < 200)
  const unicode = commandFailure({ exit_code: 1, stderr: `${'中'.repeat(6000)}Permission denied` }, 'workspace-head')
  assert.equal(unicode.runFacts.sandboxDiagnostic.reason, 'COMMAND_FAILED')
})

test('collecting command failure retains existing Trace facts and reaches the Case failure notice', async t => {
  const f = commandBackend(t, { exit_code: 128, stderr: 'Permission denied /root/private-path?api_key=private-secret', timed_out: false })
  let completion: any
  const store = new FileRunStore(f.root)
  const backend = {
    async prepare(_task: unknown, context: any) { await context.persist(f.handle); return f.handle },
    async runAgent() { return { exitCode: 0, traceId: 'trace-kept', model: 'selected-model' } },
    async collect() { return f.backend.exec(f.handle, ['git', 'add', '-A'], undefined, undefined, 'patch-stage') },
    async cancel() {}, async close() { return { status: 'succeeded' } }, async recover() {},
  }
  const runner = new BenchmarkExecutionRunner({ store, executionBackends: new ExecutionBackendRegistry([['local', backend]]), callback: {
    async progress() {}, async complete(_request: unknown, value: unknown) { completion = value },
  } })
  const request = { runId: 'run_error', timeoutSeconds: 30, task: {
    context: { runId: 'run_error' }, benchmark: { key: 'swe-bench' }, workspace: { provider: 'git' },
    agentConfig: { platform: 'pi-agent', agent: 'pi-agent', timeoutSeconds: 30 }, task: { instruction: 'fix it' }, submission: { requiredArtifacts: [{ name: 'model.patch' }] },
  } }
  await store.accept(request)
  await runner.execute(request)
  assert.equal(completion.status, 'failed')
  assert.equal(completion.runFacts.traceId, 'trace-kept')
  assert.equal(completion.runFacts.model, 'selected-model')
  assert.equal(completion.runFacts.sandboxDiagnostic.phase, 'collecting')
  assert.equal((await store.state(request.runId)).runFacts.sandboxDiagnostic.reason, 'WORKSPACE_PERMISSION')
  const markup = renderToStaticMarkup(createElement(BenchmarkFailureNotice, completion.error))
  assert.match(markup, /提交物收集失败.*暂存 Agent 修改.*退出码 128/)
  assert.match(markup, /工作区权限不足/)
  assert.equal(markup.includes('private-secret'), false)
})

async function rejected(response: Response, expectedCode = 'XGOVERNOR_REJECTED'): Promise<Error & { code: string }> {
  const client = new XGovernorClient('http://127.0.0.1:1', 'private-admin-token', async () => response)
  try { await client.request('/sessions/open', {}); assert.fail('Expected HTTP rejection') }
  catch (cause) {
    assert.equal((cause as { code: string }).code, expectedCode)
    return cause as Error & { code: string }
  }
}

test('actual flat SessionWireError JSON preserves a safe Pi probe failure reason', async () => {
  const failure = await rejected(Response.json({ code: 'invalid_request', message: probeFailure }, { status: 400 }), 'MODEL_PREFLIGHT_FAILED')
  assert.match(failure.message, /Pi 在返回模型预检查结果前退出/)
  assert.match(failure.message, /扩展路径/)
})

test('known model errors expose fixed reasons without credentials, endpoints, headers or local paths', async () => {
  const secrets = ['private-api-key', 'private-token', 'private-password', 'https://private-model.example/v1?api_key=private-query', '/root/private-agent/auth.json']
  for (const [message, expected, code] of [
    ['Failed to start isolated Pi model probe', '无法启动 Pi 模型预检查进程', 'MODEL_PREFLIGHT_FAILED'],
    ['Pi model probe timed out', '模型检查未在规定时间内完成', 'MODEL_PREFLIGHT_TIMEOUT'],
    ['Model authentication failed', '模型服务拒绝了认证', 'MODEL_AUTHENTICATION_FAILED'],
    ['Model not found or unavailable', '所选模型不存在或不可用', 'MODEL_NOT_FOUND'],
    ['Model endpoint connection failed', '无法连接模型服务', 'MODEL_CONNECTION_FAILED'],
    ['Invalid model protocol or capabilities', '模型 API 协议或请求配置不合法', 'MODEL_REQUEST_INVALID'],
  ]) {
    const failure = await rejected(Response.json({ error: { message: `${message}: ${secrets.join(' ')} Authorization: Bearer private-token`, details: { api_key: secrets[0], password: secrets[2] } } }, { status: 400 }), code)
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
    assert.equal(failure.message, '执行环境请求失败（HTTP 502）')
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
  assert.equal(failed.message, '执行环境请求失败（HTTP 500）')
  let cancelled = false
  const pending = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 500 })
  const failure = await rejected(pending)
  assert.equal(failure.message, '执行环境请求失败（HTTP 500）')
  assert.equal(cancelled, true)
})

test('safe xGovernor rejection survives executor completion and renders in the Case failure notice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-error-flow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const client = new XGovernorClient('http://127.0.0.1:1', 'private-admin-token', async () => {
    calls++
    return Response.json({ code: 'invalid_request', message: 'invalid request: model preflight timed out; token=private-api-key; /root/private-path' }, { status: 400 })
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
    agentConfig: { platform: 'xiaoo', agent: 'defaultagent', timeoutSeconds: 30 }, task: { instruction: 'fix it' }, submission: { requiredArtifacts: [] },
  } }
  await store.accept(request)
  await runner.execute(request)
  assert.equal(calls, 1, 'A rejected open request must not be replayed')
  assert.equal(completion.status, 'failed')
  assert.equal(completion.error.code, 'MODEL_PREFLIGHT_TIMEOUT')
  assert.equal((await store.state(request.runId)).completion.error.message, completion.error.message)
  const markup = renderToStaticMarkup(createElement(BenchmarkFailureNotice, completion.error))
  assert.match(markup, /模型预检查超时/)
  assert.match(markup, /启动 Agent 前的模型检查未在规定时间内完成/)
  assert.match(markup, /检查执行机到模型服务的连接/)
  for (const value of ['private-admin-token', 'private-api-key', '/root/private-path']) assert.equal(markup.includes(value), false)
})

test('xiaoO model preflight causes map independently of casing and error-envelope layout', async () => {
  const cases = [
    ['model preflight timed out', 'MODEL_PREFLIGHT_TIMEOUT', '模型检查未在规定时间内完成'],
    ['model preflight: request failed: model authentication failed', 'MODEL_AUTHENTICATION_FAILED', '模型服务拒绝了认证'],
    ['model preflight: request failed: model not found', 'MODEL_NOT_FOUND', '所选模型不存在或不可用'],
    ['model preflight: request failed: model connection failed', 'MODEL_CONNECTION_FAILED', '无法连接模型服务'],
    ['model preflight: request failed: model rate limited', 'MODEL_RATE_LIMITED', '请求受限'],
    ['model preflight: request failed: invalid model response', 'MODEL_RESPONSE_INVALID', '响应格式异常'],
    ['model preflight: request failed: model request timed out', 'MODEL_REQUEST_TIMEOUT', '模型请求未在规定时间内完成'],
    ['model preflight: request failed: invalid model request configuration', 'MODEL_REQUEST_INVALID', '模型 API 协议或请求配置不合法'],
    ['model preflight: request failed: model context limit exceeded', 'MODEL_REQUEST_INVALID', '超过上下文限制'],
    ['model preflight: request failed: model service request failed', 'MODEL_SERVICE_ERROR', '模型服务处理请求失败'],
  ]
  const secret = 'private-api-key https://private-model.example/v1?token=private-token /root/private-path'
  for (const [message, code, expected] of cases) {
    for (const value of [message, message.toUpperCase()]) {
      const body = `invalid request: ${value}; ${secret}`
      for (const response of [
        Response.json({ code: 'invalid_request', message: body }, { status: 400 }),
        Response.json({ error: { message: body } }, { status: 400 }),
        Response.json({ error: body }, { status: 400 }),
        Response.json(body, { status: 400 }),
        new Response(body, { status: 400 }),
      ]) {
        const failure = await rejected(response, code)
        assert.ok(failure.message.includes(expected), failure.message)
        assert.equal(failure.message.includes('HTTP 400'), false)
        for (const privateValue of ['private-api-key', 'private-model.example', 'private-token', '/root/private-path']) assert.equal(failure.message.includes(privateValue), false)
      }
    }
  }
})

test('HTTP status alone never guesses a model failure reason', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const failure = await rejected(Response.json({ code: 'invalid_request', message: 'Unrecognized private-api-key' }, { status }))
    assert.equal(failure.message, `执行环境请求失败（HTTP ${status}）`)
  }
})
