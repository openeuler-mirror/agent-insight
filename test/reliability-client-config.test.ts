import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  getClientConfigView,
  listReliabilityClientsForUser,
  putClientConfig,
  recordConfigLoad,
  resetClientConfigStoreForTests,
  syncClientConfig,
  upsertReliabilityClientFromWorker,
} from '@/lib/reliability/client-config-service'

test('builtin schema has design defaults and sections', () => {
  const schema = buildBuiltinConfigSchema('opencode')
  assert.equal(schema.platform, 'opencode')
  assert.equal(schema.editable, false)
  assert.equal(schema.source, 'builtin')
  assert.equal(schema.defaults['enabled'], false)
  assert.equal(schema.defaults['textLoop.enabled'], false)
  assert.ok(schema.sections.some((s) => s.key === 'textLoop'))
  assert.ok(schema.sections.some((s) => s.key === 'toolRepeat'))
})

test('override merge + fieldSources + path delete', () => {
  const schema = buildBuiltinConfigSchema('opencode')
  const override = {
    enabled: true,
    'textLoop.enabled': true,
    'textLoop.repeatThreshold': 6,
  }
  const effectiveFlat = applyOverrideDiff(schema.defaults, override)
  assert.equal(effectiveFlat.enabled, true)
  assert.equal(effectiveFlat['textLoop.repeatThreshold'], 6)
  assert.equal(effectiveFlat['toolRepeat.warningThreshold'], 5)

  const sources = buildFieldSources(schema.defaults, override)
  assert.equal(sources.enabled, 'client_override')
  assert.equal(sources['textLoop.repeatThreshold'], 'client_override')
  assert.equal(sources['toolRepeat.warningThreshold'], 'builtin')

  const nested = nestEffectiveConfig(effectiveFlat)
  assert.equal((nested.textLoop as { repeatThreshold: number }).repeatThreshold, 6)
  assert.deepEqual(flattenEffectiveConfig(nested)['textLoop.repeatThreshold'], 6)

  const afterDelete = deleteOverridePath(override, 'textLoop.repeatThreshold')
  assert.equal(afterDelete['textLoop.repeatThreshold'], undefined)
  assert.equal(afterDelete.enabled, true)
})

test('put/sync/load delivery track with worker-backed client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cli-cfg-'))
  resetClientConfigStoreForTests(dir)
  try {
    const client = upsertReliabilityClientFromWorker({
      user: 'u1',
      workerId: 'w-e2e-1',
      hostname: 'host-a',
      reportedIp: '10.20.3.18',
      lastSeenAt: new Date().toISOString(),
      platforms: [{ id: 'opencode', version: '1.0.0', models: ['m1'] }],
      online: true,
    })
    assert.ok(client.id.startsWith('cli_'))

    const listed = listReliabilityClientsForUser('u1', { keyword: '10.20' })
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].reportedIp, '10.20.3.18')

    const saved = putClientConfig({
      user: 'u1',
      clientId: client.id,
      platform: 'opencode',
      overrideDiff: { enabled: true, 'textLoop.enabled': true },
      sync: false,
    })
    assert.equal(saved.status, 'saved')
    assert.equal(saved.revision, 1)
    assert.ok(!saved.configRef)

    const view = getClientConfigView('u1', client.id, 'opencode')
    assert.equal(view.delivery?.status, 'saved')
    assert.equal(view.overrideDiff.enabled, true)
    assert.equal(view.effectiveConfig.enabled, true)

    const synced = putClientConfig({
      user: 'u1',
      clientId: client.id,
      platform: 'opencode',
      expectedRevision: 1,
      overrideDiff: { enabled: true, 'textLoop.enabled': true, 'textLoop.repeatThreshold': 7 },
      sync: true,
    })
    assert.equal(synced.status, 'sync_notified')
    assert.ok(synced.configRef)
    assert.equal(synced.revision, 2)

    const again = syncClientConfig({
      user: 'u1',
      clientId: client.id,
      platform: 'opencode',
      configRef: synced.configRef!,
    })
    assert.equal(again.status, 'sync_notified')

    const loaded = recordConfigLoad({
      user: 'u1',
      clientId: client.id,
      platform: 'opencode',
      configVersion: synced.configVersion!,
      checksum: synced.checksum!,
      status: 'loaded',
      loadedAt: new Date().toISOString(),
    })
    assert.equal(loaded.deliveryStatus, 'ras_loaded')

    const after = getClientConfigView('u1', client.id, 'opencode')
    assert.equal(after.delivery?.status, 'ras_loaded')
  } finally {
    resetClientConfigStoreForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('offline sync keeps save but marks notify failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cli-off-'))
  resetClientConfigStoreForTests(dir)
  try {
    const client = upsertReliabilityClientFromWorker({
      user: 'u2',
      workerId: 'w-off',
      hostname: 'offline-host',
      reportedIp: '127.0.0.1',
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      platforms: [{ id: 'opencode', version: '1.0.0', models: [] }],
      online: false,
    })
    const result = putClientConfig({
      user: 'u2',
      clientId: client.id,
      platform: 'opencode',
      overrideDiff: { enabled: true },
      sync: true,
    })
    assert.equal(result.saved, true)
    assert.equal(result.sync?.status, 'failed')
    assert.equal(result.sync?.error?.code, 'CLIENT_OFFLINE')
    assert.equal(result.status, 'notify_failed')
  } finally {
    resetClientConfigStoreForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
