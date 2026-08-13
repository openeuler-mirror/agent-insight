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
  noteCapabilityIngestPull,
  putClientConfig,
  recordConfigLoad,
  resetClientConfigStoreForTests,
  syncClientConfig,
  upsertReliabilityClientFromWorker,
} from '@/lib/reliability/client-config-service'
import {
  getCapabilityEnvelope,
  resetCapabilityConfigStoreForTests,
} from '@/lib/ingest/ras/capability-config-store'

test('builtin schema has design defaults and sections', () => {
  const schema = buildBuiltinConfigSchema('opencode')
  assert.equal(schema.platform, 'opencode')
  assert.equal(schema.editable, false)
  assert.equal(schema.source, 'builtin')
  assert.equal(schema.defaults['enabled'], true)
  assert.equal(schema.defaults['detectors.llm_thinking_loop.enabled'], true)
  assert.ok(schema.sections.some((s) => s.key === 'detectors.llm_thinking_loop'))
  assert.ok(schema.sections.some((s) => s.key === 'detectors.repeat_tool'))
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
  assert.equal(effectiveFlat['detectors.llm_thinking_loop.loop_repeat_threshold'], 6)
  assert.equal(effectiveFlat['detectors.repeat_tool.warning_threshold'], 5)

  const sources = buildFieldSources(schema.defaults, override)
  assert.equal(sources.enabled, 'client_override')
  assert.equal(sources['detectors.llm_thinking_loop.loop_repeat_threshold'], 'client_override')
  assert.equal(sources['detectors.repeat_tool.warning_threshold'], 'builtin')

  const nested = nestEffectiveConfig(effectiveFlat)
  assert.equal(
    ((nested.detectors as { llm_thinking_loop: { loop_repeat_threshold: number } }).llm_thinking_loop)
      .loop_repeat_threshold,
    6,
  )
  assert.deepEqual(
    flattenEffectiveConfig(nested)['detectors.llm_thinking_loop.loop_repeat_threshold'],
    6,
  )

  const afterDelete = deleteOverridePath(override, 'textLoop.repeatThreshold')
  assert.equal(afterDelete['textLoop.repeatThreshold'], undefined)
  assert.equal(afterDelete.enabled, true)
})

test('put/sync/load delivery track with worker-backed client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cli-cfg-'))
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cap-cfg-'))
  resetClientConfigStoreForTests(dir)
  resetCapabilityConfigStoreForTests(capDir)
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
    assert.equal(synced.status, 'written')
    assert.ok(synced.configRef)
    assert.equal(synced.revision, 2)

    const envelope = getCapabilityEnvelope('u1', 'opencode')
    assert.equal(envelope.syncEnabled, true)
    assert.equal(envelope.config.enabled, true)
    assert.equal(
      (envelope.config.detectors.llm_thinking_loop as { loop_repeat_threshold: number }).loop_repeat_threshold,
      7,
    )
    // 其它平台未被写入
    const xiaooBefore = getCapabilityEnvelope('u1', 'xiaoo')
    assert.equal(xiaooBefore.revision, 0)

    const again = syncClientConfig({
      user: 'u1',
      clientId: client.id,
      platform: 'opencode',
      configRef: synced.configRef!,
    })
    assert.equal(again.status, 'written')

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
    resetCapabilityConfigStoreForTests()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(capDir, { recursive: true, force: true })
  }
})

test('platform configs stay isolated on sync publish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cli-iso-'))
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cap-iso-'))
  resetClientConfigStoreForTests(dir)
  resetCapabilityConfigStoreForTests(capDir)
  try {
    const client = upsertReliabilityClientFromWorker({
      user: 'u-iso',
      workerId: 'w-iso',
      hostname: 'iso-host',
      reportedIp: '10.0.0.2',
      lastSeenAt: new Date().toISOString(),
      platforms: [
        { id: 'opencode', version: '1.0.0', models: [] },
        { id: 'xiaoo', version: '1.0.0', models: [] },
      ],
      online: true,
    })

    putClientConfig({
      user: 'u-iso',
      clientId: client.id,
      platform: 'opencode',
      overrideDiff: { enabled: true, 'toolRepeat.warningThreshold': 3 },
      sync: true,
    })
    putClientConfig({
      user: 'u-iso',
      clientId: client.id,
      platform: 'xiaoo',
      overrideDiff: { enabled: false, 'toolRepeat.warningThreshold': 9, notifyUserOnWarning: true },
      sync: true,
    })

    const oc = getCapabilityEnvelope('u-iso', 'opencode')
    const xo = getCapabilityEnvelope('u-iso', 'xiaoo')
    assert.equal(oc.config.enabled, true)
    assert.equal(xo.config.enabled, false)
    assert.equal(
      (oc.config.detectors.repeat_tool as { warning_threshold: number }).warning_threshold,
      3,
    )
    assert.equal(
      (xo.config.detectors.repeat_tool as { warning_threshold: number }).warning_threshold,
      9,
    )
    assert.equal(
      (xo.config.detectors.llm_thinking_loop as { semantic_content_enabled: boolean }).semantic_content_enabled,
      false,
    )

    const ocView = getClientConfigView('u-iso', client.id, 'opencode')
    const xoView = getClientConfigView('u-iso', client.id, 'xiaoo')
    assert.equal(ocView.delivery?.status, 'written')
    assert.equal(xoView.delivery?.status, 'written')
    assert.notEqual(ocView.delivery?.configRef, xoView.delivery?.configRef)

    // ingest pull 只推进对应平台的 sync_notified → written
    const storePath = path.join(dir, 'u-iso.json')
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    raw.configs[client.id].opencode.delivery.status = 'sync_notified'
    raw.configs[client.id].xiaoo.delivery.status = 'sync_notified'
    fs.writeFileSync(storePath, JSON.stringify(raw))
    noteCapabilityIngestPull('u-iso', 'opencode')
    assert.equal(getClientConfigView('u-iso', client.id, 'opencode').delivery?.status, 'written')
    assert.equal(getClientConfigView('u-iso', client.id, 'xiaoo').delivery?.status, 'sync_notified')
  } finally {
    resetClientConfigStoreForTests()
    resetCapabilityConfigStoreForTests()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(capDir, { recursive: true, force: true })
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
