import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyCommandStatus,
  assertPayloadSafe,
  claimNextCommand,
  createCommand,
  getCommand,
  isWhitelistedAction,
  markSent,
  sweepUnackedCommands,
} from '@/lib/reliability/command-bus'
import { handleCommandStatus } from '@/lib/reliability/command-receipt'
import { createInstallToken, registerClient } from '@/lib/reliability/client-registry'
import { prismaRaw } from '@/lib/storage/prisma'

const TEST_USER = `ras-cmd-test-${process.pid}`

async function newClient() {
  const { installToken } = await createInstallToken({ user: TEST_USER, expiresInSeconds: 600 })
  return registerClient({ installToken, hostname: 'cmd-host' })
}

async function cleanup() {
  await prismaRaw.reliabilityConfigDelivery.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityConfigSnapshot.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityCommand.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityClientCredential.deleteMany({
    where: { client: { user: TEST_USER } },
  })
  await prismaRaw.reliabilityClient.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityInstallToken.deleteMany({ where: { user: TEST_USER } })
}

test('action whitelist rejects unknown actions', () => {
  assert.equal(isWhitelistedAction('APPLY_CLIENT_CONFIG'), true)
  assert.equal(isWhitelistedAction('RUN_EXPERIMENT_CASE'), true)
  assert.equal(isWhitelistedAction('RUN_SHELL'), false)
  assert.equal(isWhitelistedAction(''), false)
  assert.equal(isWhitelistedAction(null), false)
})

test('config actions reject url/path/config payload keys', () => {
  // 配置类指令只能携带引用，不能夹带下载地址或完整配置。
  for (const key of ['url', 'config', 'path', 'downloadUrl', 'file']) {
    assert.throws(
      () => assertPayloadSafe('APPLY_CLIENT_CONFIG', { configRef: 'x', [key]: 'evil' }),
      (err: Error & { code?: string }) => err.code === 'COMMAND_PAYLOAD_FORBIDDEN',
      `expected ${key} to be rejected`,
    )
  }
  assert.doesNotThrow(() =>
    assertPayloadSafe('APPLY_CLIENT_CONFIG', {
      platform: 'opencode',
      configRef: 'cfgref_1',
      configVersion: 'cfg_1',
      checksum: 'sha256:abc',
    }),
  )
})

test('run action rejects free-form execution fields', () => {
  for (const key of ['command', 'shell', 'args', 'cwd', 'executable', 'script']) {
    assert.throws(
      () => assertPayloadSafe('RUN_EXPERIMENT_CASE', { platform: 'opencode', [key]: 'rm -rf /' }),
      (err: Error & { code?: string }) => err.code === 'COMMAND_PAYLOAD_FORBIDDEN',
      `expected ${key} to be rejected`,
    )
  }
  assert.doesNotThrow(() =>
    assertPayloadSafe('RUN_EXPERIMENT_CASE', {
      platform: 'opencode',
      model: 'qwen3-32b',
      input: 'do the thing',
    }),
  )
})

test('unknown action cannot be created', async () => {
  try {
    const client = await newClient()
    await assert.rejects(
      () =>
        createCommand({
          user: TEST_USER,
          clientId: client.clientId,
          // @ts-expect-error 故意传非白名单 action
          action: 'RUN_SHELL',
          payload: {},
        }),
      (err: Error & { code?: string }) => err.code === 'COMMAND_ACTION_UNKNOWN',
    )
  } finally {
    await cleanup()
  }
})

test('command without ACK becomes DELIVERY_FAILED after the ack window', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'APPLY_CLIENT_CONFIG',
      payload: { platform: 'opencode', configRef: 'cfgref_x' },
    })
    await markSent(frame.commandId, 'wss')

    // 把 sentAt 推到 ACK 窗口之外
    await prismaRaw.reliabilityCommand.update({
      where: { commandId: frame.commandId },
      data: { sentAt: new Date(Date.now() - 60_000) },
    })
    await sweepUnackedCommands(TEST_USER)

    const row = await getCommand(frame.commandId)
    assert.equal(row?.status, 'DELIVERY_FAILED')
    assert.equal(row?.errorCode, 'ACK_TIMEOUT')
  } finally {
    await cleanup()
  }
})

test('ACK moves the command out of SENT', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
    })
    await markSent(frame.commandId, 'wss')
    await applyCommandStatus({
      clientId: client.clientId,
      commandId: frame.commandId,
      status: 'RECEIVED',
    })
    const row = await getCommand(frame.commandId)
    assert.equal(row?.status, 'RECEIVED')
    assert.ok(row?.receivedAt)

    // 已 ACK 的指令不会被 sweep 误判为投递失败
    await sweepUnackedCommands(TEST_USER)
    assert.equal((await getCommand(frame.commandId))?.status, 'RECEIVED')
  } finally {
    await cleanup()
  }
})

test('terminal status is idempotent — replayed receipts do not rewrite it', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
    })
    await applyCommandStatus({
      clientId: client.clientId,
      commandId: frame.commandId,
      status: 'SUCCEEDED',
    })
    await applyCommandStatus({
      clientId: client.clientId,
      commandId: frame.commandId,
      status: 'FAILED',
      error: { code: 'LATE', message: 'should be ignored' },
    })
    const row = await getCommand(frame.commandId)
    assert.equal(row?.status, 'SUCCEEDED')
    assert.equal(row?.errorCode, null)
  } finally {
    await cleanup()
  }
})

test('a command belonging to another client is not found', async () => {
  try {
    const a = await newClient()
    const b = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: a.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
    })
    await assert.rejects(
      () =>
        applyCommandStatus({
          clientId: b.clientId,
          commandId: frame.commandId,
          status: 'RECEIVED',
        }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'COMMAND_NOT_FOUND' && err.status === 404,
    )
  } finally {
    await cleanup()
  }
})

test('expired command is rejected with 410', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
      ttlMs: 5_000,
    })
    await prismaRaw.reliabilityCommand.update({
      where: { commandId: frame.commandId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await assert.rejects(
      () =>
        applyCommandStatus({
          clientId: client.clientId,
          commandId: frame.commandId,
          status: 'RECEIVED',
        }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'COMMAND_EXPIRED' && err.status === 410,
    )
  } finally {
    await cleanup()
  }
})

test('long-poll claims a pending command exactly once', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
    })
    const first = await claimNextCommand(client.clientId)
    assert.equal(first?.commandId, frame.commandId)
    // 已投递的指令不会被重复领取
    assert.equal(await claimNextCommand(client.clientId), null)
  } finally {
    await cleanup()
  }
})

test('SUCCEEDED without WRITTEN state does not advance delivery', async () => {
  try {
    const client = await newClient()
    await prismaRaw.reliabilityConfigDelivery.create({
      data: {
        deliveryId: 'delivery_test_1',
        clientId: client.clientId,
        user: TEST_USER,
        platform: 'opencode',
        configRef: 'cfgref_test_1',
        configVersion: 'cfg_test_1',
        checksum: 'sha256:test',
        status: 'pulling',
      },
    })
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'APPLY_CLIENT_CONFIG',
      payload: { platform: 'opencode', configRef: 'cfgref_test_1' },
    })
    // 回执缺 state=WRITTEN：视为未确认写入，delivery 不得推进。
    await handleCommandStatus({
      clientId: client.clientId,
      commandId: frame.commandId,
      status: 'SUCCEEDED',
      result: {},
    })
    const row = await prismaRaw.reliabilityConfigDelivery.findUnique({
      where: { deliveryId: 'delivery_test_1' },
    })
    assert.equal(row?.status, 'pulling')
    assert.equal(row?.writtenAt, null)
  } finally {
    await cleanup()
  }
})

test('FAILED receipt records pull vs write stage', async () => {
  try {
    const client = await newClient()
    await prismaRaw.reliabilityConfigDelivery.create({
      data: {
        deliveryId: 'delivery_test_2',
        clientId: client.clientId,
        user: TEST_USER,
        platform: 'opencode',
        configRef: 'cfgref_test_2',
        configVersion: 'cfg_test_2',
        checksum: 'sha256:test2',
        status: 'sync_notified',
      },
    })
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'APPLY_CLIENT_CONFIG',
      payload: { platform: 'opencode', configRef: 'cfgref_test_2' },
    })
    await handleCommandStatus({
      clientId: client.clientId,
      commandId: frame.commandId,
      status: 'FAILED',
      result: { state: 'PULLING' },
      error: { code: 'CHECKSUM_MISMATCH', message: 'checksum mismatch' },
    })
    const row = await prismaRaw.reliabilityConfigDelivery.findUnique({
      where: { deliveryId: 'delivery_test_2' },
    })
    assert.equal(row?.status, 'pull_failed')
    assert.equal(row?.errorCode, 'CHECKSUM_MISMATCH')
  } finally {
    await cleanup()
  }
})

test('invalid receipt status is rejected', async () => {
  try {
    const client = await newClient()
    const frame = await createCommand({
      user: TEST_USER,
      clientId: client.clientId,
      action: 'REFRESH_CAPABILITIES',
      payload: {},
    })
    await assert.rejects(
      () =>
        handleCommandStatus({
          clientId: client.clientId,
          commandId: frame.commandId,
          status: 'WRITTEN',
        }),
      (err: Error & { code?: string }) => err.code === 'COMMAND_STATUS_INVALID',
    )
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------- FI 端点双鉴权

test('all FI worker endpoints the client uses accept device credentials', async () => {
  // 回归：claim/heartbeat 早期加了双鉴权，但 collect-result 与 commands 漏了，
  // 导致客户端能领任务却传不回结果，run 永远卡在 collecting。
  const fs = await import('node:fs')
  const path = await import('node:path')
  const routes = [
    'src/app/api/fault-injection/worker/heartbeat/route.ts',
    'src/app/api/fault-injection/worker/claim/route.ts',
    'src/app/api/fault-injection/worker/commands/route.ts',
    'src/app/api/fault-injection/runs/[runId]/collect-result/route.ts',
  ]
  for (const rel of routes) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
    assert.ok(
      src.includes('resolveWorkerCaller'),
      `${rel} 必须用 resolveWorkerCaller 支持设备凭证，否则常驻客户端会被拒`,
    )
  }
})
