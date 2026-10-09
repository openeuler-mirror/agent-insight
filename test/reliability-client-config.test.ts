import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyOverrideDiff,
  buildBuiltinConfigSchema,
  buildFieldSources,
  deleteOverridePath,
  flattenEffectiveConfig,
  nestEffectiveConfig,
} from '@/lib/reliability/client-config-model'
import {
  deleteClientConfig,
  getClientConfigView,
  getConfigSnapshot,
  markDeliveryWritten,
  putClientConfig,
  recordConfigLoad,
  syncClientConfig,
} from '@/lib/reliability/client-config-service'
import {
  createInstallToken,
  listClients,
  registerClient,
  updateCapabilities,
} from '@/lib/reliability/client-registry'
import { resetControlHubForTests, setPresence } from '@/lib/reliability/control-hub'
import { prismaRaw } from '@/lib/storage/prisma'
import {
  getCapabilityEnvelope,
  resetCapabilityConfigStoreForTests,
} from '@/lib/ingest/ras/capability-config-store'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const daemon = createRequire(import.meta.url)('../scripts/reliability-client.cjs') as {
  configTargetPath: (platform: string, scope: string) => string
  executeAction: (
    cfg: Record<string, unknown>,
    frame: Record<string, unknown>,
    sendStatus: (status: string, extra: { result?: Record<string, unknown> }) => Promise<void>,
  ) => Promise<void>
}
const FAULT_MODE_SERVICE_URL = 'inference.fault_mode_classification_service_url'

function getByPath(obj: unknown, pathKey: string): unknown {
  return pathKey.split('.').reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== 'object' || Array.isArray(acc)) return undefined
    return (acc as Record<string, unknown>)[part]
  }, obj)
}

function pickNumericDetectorPath(defaults: Record<string, unknown>): {
  path: string
  builtin: number
  overrideValue: number
} {
  for (const [key, value] of Object.entries(defaults)) {
    if (!key.startsWith('detectors.') || key.endsWith('.enabled')) continue
    if (key.split('.').length !== 3) continue
    if (typeof value === 'number' && Number.isInteger(value)) {
      return { path: key, builtin: value, overrideValue: value + 1 }
    }
  }
  throw new Error('expected a numeric detectors.<id>.<field> default')
}

function pickOtherBuiltinPath(
  defaults: Record<string, unknown>,
  usedPath: string,
): string {
  const other = Object.keys(defaults).find(
    (key) => key.startsWith('detectors.') && key !== usedPath && !key.endsWith('.enabled'),
  )
  if (!other) throw new Error('expected a second detectors.* default path')
  return other
}

// ---------------------------------------------------------------- pure model

test('builtin schema has design defaults and sections', () => {
  const schema = buildBuiltinConfigSchema('opencode')
  assert.equal(schema.platform, 'opencode')
  assert.equal(schema.editable, false)
  assert.equal(schema.source, 'builtin')
  assert.equal(schema.defaults['enabled'], true)
  const detectorSections = schema.sections.filter((s) => s.key.startsWith('detectors.'))
  assert.ok(detectorSections.length > 0)
  for (const section of detectorSections) {
    assert.ok(section.enabledField?.startsWith(`${section.key}.`))
    assert.equal(typeof schema.defaults[section.enabledField!], 'boolean')
  }
})

test('override merge + fieldSources + path delete', () => {
  const schema = buildBuiltinConfigSchema('opencode')
  const picked = pickNumericDetectorPath(schema.defaults)
  const otherPath = pickOtherBuiltinPath(schema.defaults, picked.path)
  const override = {
    enabled: true,
    [picked.path]: picked.overrideValue,
  }
  const effectiveFlat = applyOverrideDiff(schema.defaults, override)
  assert.equal(effectiveFlat.enabled, true)
  assert.equal(effectiveFlat[picked.path], picked.overrideValue)
  assert.equal(effectiveFlat[otherPath], schema.defaults[otherPath])

  const sources = buildFieldSources(schema.defaults, override)
  assert.equal(sources.enabled, 'client_override')
  assert.equal(sources[picked.path], 'client_override')
  assert.equal(sources[otherPath], 'builtin')

  const nested = nestEffectiveConfig(effectiveFlat)
  assert.equal(getByPath(nested, picked.path), picked.overrideValue)
  assert.deepEqual(flattenEffectiveConfig(nested)[picked.path], picked.overrideValue)

  const afterDelete = deleteOverridePath(override, picked.path)
  assert.equal(afterDelete[picked.path], undefined)
  assert.equal(afterDelete.enabled, true)
})

// ---------------------------------------------------------------- helpers

const TEST_USER = `ras-test-${process.pid}`

async function newClient(opts?: { online?: boolean }) {
  const { installToken } = await createInstallToken({ user: TEST_USER, expiresInSeconds: 600 })
  const registered = await registerClient({
    installToken,
    hostname: 'test-host',
    reportedIp: '10.20.3.18',
    os: 'linux',
    arch: 'x64',
    capabilities: { platforms: [{ id: 'opencode', models: ['m1'] }] },
  })
  if (opts?.online !== false) {
    setPresence(registered.clientId, true)
  } else {
    // 真正的「离线」= 心跳也停了。只清 WSS presence 不算离线：
    // 无控制网关的部署（start.sh）本就没有 WSS，客户端靠长轮询取指令。
    await prismaRaw.reliabilityClient.updateMany({
      where: { clientId: registered.clientId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    })
  }
  return registered
}

async function cleanup() {
  resetControlHubForTests()
  await prismaRaw.reliabilityConfigLoad.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityConfigDelivery.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityConfigSnapshot.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityClientConfig.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityCommand.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityClientCredential.deleteMany({
    where: { client: { user: TEST_USER } },
  })
  await prismaRaw.reliabilityClient.deleteMany({ where: { user: TEST_USER } })
  await prismaRaw.reliabilityInstallToken.deleteMany({ where: { user: TEST_USER } })
}

// ---------------------------------------------------------------- registration

test('fault mode classification URL sync writes and clears the selected client platform file', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-classifier-cap-'))
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-classifier-client-'))
  const runtimeHome = path.join(clientHome, 'ras')
  const previousClientHome = process.env.AGENT_INSIGHT_HOME
  const previousRasHome = process.env.AGENT_INSIGHT_RAS_HOME
  process.env.AGENT_INSIGHT_HOME = clientHome
  process.env.AGENT_INSIGHT_RAS_HOME = runtimeHome
  resetCapabilityConfigStoreForTests(capDir)
  const server = createServer((req, res) => {
    void (async () => {
      const configRef = decodeURIComponent((req.url || '').split('/').pop() || '')
      const snapshot = await getConfigSnapshot({
        clientId: String(req.headers['x-agent-insight-client-id']),
        configRef,
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(snapshot))
    })().catch((error: Error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error.message }))
    })
  })
  try {
    const client = await newClient()
    const initial = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(getByPath(initial.effectiveConfig, FAULT_MODE_SERVICE_URL), '')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const cfg = {
      insightBaseUrl: `http://127.0.0.1:${address.port}`,
      clientId: client.clientId,
      deviceCredential: client.deviceCredential,
    }
    const peerFile = daemon.configTargetPath('xiaoo', 'client')
    const peerContents = JSON.stringify({ config: { inference: { fault_mode_classification_service_url: 'https://peer.example/classify' } } })
    fs.mkdirSync(path.dirname(peerFile), { recursive: true })
    fs.writeFileSync(peerFile, peerContents)
    for (const url of ['https://classifier.example/v1/classify', '']) {
      const synced = await putClientConfig({
        user: TEST_USER,
        clientId: client.clientId,
        platform: 'opencode',
        overrideDiff: url ? { [FAULT_MODE_SERVICE_URL]: url } : {},
        sync: true,
      })
      assert.equal(synced.status, 'sync_notified')
      const statuses: string[] = []
      await daemon.executeAction(cfg, {
        action: 'APPLY_CLIENT_CONFIG',
        payload: { platform: 'opencode', configRef: synced.configRef, configVersion: synced.configVersion, checksum: synced.checksum },
      }, async (status, extra) => {
        statuses.push(status)
        if (status === 'SUCCEEDED') {
          assert.equal(extra.result?.state, 'WRITTEN')
          await markDeliveryWritten({ clientId: client.clientId, configRef: String(extra.result?.configRef) })
        }
      })
      assert.deepEqual(statuses, ['RUNNING', 'SUCCEEDED'])
      const written = JSON.parse(fs.readFileSync(daemon.configTargetPath('opencode', 'client'), 'utf8'))
      assert.equal(written.clientId, client.clientId)
      assert.equal(written.platform, 'opencode')
      assert.equal(written.configVersion, synced.configVersion)
      assert.equal(getByPath(written.config, FAULT_MODE_SERVICE_URL), url)
      assert.equal(getByPath(written.config, 'inference.faultModeClassificationServiceUrl'), undefined)
      assert.equal((await getClientConfigView(TEST_USER, client.clientId, 'opencode')).delivery.status, 'written')
    }
    assert.equal(fs.existsSync(peerFile) ? fs.readFileSync(peerFile, 'utf8') : null, peerContents)
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousClientHome === undefined) delete process.env.AGENT_INSIGHT_HOME
    else process.env.AGENT_INSIGHT_HOME = previousClientHome
    if (previousRasHome === undefined) delete process.env.AGENT_INSIGHT_RAS_HOME
    else process.env.AGENT_INSIGHT_RAS_HOME = previousRasHome
    resetCapabilityConfigStoreForTests()
    fs.rmSync(capDir, { recursive: true, force: true })
    fs.rmSync(clientHome, { recursive: true, force: true })
    await cleanup()
  }
})

test('invalid fault mode classification URL is rejected before configuration is saved', async () => {
  try {
    const client = await newClient()
    await assert.rejects(putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { [FAULT_MODE_SERVICE_URL]: 'ftp://classifier.example' },
      sync: true,
    }), { code: 'CONFIG_FIELD_INVALID' })
    const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(view.revision, 0)
    assert.deepEqual(view.overrideDiff, {})
    assert.equal(view.delivery.configRef, null)
  } finally {
    await cleanup()
  }
})

test('saved camel-case classification URL is preserved and resaved with a snake-case key', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-classifier-rename-'))
  resetCapabilityConfigStoreForTests(capDir)
  try {
    const client = await newClient()
    const legacyKey = 'inference.faultModeClassificationServiceUrl'
    const url = 'https://classifier.example/classify'
    await prismaRaw.reliabilityClientConfig.create({
      data: { clientId: client.clientId, user: TEST_USER, platform: 'opencode', overrideJson: JSON.stringify({ [legacyKey]: url }) },
    })
    const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(getByPath(view.effectiveConfig, FAULT_MODE_SERVICE_URL), url)
    assert.deepEqual(view.overrideDiff, { [FAULT_MODE_SERVICE_URL]: url })
    assert.equal(view.fieldSources[FAULT_MODE_SERVICE_URL], 'client_override')
    const synced = await putClientConfig({ user: TEST_USER, clientId: client.clientId, platform: 'opencode', sync: true })
    const snapshot = await getConfigSnapshot({ clientId: client.clientId, configRef: synced.configRef! })
    assert.equal(getByPath(snapshot.config, FAULT_MODE_SERVICE_URL), url)
    assert.equal(getByPath(snapshot.config, legacyKey), undefined)
    const saved = await prismaRaw.reliabilityClientConfig.findUniqueOrThrow({ where: { clientId_platform: { clientId: client.clientId, platform: 'opencode' } } })
    assert.deepEqual(JSON.parse(saved.overrideJson), { [FAULT_MODE_SERVICE_URL]: url })
    await deleteClientConfig({ user: TEST_USER, clientId: client.clientId, platform: 'opencode', path: legacyKey })
    assert.equal(getByPath((await getClientConfigView(TEST_USER, client.clientId, 'opencode')).effectiveConfig, FAULT_MODE_SERVICE_URL), '')
  } finally {
    resetCapabilityConfigStoreForTests()
    fs.rmSync(capDir, { recursive: true, force: true })
    await cleanup()
  }
})

test('camel-case URL submissions are validated and the snake-case key takes precedence', async () => {
  try {
    const client = await newClient()
    const legacyKey = 'inference.faultModeClassificationServiceUrl'
    await assert.rejects(putClientConfig({ user: TEST_USER, clientId: client.clientId, platform: 'opencode', overrideDiff: { [legacyKey]: 'ftp://classifier.example' } }), { code: 'CONFIG_FIELD_INVALID' })
    for (const overrideDiff of [
      { [legacyKey]: 'https://classifier.example/classify' },
      { [legacyKey]: 'https://classifier.example/classify', [FAULT_MODE_SERVICE_URL]: '' },
    ]) {
      await putClientConfig({ user: TEST_USER, clientId: client.clientId, platform: 'opencode', overrideDiff })
      const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
      const expected = overrideDiff[FAULT_MODE_SERVICE_URL] ?? overrideDiff[legacyKey]
      assert.equal(getByPath(view.effectiveConfig, FAULT_MODE_SERVICE_URL), expected)
      assert.deepEqual(view.overrideDiff, { [FAULT_MODE_SERVICE_URL]: expected })
    }
  } finally {
    await cleanup()
  }
})

test('install token is single-use and expires', async () => {
  try {
    const { installToken } = await createInstallToken({ user: TEST_USER, expiresInSeconds: 600 })
    const first = await registerClient({ installToken, hostname: 'h1' })
    assert.ok(first.clientId.startsWith('cli_'))
    assert.ok(first.deviceCredential.startsWith('dc_'))

    await assert.rejects(
      () => registerClient({ installToken, hostname: 'h2' }),
      (err: Error & { code?: string }) => err.code === 'INSTALL_TOKEN_USED',
    )

    const expired = await createInstallToken({ user: TEST_USER, expiresInSeconds: 60 })
    await prismaRaw.reliabilityInstallToken.updateMany({
      where: { user: TEST_USER, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await assert.rejects(
      () => registerClient({ installToken: expired.installToken }),
      (err: Error & { code?: string }) => err.code === 'INSTALL_TOKEN_EXPIRED',
    )
  } finally {
    await cleanup()
  }
})

test('device credential is stored hashed only', async () => {
  try {
    const client = await newClient()
    const rows = await prismaRaw.reliabilityClientCredential.findMany({
      where: { clientId: client.clientId },
    })
    assert.equal(rows.length, 1)
    // 明文绝不能落库。
    assert.notEqual(rows[0].credentialHash, client.deviceCredential)
    assert.equal(rows[0].credentialHash.length, 64)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------- delivery truth

test('sync stops at sync_notified — server never claims written on its own', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cap-'))
  resetCapabilityConfigStoreForTests(capDir)
  const picked = pickNumericDetectorPath(buildBuiltinConfigSchema('opencode').defaults)
  try {
    const client = await newClient()

    const saved = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: false,
    })
    assert.equal(saved.status, 'saved')
    assert.equal(saved.revision, 1)

    const synced = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      expectedRevision: 1,
      overrideDiff: { enabled: true, [picked.path]: picked.overrideValue },
      sync: true,
    })
    // 关键回归：服务端只到「已通知」，不得代客户端宣布已写入。
    assert.equal(synced.status, 'sync_notified')
    assert.ok(synced.configRef)

    const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(view.delivery.status, 'sync_notified')
    assert.equal(view.delivery.writtenAt, null)
    assert.equal(view.delivery.pulledAt, null)

    // 客户端拉取 → pulling
    await getConfigSnapshot({ clientId: client.clientId, configRef: synced.configRef! })
    const pulled = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(pulled.delivery.status, 'pulling')
    assert.ok(pulled.delivery.pulledAt)
    assert.equal(pulled.delivery.writtenAt, null)

    // 客户端回执 WRITTEN → written
    await markDeliveryWritten({ clientId: client.clientId, configRef: synced.configRef! })
    const written = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(written.delivery.status, 'written')
    assert.ok(written.delivery.writtenAt)
    assert.equal(written.delivery.loadedAt, null)

    // RAS 回报 → ras_loaded
    const loaded = await recordConfigLoad({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      configVersion: synced.configVersion!,
      checksum: synced.checksum!,
      status: 'loaded',
    })
    assert.equal(loaded.deliveryStatus, 'ras_loaded')
    const after = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(after.delivery.status, 'ras_loaded')
    assert.ok(after.delivery.loadedAt)

    // 兼容拉取通道仍收到生效配置
    const envelope = getCapabilityEnvelope(TEST_USER, 'opencode')
    assert.equal(envelope.syncEnabled, true)
    assert.equal(getByPath(envelope.config, picked.path), picked.overrideValue)
  } finally {
    resetCapabilityConfigStoreForTests()
    fs.rmSync(capDir, { recursive: true, force: true })
    await cleanup()
  }
})

test('offline client keeps the save but reports notify failure', async () => {
  try {
    const client = await newClient({ online: false })
    const result = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    assert.equal(result.saved, true)
    assert.equal(result.status, 'notify_failed')
    assert.equal(result.sync?.error?.code, 'CLIENT_OFFLINE')
    assert.equal(result.httpStatus, 200)

    // 离线不排队：不得创建待重连自动执行的指令。
    const commands = await prismaRaw.reliabilityCommand.findMany({
      where: { clientId: client.clientId },
    })
    assert.equal(commands.length, 0)
  } finally {
    await cleanup()
  }
})

test('revision conflict is rejected with current revision', async () => {
  try {
    const client = await newClient()
    await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: false,
    })
    await assert.rejects(
      () =>
        putClientConfig({
          user: TEST_USER,
          clientId: client.clientId,
          platform: 'opencode',
          expectedRevision: 99,
          overrideDiff: { enabled: false },
          sync: false,
        }),
      (err: Error & { code?: string; details?: { revision?: number } }) =>
        err.code === 'CONFIG_REVISION_CONFLICT' && err.details?.revision === 1,
    )
  } finally {
    await cleanup()
  }
})

test('restore default deletes the override path', async () => {
  const schema = buildBuiltinConfigSchema('opencode')
  const picked = pickNumericDetectorPath(schema.defaults)
  try {
    const client = await newClient()
    await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true, [picked.path]: picked.overrideValue },
      sync: false,
    })
    await deleteClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      path: picked.path,
      sync: false,
    })
    const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(view.overrideDiff[picked.path], undefined)
    assert.equal(view.overrideDiff.enabled, true)
    assert.equal(view.fieldSources[picked.path], 'builtin')
    assert.equal(getByPath(view.effectiveConfig, picked.path), picked.builtin)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------- snapshot binding

test('snapshot is bound to its client and rejects cross-client pulls', async () => {
  try {
    const a = await newClient()
    const b = await newClient()
    const synced = await putClientConfig({
      user: TEST_USER,
      clientId: a.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    assert.ok(synced.configRef)

    await assert.rejects(
      () => getConfigSnapshot({ clientId: b.clientId, configRef: synced.configRef! }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'CONFIG_SNAPSHOT_FORBIDDEN' && err.status === 403,
    )

    await assert.rejects(
      () => getConfigSnapshot({ clientId: a.clientId, configRef: 'cfgref_does_not_exist' }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'CONFIG_SNAPSHOT_NOT_FOUND' && err.status === 404,
    )

    await prismaRaw.reliabilityConfigSnapshot.update({
      where: { configRef: synced.configRef! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await assert.rejects(
      () => getConfigSnapshot({ clientId: a.clientId, configRef: synced.configRef! }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'CONFIG_SNAPSHOT_EXPIRED' && err.status === 410,
    )
  } finally {
    await cleanup()
  }
})

test('config load with mismatched version marks delivery version_mismatch', async () => {
  try {
    const client = await newClient()
    const synced = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    const result = await recordConfigLoad({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      configVersion: 'cfg_some_stale_version',
      status: 'loaded',
    })
    assert.equal(result.deliveryStatus, 'version_mismatch')
    const view = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    assert.equal(view.delivery.status, 'version_mismatch')
    assert.notEqual(view.delivery.configVersion, 'cfg_some_stale_version')
    assert.equal(view.delivery.configVersion, synced.configVersion)
  } finally {
    await cleanup()
  }
})

test('platform configs stay isolated', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cap-iso-'))
  resetCapabilityConfigStoreForTests(capDir)
  const picked = pickNumericDetectorPath(buildBuiltinConfigSchema('opencode').defaults)
  try {
    const client = await newClient()
    await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true, [picked.path]: picked.overrideValue },
      sync: true,
    })
    await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'xiaoo',
      overrideDiff: { enabled: false, [picked.path]: picked.overrideValue + 2 },
      sync: true,
    })

    const oc = getCapabilityEnvelope(TEST_USER, 'opencode')
    const xo = getCapabilityEnvelope(TEST_USER, 'xiaoo')
    assert.equal(oc.config.enabled, true)
    assert.equal(xo.config.enabled, false)
    assert.equal(getByPath(oc.config, picked.path), picked.overrideValue)
    assert.equal(getByPath(xo.config, picked.path), picked.overrideValue + 2)

    const ocView = await getClientConfigView(TEST_USER, client.clientId, 'opencode')
    const xoView = await getClientConfigView(TEST_USER, client.clientId, 'xiaoo')
    assert.notEqual(ocView.delivery.configRef, xoView.delivery.configRef)
  } finally {
    resetCapabilityConfigStoreForTests()
    fs.rmSync(capDir, { recursive: true, force: true })
    await cleanup()
  }
})

test('sync reuses the frozen snapshot without bumping revision', async () => {
  try {
    const client = await newClient()
    const first = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    const again = await syncClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      configRef: first.configRef,
    })
    assert.equal(again.configRef, first.configRef)
    assert.equal(again.configVersion, first.configVersion)
    assert.equal(again.revision, first.revision)
  } finally {
    await cleanup()
  }
})

test('offline client rejects re-notify with CLIENT_OFFLINE', async () => {
  try {
    const client = await newClient()
    const first = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    // WSS 断开 + 心跳超时才是真离线；只断 WSS 时长轮询仍可取指令。
    setPresence(client.clientId, false)
    await prismaRaw.reliabilityClient.updateMany({
      where: { clientId: client.clientId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    })
    await assert.rejects(
      () =>
        syncClientConfig({
          user: TEST_USER,
          clientId: client.clientId,
          platform: 'opencode',
          configRef: first.configRef,
        }),
      (err: Error & { code?: string; status?: number }) =>
        err.code === 'CLIENT_OFFLINE' && err.status === 503,
    )
  } finally {
    await cleanup()
  }
})

test('clients list reflects registered client and scopes by user', async () => {
  try {
    const client = await newClient()
    const listed = await listClients(TEST_USER, { keyword: '10.20' })
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].id, client.clientId)
    assert.equal(listed.items[0].reportedIp, '10.20.3.18')
    assert.equal(listed.items[0].status, 'online')

    const otherUser = await listClients(`${TEST_USER}-other`, {})
    assert.equal(otherUser.total, 0)
  } finally {
    await cleanup()
  }
})

test('capability revisions differing across restarts are not treated as replays', async () => {
  try {
    const client = await newClient()
    // 首轮上报
    await updateCapabilities({
      clientId: client.clientId,
      revision: 'cap_epochA_1',
      capabilities: { platforms: [{ id: 'opencode', models: ['m1'] }] },
    })
    let listed = await listClients(TEST_USER, {})
    assert.deepEqual(listed.items[0].platforms.map((p) => p.id), ['opencode'])

    // 同 revision 重放：幂等，不改动
    await updateCapabilities({
      clientId: client.clientId,
      revision: 'cap_epochA_1',
      capabilities: { platforms: [] },
    })
    listed = await listClients(TEST_USER, {})
    assert.deepEqual(listed.items[0].platforms.map((p) => p.id), ['opencode'], '重放必须幂等')

    // 客户端重启后 revision 前缀变化 → 必须被接受，否则 platforms 永远停在旧值
    await updateCapabilities({
      clientId: client.clientId,
      revision: 'cap_epochB_1',
      capabilities: { platforms: [{ id: 'opencode', models: [] }, { id: 'xiaoo', models: [] }] },
    })
    listed = await listClients(TEST_USER, {})
    assert.deepEqual(listed.items[0].platforms.map((p) => p.id), ['opencode', 'xiaoo'])
  } finally {
    await cleanup()
  }
})

test('offline client reports unknown service health, not a stale healthy', async () => {
  try {
    const client = await newClient()
    let listed = await listClients(TEST_USER, {})
    assert.equal(listed.items[0].status, 'online')
    assert.equal(listed.items[0].serviceHealth, 'healthy')

    // 客户端进程消失：心跳停更，serviceHealth 会冻结在最后一次的值。
    await prismaRaw.reliabilityClient.updateMany({
      where: { clientId: client.clientId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    })
    listed = await listClients(TEST_USER, {})
    assert.equal(listed.items[0].status, 'offline')
    // 不能同时显示「离线」和「healthy」——进程没了，健康度就是未知。
    assert.equal(listed.items[0].serviceHealth, 'unknown')
  } finally {
    await cleanup()
  }
})

test('client without WSS still gets commands when heartbeat is fresh', async () => {
  try {
    // start.sh 直接跑 Next standalone，没有控制网关 → 永远没有 WSS presence。
    // 这时只要心跳新鲜就必须能下发，否则该部署形态永远配不了。
    const client = await newClient()
    setPresence(client.clientId, false)

    const result = await putClientConfig({
      user: TEST_USER,
      clientId: client.clientId,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    assert.equal(result.status, 'sync_notified', '无 WSS 也应创建指令')
    assert.ok(result.commandId, '指令必须存在，供长轮询取走')

    // 指令确实进了队列，等着 commands/next 来取。
    const queued = await prismaRaw.reliabilityCommand.findMany({
      where: { clientId: client.clientId },
    })
    assert.equal(queued.length, 1)
  } finally {
    await cleanup()
  }
})
