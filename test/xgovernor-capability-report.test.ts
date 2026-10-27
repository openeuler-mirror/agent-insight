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
import http from 'node:http'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createIsolatedDatabase } from './helpers/isolated-database'

const require = createRequire(import.meta.url)
const database = createIsolatedDatabase()
const { prismaRaw } = require('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { createInstallToken, registerClient, parseCapabilities } = require('../src/lib/reliability/client-registry') as typeof import('@/lib/reliability/client-registry')
const { PUT } = require('../src/app/api/reliability/client/v1/capabilities/route') as typeof import('@/app/api/reliability/client/v1/capabilities/route')
const { reportCapabilities } = require('../scripts/reliability-client.cjs')
const { normalizeExecutionConfig, describeProfile } = require('../packages/benchmark-protocol/execution.cjs')

test.after(async () => { await prismaRaw.$disconnect(); database.dispose() })

test('client HTTP capability reports preserve actual xGovernor revision, digest and readiness through the platform route', async t => {
  const user = `xgov-capability-${process.pid}`
  const token = await createInstallToken({ user, expiresInSeconds: 600 })
  const registered = await registerClient({ installToken: token.installToken, hostname: 'fixture' })
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const response = await PUT(new Request(`http://127.0.0.1${req.url}`, {
        method: 'PUT', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString(),
      }))
      res.writeHead(response.status)
      res.end(await response.text())
    } catch (cause) { res.writeHead(500); res.end(String(cause)) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address() as { port: number }
  const cfg = { ...registered, insightBaseUrl: `http://127.0.0.1:${address.port}` }
  const local = normalizeExecutionConfig().profiles['xgovernor-local-docker']
  for (const [revision, ready] of [['a', true], ['b', false]] as const) {
    const profile = describeProfile('xgovernor-local-docker', { ...local, managedRevision: revision.repeat(40), artifactDigest: `sha256:${revision.repeat(64)}` })
    await reportCapabilities(cfg, {
      platforms: [], actions: ['RUN_BENCHMARK_CASE'], components: { 'execution-backend/v1': { ready: true } },
      executionProfiles: [{ profile, ready, benchmarks: ['swe-bench'], ...(ready ? {} : { note: '模型凭据未就绪' }) }], faultInjection: { ready: false },
    })
    const stored = await prismaRaw.reliabilityClient.findUniqueOrThrow({ where: { clientId: registered.clientId } })
    const capability = parseCapabilities(stored.capabilitiesJson).executionProfiles?.[0]
    assert.deepEqual(capability?.profile, profile)
    assert.equal(capability?.ready, ready)
    assert.equal(capability?.note, ready ? undefined : '模型凭据未就绪')
  }
})
