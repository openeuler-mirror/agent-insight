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
import test from 'node:test'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

test('remote RAS config deadline covers a stalled response body and aborts the request', async t => {
  const { syncCapabilityConfigFromInsight } = await import(pathToFileURL(path.resolve('agent_ras/platform_adapter/opencode/config_sync.js')).href)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-deadline-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agent_ras: { insight: { events_url: 'http://platform.invalid/api/ingest/ras-events', api_key: 'test' } } }))
  let signal: AbortSignal | undefined
  const result = await Promise.race([
    syncCapabilityConfigFromInsight({ rasHome: dir, timeoutMs: 50, fetchImpl: async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return { ok: true, json: () => new Promise(() => {}) }
    } }),
    new Promise(resolve => setTimeout(() => resolve({ reason: 'test_deadline' }), 500)),
  ]) as { applied?: boolean, reason: string }
  assert.notEqual(result.reason, 'test_deadline')
  assert.equal(result.applied, false)
  assert.equal(signal?.aborted, true)
})

test('RAS plugin returns hooks without waiting for platform sync', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-startup-'))
  const beforeHome = process.env.AGENT_INSIGHT_RAS_HOME, beforeFetch = globalThis.fetch
  process.env.AGENT_INSIGHT_RAS_HOME = dir
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agent_ras: { insight: { events_url: 'http://platform.invalid/api/ingest/ras-events', api_key: 'test' } } }))
  let release: (value: Response) => void = () => {}
  let started: () => void = () => {}
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; started() })) as typeof fetch
  t.after(async () => {
    await requestStarted
    release(new Response('{"syncEnabled":false}'))
    await new Promise(resolve => setImmediate(resolve))
    globalThis.fetch = beforeFetch
    if (beforeHome === undefined) delete process.env.AGENT_INSIGHT_RAS_HOME; else process.env.AGENT_INSIGHT_RAS_HOME = beforeHome
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { AgentRasPlugin } = await import(pathToFileURL(path.resolve('agent_ras/platform_adapter/opencode/plugin.js')).href)
  const result = await Promise.race([AgentRasPlugin({ client: {}, directory: dir }), new Promise(resolve => setTimeout(() => resolve('blocked'), 150))])
  assert.notEqual(result, 'blocked')
})

test('loopback config transport leaves the event loop available to serve its response', async t => {
  const { defaultRasConfigFetch } = await import(pathToFileURL(path.resolve('agent_ras/platform_adapter/opencode/config_sync.js')).href)
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ syncEnabled: false }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const response = await defaultRasConfigFetch(`http://127.0.0.1:${address.port}/api/ingest/ras-config`)
  assert.equal(response.ok, true)
  assert.deepEqual(await response.json(), { syncEnabled: false })
})

test('loopback config transport aborts curl when the sync deadline cancels it', async t => {
  const { defaultRasConfigFetch } = await import(pathToFileURL(path.resolve('agent_ras/platform_adapter/opencode/config_sync.js')).href)
  const server = http.createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), 50)
  try {
    await assert.rejects(defaultRasConfigFetch(`http://127.0.0.1:${address.port}/api/ingest/ras-config`, { signal: controller.signal }), { code: 'ABORT_ERR' })
  } finally {
    clearTimeout(abort)
  }
})
