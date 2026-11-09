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
import http from 'node:http'
import { createRequire } from 'node:module'
import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const load = createRequire(import.meta.url)
const { prismaRaw: prisma } = load('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { createInstallToken, registerClient } = load('@/lib/reliability/client-registry') as typeof import('@/lib/reliability/client-registry')
const { createCommand, claimNextCommand, applyCommandStatus, getCommand } = load('@/lib/reliability/command-bus') as typeof import('@/lib/reliability/command-bus')
const { GET } = load('@/app/api/reliability/client/v1/commands/next/route') as typeof import('@/app/api/reliability/client/v1/commands/next/route')
const user = `delivery-recovery-${process.pid}`
test.after(async () => { await prisma.$disconnect(); database.dispose() })
async function fixture() {
  const token = await createInstallToken({ user })
  const client = await registerClient({ installToken: token.installToken })
  const frame = await createCommand({ user, clientId: client.clientId, action: 'REFRESH_CAPABILITIES' })
  return { client, frame }
}

test('an already-aborted HTTP poll leaves work available for a live request', async () => {
  const { client, frame } = await fixture()
  const controller = new AbortController(); controller.abort()
  const response = await GET(new Request('http://localhost/api/reliability/client/v1/commands/next?waitSeconds=1', {
    signal: controller.signal, headers: { authorization: `Bearer ${client.deviceCredential}`, 'x-agent-insight-client-id': client.clientId },
  }))
  assert.equal(response.status, 204)
  assert.equal((await getCommand(frame.commandId))?.status, 'CREATED')
  assert.equal((await claimNextCommand(client.clientId))?.commandId, frame.commandId)
})

test('a poll aborted while reading a candidate does not claim it', async (t) => {
  const { client, frame } = await fixture()
  const controller = new AbortController()
  const find = prisma.reliabilityCommand.findFirst.bind(prisma.reliabilityCommand)
  prisma.reliabilityCommand.findFirst = async (...args: Parameters<typeof find>) => {
    const row = await find(...args)
    controller.abort()
    return row
  }
  t.after(() => { prisma.reliabilityCommand.findFirst = find })
  assert.equal(await claimNextCommand(client.clientId, { signal: controller.signal }), null)
  assert.equal((await getCommand(frame.commandId))?.status, 'CREATED')
})

test('concurrent polls have exactly one command-claim winner', async (t) => {
  const { client, frame } = await fixture()
  const find = prisma.reliabilityCommand.findFirst.bind(prisma.reliabilityCommand)
  let arrived = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  prisma.reliabilityCommand.findFirst = async (...args: Parameters<typeof find>) => {
    const row = await find(...args)
    if (++arrived === 2) release()
    await gate
    return row
  }
  t.after(() => { prisma.reliabilityCommand.findFirst = find })
  const claimed = await Promise.all([claimNextCommand(client.clientId), claimNextCommand(client.clientId)])
  assert.deepEqual(claimed.filter(Boolean).map(item => item!.commandId), [frame.commandId])
})

test('the execution wait read settles only its overdue SENT command without a client-list sweep', async () => {
  const first = await fixture(), other = await fixture()
  for (const { frame } of [first, other]) await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { status: 'SENT', sentAt: new Date(Date.now() - 60_000) } })
  const row = await getCommand(first.frame.commandId)
  assert.equal(row?.status, 'DELIVERY_FAILED')
  assert.equal(row?.errorCode, 'ACK_TIMEOUT')
  assert.equal((await prisma.reliabilityCommand.findUnique({ where: { commandId: other.frame.commandId } }))?.status, 'SENT')
})

test('an acknowledged or running command is never failed by the ACK deadline', async () => {
  const { client, frame } = await fixture()
  await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { status: 'SENT', sentAt: new Date(Date.now() - 60_000) } })
  await applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'RECEIVED' })
  assert.equal((await getCommand(frame.commandId))?.status, 'RECEIVED')
  await applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'RUNNING' })
  assert.equal((await getCommand(frame.commandId))?.status, 'RUNNING')
})

test('late RECEIVED for a failed command is rejected but terminal result replays stay idempotent', async () => {
  const { client, frame } = await fixture()
  await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { status: 'DELIVERY_FAILED', errorCode: 'ACK_TIMEOUT' } })
  await assert.rejects(applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'RECEIVED' }), (error: Error & { code?: string }) => error.code === 'COMMAND_NOT_ACCEPTED')
  await applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'SUCCEEDED' })
  assert.equal((await getCommand(frame.commandId))?.status, 'DELIVERY_FAILED')
})

test('a committed ACK with a lost HTTP response does not start local work', async (t) => {
  const { client: registered } = await fixture()
  const frame = await createCommand({ user, clientId: registered.clientId, action: 'APPLY_CLIENT_CONFIG', payload: { platform: 'opencode', scope: 'client', configRef: 'probe' } })
  const daemon = createRequire(import.meta.url)('../scripts/reliability-client.cjs')
  let pulls = 0
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/status')) {
      let raw = ''; for await (const chunk of req) raw += chunk
      await applyCommandStatus({ clientId: registered.clientId, commandId: frame.commandId, status: JSON.parse(raw).status })
      req.socket.destroy()
      return
    }
    pulls++; res.writeHead(503); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address() as { port: number }
  await daemon.handleCommand({ insightBaseUrl: `http://127.0.0.1:${address.port}`, clientId: registered.clientId, deviceCredential: registered.deviceCredential }, frame, async () => assert.fail('ACK failure must stop all later action receipts'))
  assert.equal((await getCommand(frame.commandId))?.status, 'RECEIVED')
  assert.equal(pulls, 0)
  await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { expiresAt: new Date(Date.now() - 1) } })
  await assert.rejects(applyCommandStatus({ clientId: registered.clientId, commandId: frame.commandId, status: 'RECEIVED' }), (error: Error & { code?: string }) => error.code === 'COMMAND_EXPIRED')
  assert.equal((await getCommand(frame.commandId))?.status, 'EXPIRED')
})

test('ACK timeout compare-and-set cannot overwrite a concurrently accepted receipt', async (t) => {
  const { frame } = await fixture()
  await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { status: 'SENT', sentAt: new Date(Date.now() - 60_000) } })
  const update = prisma.reliabilityCommand.updateMany.bind(prisma.reliabilityCommand)
  prisma.reliabilityCommand.updateMany = async (...args: Parameters<typeof update>) => {
    if (args[0]?.data.errorCode === 'ACK_TIMEOUT') await update({ where: { commandId: frame.commandId }, data: { status: 'RECEIVED', receivedAt: new Date() } })
    return update(...args)
  }
  t.after(() => { prisma.reliabilityCommand.updateMany = update })
  assert.equal((await getCommand(frame.commandId))?.status, 'RECEIVED')
})


test('a concurrent expiry winner never produces a successful late RECEIVED acknowledgement', async (t) => {
  const { client, frame } = await fixture()
  await prisma.reliabilityCommand.update({ where: { commandId: frame.commandId }, data: { expiresAt: new Date(Date.now() - 1) } })
  const update = prisma.reliabilityCommand.updateMany.bind(prisma.reliabilityCommand)
  prisma.reliabilityCommand.updateMany = async (...args: Parameters<typeof update>) => {
    if (args[0]?.data.status === 'EXPIRED') await update({ where: { commandId: frame.commandId }, data: { status: 'EXPIRED' } })
    return update(...args)
  }
  t.after(() => { prisma.reliabilityCommand.updateMany = update })
  await assert.rejects(applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'RECEIVED' }), (error: Error & { code?: string }) => error.code === 'COMMAND_NOT_ACCEPTED')
  assert.equal((await getCommand(frame.commandId))?.status, 'EXPIRED')
  await applyCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'SUCCEEDED' })
  assert.equal((await getCommand(frame.commandId))?.status, 'EXPIRED')
})
