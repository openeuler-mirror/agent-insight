import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateDevice,
  createInstallToken,
  deriveStatus,
  listClients,
  registerClient,
} from '@/lib/reliability/client-registry'
import { prismaRaw } from '@/lib/storage/prisma'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

const USER_A = `rebind-a-${process.pid}`
const USER_B = `rebind-b-${process.pid}`

async function bind(user: string, previousClientId?: string) {
  const { installToken } = await createInstallToken({ user, expiresInSeconds: 600 })
  return registerClient({
    installToken,
    hostname: 'same-host',
    reportedIp: '10.0.0.9',
    previousClientId: previousClientId ?? null,
  })
}

function credentialRequest(clientId: string, credential: string): Request {
  return new Request('https://insight.test/api/reliability/client/v1/heartbeat', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'x-agent-insight-client-id': clientId,
    },
  })
}

async function cleanup() {
  for (const user of [USER_A, USER_B]) {
    await prismaRaw.reliabilityClientCredential.deleteMany({ where: { client: { user } } })
    await prismaRaw.reliabilityClient.deleteMany({ where: { user } })
    await prismaRaw.reliabilityInstallToken.deleteMany({ where: { user } })
  }
}

test('rebinding to another account unbinds the old one and revokes its credential', async () => {
  try {
    const a = await bind(USER_A)
    assert.equal(a.user, USER_A)
    assert.equal(a.unboundPrevious, null, '首次绑定没有前序客户端')

    // A 的凭证此刻可用
    const authA = await authenticateDevice(credentialRequest(a.clientId, a.deviceCredential))
    assert.equal(authA.user, USER_A)

    // 同一台机器改绑到 B
    const b = await bind(USER_B, a.clientId)
    assert.equal(b.user, USER_B)
    assert.deepEqual(b.unboundPrevious, { clientId: a.clientId, user: USER_A })

    // 关键：A 的凭证必须立即失效，否则原账号仍能向这台机器下发配置
    await assert.rejects(
      () => authenticateDevice(credentialRequest(a.clientId, a.deviceCredential)),
      (err: Error & { code?: string }) => err.code === 'DEVICE_UNAUTHORIZED',
      'A 的旧凭证必须已撤销',
    )

    // B 的凭证正常
    const authB = await authenticateDevice(credentialRequest(b.clientId, b.deviceCredential))
    assert.equal(authB.user, USER_B)
  } finally {
    await cleanup()
  }
})

test('unbound client is kept for audit and shown as unbound, not offline', async () => {
  try {
    const a = await bind(USER_A)
    await bind(USER_B, a.clientId)

    // 记录保留 —— 配置下发历史仍可追溯
    const rows = await listClients(USER_A, {})
    assert.equal(rows.items.length, 1, '旧记录应保留而非删除')
    assert.equal(
      rows.items[0].status,
      'unbound',
      '必须显示为已解绑；显示成离线会让人以为机器只是掉线',
    )

    const row = await prismaRaw.reliabilityClient.findUnique({ where: { clientId: a.clientId } })
    assert.ok(row?.unboundAt, 'unboundAt 应被写入')
  } finally {
    await cleanup()
  }
})

test('unbound takes precedence over freshness in status derivation', () => {
  const fresh = { status: 'online', lastSeenAt: new Date(), unboundAt: new Date() }
  assert.equal(deriveStatus(fresh), 'unbound', '心跳再新也不能显示在线')
  assert.equal(deriveStatus({ status: 'online', lastSeenAt: new Date() }), 'online')
})

test('rebinding twice does not re-unbind an already unbound client', async () => {
  try {
    const a = await bind(USER_A)
    const b1 = await bind(USER_B, a.clientId)
    assert.ok(b1.unboundPrevious)

    // 幂等：再拿同一个已解绑的 clientId 改绑，不应重复解绑
    const b2 = await bind(USER_B, a.clientId)
    assert.equal(b2.unboundPrevious, null, '已解绑的客户端不应再次触发解绑')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------- 安装器侧的归属判定

function installerSource(): string {
  return require_('node:fs').readFileSync(
    require_('node:path').join(__dirname, '..', 'scripts', 'install-ras-client.js'),
    'utf8',
  ) as string
}

test('installer records the owning account so the next install can compare', () => {
  const src = installerSource()
  assert.match(src, /user: json\.user/, '注册后必须把归属写进 config.json')
  assert.match(src, /previousClientId: previousClientId/, '改绑时必须告知服务端解绑哪一个')
})

test('installer skips only when the account matches, never on file existence alone', () => {
  const src = installerSource()
  // 只看文件是否存在会导致换账号后静默沿用旧绑定（Trace 归新账号、纳管归旧账号）
  assert.match(src, /existing\.user === args\.user/, '跳过条件必须比对账号')
  assert.match(src, /检测到账号变更/, '账号变更应有明确日志而非静默')
})
