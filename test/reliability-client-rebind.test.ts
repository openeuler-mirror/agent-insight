import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'

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

async function bind(user: string, previousClientId?: string, machineId?: string | null) {
  const { installToken } = await createInstallToken({ user, expiresInSeconds: 600 })
  return registerClient({
    installToken,
    hostname: 'same-host',
    reportedIp: '10.0.0.9',
    previousClientId: previousClientId ?? null,
    machineId: machineId === undefined ? MACHINE : machineId,
  })
}

const MACHINE = `machine-${process.pid}`

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

test('installer re-registers in a temporary HOME and does not send an old clientId across base paths', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-client-rebind-'))
  const clientDir = path.join(tempHome, '.agent-insight', 'client')
  const fakeBin = path.join(tempHome, 'bin')
  fs.mkdirSync(clientDir, { recursive: true })
  fs.mkdirSync(fakeBin, { recursive: true })

  for (const command of ['launchctl', 'systemctl']) {
    fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  const requestPaths: string[] = []
  const registerPayloads: Record<string, unknown>[] = []
  const server = http.createServer(async (req, res) => {
    requestPaths.push(req.url || '')
    let raw = ''
    for await (const chunk of req) raw += chunk
    registerPayloads.push(JSON.parse(raw) as Record<string, unknown>)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      user: 'same-user',
      clientId: 'cli_new-base-path',
      deviceCredential: registerPayloads.length === 1 ? 'dc_new-base-path' : 'dc_rotated-base-path',
      reused: registerPayloads.length > 1,
      control: {},
    }))
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const oldBaseUrl = `${origin}/old-insight`
    const newBaseUrl = `${origin}/new-insight`
    fs.writeFileSync(path.join(clientDir, 'config.json'), JSON.stringify({
      insightBaseUrl: oldBaseUrl,
      user: 'same-user',
      clientId: 'cli_old-base-path',
      deviceCredential: 'dc_old-base-path',
    }))

    const installer = path.join(__dirname, '..', 'scripts', 'install-ras-client.js')
    const runInstaller = (token: string) => new Promise<{
      code: number | null
      stdout: string
      stderr: string
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        installer,
        '--host', newBaseUrl,
        '--token', token,
        '--user', 'same-user',
        '--no-start',
        '--no-fi',
      ], {
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
          AGENT_INSIGHT_MACHINE_ID: 'machine-mock-rebind',
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })

    const result = await runInstaller('it_mock-token-1')

    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /检测到平台地址变更/)
    assert.equal(requestPaths[0], '/new-insight/api/reliability/client/v1/register')
    assert.equal(registerPayloads[0]?.previousClientId, null, '同 origin 的不同 basePath 也不能发送旧 clientId')

    const firstConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'))
    assert.equal(firstConfig.insightBaseUrl, newBaseUrl)
    assert.equal(firstConfig.clientId, 'cli_new-base-path')
    assert.equal(firstConfig.deviceCredential, 'dc_new-base-path')

    const repeated = await runInstaller('it_mock-token-2')
    assert.equal(repeated.code, 0, repeated.stderr || repeated.stdout)
    assert.match(repeated.stdout, /正在刷新本机绑定与设备凭证/)
    assert.equal(requestPaths.length, 2, '同账号、同服务基址重装也必须重新注册')
    assert.equal(registerPayloads[1]?.previousClientId, 'cli_new-base-path')
    const refreshedConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'))
    assert.equal(refreshedConfig.deviceCredential, 'dc_rotated-base-path')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------- 机器指纹去重

test('same machine + same account reuses the existing record instead of creating a new one', async () => {
  try {
    const first = await bind(USER_A)
    assert.equal(first.reused, false, '首次注册是新建')

    // 模拟本机 config.json 被删（重装、换磁盘）—— 不传 previousClientId。
    // 没有机器指纹时这里会新建第二条，页面上就会出现两台同名机器。
    const second = await bind(USER_A)
    assert.equal(second.reused, true, '同机同账号必须复用')
    assert.equal(second.clientId, first.clientId, 'clientId 应保持不变')

    const listed = await listClients(USER_A, {})
    assert.equal(listed.items.length, 1, '同一台机器只应有一条记录')
  } finally {
    await cleanup()
  }
})

test('reuse issues a fresh credential and revokes the previous one', async () => {
  try {
    const first = await bind(USER_A)
    const second = await bind(USER_A)
    assert.notEqual(second.deviceCredential, first.deviceCredential, '必须换发新凭证')

    // 安装器拿不回原凭证，留着旧的等于多一把还能用的钥匙。
    await assert.rejects(
      () => authenticateDevice(credentialRequest(first.clientId, first.deviceCredential)),
      (err: Error & { code?: string }) => err.code === 'DEVICE_UNAUTHORIZED',
      '旧凭证必须已撤销',
    )
    const ok = await authenticateDevice(credentialRequest(second.clientId, second.deviceCredential))
    assert.equal(ok.user, USER_A)
  } finally {
    await cleanup()
  }
})

test('A to B to A returns the original record, not a third one', async () => {
  try {
    const a1 = await bind(USER_A)
    const b = await bind(USER_B, a1.clientId)
    assert.notEqual(b.clientId, a1.clientId, '换账号是另一条记录')

    // 绕回 A：应拿回 A 原来那条（配置下发历史不断档），而不是第三个新 id
    const a2 = await bind(USER_A, b.clientId)
    assert.equal(a2.clientId, a1.clientId, 'A 应拿回原记录')
    assert.equal(a2.reused, true)

    const listedA = await listClients(USER_A, {})
    assert.equal(listedA.items.length, 1, 'A 名下不应堆积多条')
    assert.equal(listedA.items[0].status, 'online', '复用后解绑标记应被清掉')
  } finally {
    await cleanup()
  }
})

test('clients without a machine id keep the legacy behaviour', async () => {
  try {
    // 旧版本客户端不上报指纹；NULL 之间互不相等，不能因唯一约束而互相冲突。
    const first = await bind(USER_A, undefined, null)
    const second = await bind(USER_A, undefined, null)
    assert.equal(first.reused, false)
    assert.equal(second.reused, false, '无指纹时无法判定同机，沿用旧行为')
    assert.notEqual(second.clientId, first.clientId)
  } finally {
    await cleanup()
  }
})

test('different machines under one account stay separate', async () => {
  try {
    const m1 = await bind(USER_A, undefined, `${MACHINE}-x`)
    const m2 = await bind(USER_A, undefined, `${MACHINE}-y`)
    assert.notEqual(m2.clientId, m1.clientId, '不同机器必须各自独立')
    const listed = await listClients(USER_A, {})
    assert.equal(listed.items.length, 2)
  } finally {
    await cleanup()
  }
})

test('UI renders unbound distinctly from offline', () => {
  // 「已解绑」是机器改绑走了、不会回来；「离线」只是暂时掉线、等它恢复即可。
  // 混成同一个文案会让人一直干等一台永远不会回来的机器。
  const src = require_('node:fs').readFileSync(
    require_('node:path').join(__dirname, '..', 'src', 'app', '(main)', 'accessconfig', 'client', 'page.tsx'),
    'utf8',
  ) as string
  assert.match(src, /clientStatusView/, '状态展示应走统一 helper')
  assert.match(src, /已解绑/, '必须有「已解绑」文案')
  assert.doesNotMatch(
    src,
    /status === 'online' \? \(isZh \? '在线' : 'online'\) : \(isZh \? '离线' : 'offline'\)/,
    '不得再用「在线/离线」二选一判断',
  )
})
