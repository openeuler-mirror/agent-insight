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
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import http from 'node:http'
import { activateIsolatedHome } from './helpers/isolated-home'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-delivery-'))
const restore = activateIsolatedHome(root)
const client = createRequire(import.meta.url)('../scripts/reliability-client.cjs')
test.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }) })

test('default command polling stays below the observed public idle cutoff and validates overrides', () => {
  assert.equal(client.pollWaitSeconds({}), 5)
  assert.equal(client.pollWaitSeconds({ AGENT_INSIGHT_RAS_POLL_WAIT_SEC: '10' }), 10)
  for (const value of ['', '0', '-1', '31', 'NaN', '1.5']) assert.equal(client.pollWaitSeconds({ AGENT_INSIGHT_RAS_POLL_WAIT_SEC: value }), 5)
})

for (const mode of ['rejected', 'lost', 'invalid-success'] as const) test(`${mode} RECEIVED acknowledgement never starts the native action`, async (t) => {
  const original = globalThis.fetch
  let configPulls = 0, acknowledgementRequests = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/status') && JSON.parse(String(init?.body)).status === 'RECEIVED') {
      acknowledgementRequests++
      if (mode === 'lost') throw new TypeError('fixture acknowledgement response lost')
      if (mode === 'invalid-success') return new Response('{}')
      return new Response(JSON.stringify({ error: { code: 'COMMAND_NOT_ACCEPTED', message: 'already failed' } }), { status: 409 })
    }
    if (url.includes('/config-snapshots/')) configPulls++
    return new Response('{}', { status: 503 })
  }
  t.after(() => { globalThis.fetch = original })
  await client.handleCommand({ insightBaseUrl: 'http://fixture.invalid', clientId: 'fixture', deviceCredential: 'synthetic' }, {
    commandId: `ack-${mode}`, action: 'APPLY_CLIENT_CONFIG', payload: { platform: 'opencode', scope: 'client', configRef: 'probe' },
  }, async () => {})
  assert.equal(acknowledgementRequests, 1, 'WebSocket delivery still requires an authoritative HTTPS receipt')
  assert.equal(configPulls, 0, 'configuration execution started without accepted receipt')
})

test('a real HTTP poll requests the configured short wait', async (t) => {
  let requestPath = ''
  const server = http.createServer((req, res) => { requestPath = req.url || ''; res.writeHead(204); res.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address() as { port: number }
  await client.pollOnce({ insightBaseUrl: `http://127.0.0.1:${address.port}`, clientId: 'fixture', deviceCredential: 'synthetic' })
  assert.equal(new URL(requestPath, 'http://fixture').searchParams.get('waitSeconds'), '5')
})

test('an unresponsive real HTTP poll stops at its own transport deadline', { timeout: 15000 }, async (t) => {
  const previous = process.env.AGENT_INSIGHT_RAS_POLL_WAIT_SEC
  process.env.AGENT_INSIGHT_RAS_POLL_WAIT_SEC = '1'
  const server = http.createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections(); server.close()
    if (previous === undefined) delete process.env.AGENT_INSIGHT_RAS_POLL_WAIT_SEC
    else process.env.AGENT_INSIGHT_RAS_POLL_WAIT_SEC = previous
  })
  const address = server.address() as { port: number }, start = Date.now()
  await assert.rejects(client.pollOnce({ insightBaseUrl: `http://127.0.0.1:${address.port}`, clientId: 'fixture', deviceCredential: 'synthetic' }), (error: Error) => error.name === 'TimeoutError')
  assert.ok(Date.now() - start < 14000)
})
