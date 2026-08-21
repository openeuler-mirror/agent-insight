import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildUpdatedEnvelope,
  defaultEnvelope,
  exportCapabilityYaml,
  mergeCapabilityIntoLocalRasConfig,
  platformSupportsSync,
  toIngestPayload,
  validateCapabilityConfigBody,
} from '@/lib/ingest/ras/capability-config'
import {
  getCapabilityEnvelope,
  saveCapabilityEnvelope,
} from '@/lib/ingest/ras/capability-config-store'

test('validateCapabilityConfigBody accepts defaults and rejects bad thresholds', () => {
  const ok = validateCapabilityConfigBody({
    enabled: true,
    detectors: {
      repeat_tool: { enabled: true, warning_threshold: 5, critical_threshold: 10 },
      llm_thinking_loop: { enabled: true, detection_start_chars: 100 },
    },
    recovery: { notify_user_on_warning: false },
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.config.recovery.notify_user_on_warning, false)
    assert.equal(ok.config.detectors.llm_thinking_loop.detection_start_chars, 100)
    assert.equal(ok.config.detectors.repeat_tool.global_breaker_threshold, 10)
  }

  const bad = validateCapabilityConfigBody({
    detectors: { repeat_tool: { warning_threshold: 1 } },
  })
  assert.equal(bad.ok, false)
})

test('buildUpdatedEnvelope bumps revision only when content changes', () => {
  const base = defaultEnvelope('opencode', new Date('2026-01-01T00:00:00.000Z'))
  const same = buildUpdatedEnvelope(base, { config: base.config, syncEnabled: false }, new Date('2026-01-02T00:00:00.000Z'))
  assert.equal(same.ok, true)
  if (same.ok) assert.equal(same.envelope.revision, 0)

  const next = buildUpdatedEnvelope(
    base,
    { config: { ...base.config, enabled: false }, syncEnabled: true },
    new Date('2026-01-02T00:00:00.000Z'),
  )
  assert.equal(next.ok, true)
  if (next.ok) {
    assert.equal(next.envelope.revision, 1)
    assert.equal(next.envelope.syncEnabled, true)
    assert.equal(next.envelope.config.enabled, false)
  }
})

test('sync platforms and non-sync platforms', () => {
  assert.equal(platformSupportsSync('opencode'), true)
  assert.equal(platformSupportsSync('xiaoo'), true)
  assert.equal(platformSupportsSync('openjiuwen'), false)
  const base = defaultEnvelope('openjiuwen')
  const next = buildUpdatedEnvelope(base, { syncEnabled: true, config: base.config })
  assert.equal(next.ok, true)
  if (next.ok) assert.equal(next.envelope.syncEnabled, false)

  const xiaoo = defaultEnvelope('xiaoo')
  const xiaooNext = buildUpdatedEnvelope(xiaoo, { syncEnabled: true, config: xiaoo.config })
  assert.equal(xiaooNext.ok, true)
  if (xiaooNext.ok) assert.equal(xiaooNext.envelope.syncEnabled, true)
})

test('toIngestPayload hides config when sync disabled', () => {
  const env = defaultEnvelope('opencode')
  env.syncEnabled = false
  env.revision = 3
  const payload = toIngestPayload(env)
  assert.equal(payload.syncEnabled, false)
  assert.equal(payload.config, null)
  assert.equal(payload.revision, 3)

  env.syncEnabled = true
  const on = toIngestPayload(env)
  assert.equal(on.syncEnabled, true)
  assert.ok(on.config)
})

test('mergeCapabilityIntoLocalRasConfig preserves service paths', () => {
  const local = {
    agent_ras: {
      enabled: true,
      service: { transport: 'inproc', python: '/keep/python' },
      insight: { events_url: 'http://x', api_key: 'k' },
      llm_thinking_loop: { detection_start_chars: 200 },
    },
  }
  const body = defaultEnvelope('opencode').config
  body.detectors.llm_thinking_loop.detection_start_chars = 999
  body.enabled = false
  const merged = mergeCapabilityIntoLocalRasConfig(
    local,
    body,
    { revision: 7, updatedAt: '2026-08-07T00:00:00.000Z', contentHash: 'abc123' },
    'opencode',
  )
  const ras = merged.agent_ras as Record<string, unknown>
  assert.equal(ras.enabled, false)
  assert.equal((ras.service as Record<string, unknown>).python, '/keep/python')
  assert.equal(ras.ras_config_revision, undefined)
  assert.equal(ras.ras_config_revisions, undefined)
  assert.equal(ras.llm_thinking_loop, undefined)
  assert.equal(
    (ras.detectors as { llm_thinking_loop: { detection_start_chars: number } }).llm_thinking_loop
      .detection_start_chars,
    999,
  )
  const oc = (
    ras.platforms as {
      opencode: {
        detectors: { llm_thinking_loop: { detection_start_chars: number } }
        syncedFrom: { revision: number; contentHash: string; updatedAt: string }
      }
    }
  ).opencode
  assert.equal(oc.detectors.llm_thinking_loop.detection_start_chars, 999)
  assert.equal(oc.syncedFrom.revision, 7)
  assert.equal(oc.syncedFrom.contentHash, 'abc123')
  assert.equal(oc.syncedFrom.updatedAt, '2026-08-07T00:00:00.000Z')
})

test('capability config store isolates platforms per user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cap-'))
  try {
    const a = getCapabilityEnvelope('alice', 'opencode', dir)
    assert.equal(a.revision, 0)
    a.syncEnabled = true
    a.revision = 2
    a.config.enabled = false
    saveCapabilityEnvelope('alice', a, dir)

    const loaded = getCapabilityEnvelope('alice', 'opencode', dir)
    assert.equal(loaded.revision, 2)
    assert.equal(loaded.config.enabled, false)

    const other = getCapabilityEnvelope('alice', 'openjiuwen', dir)
    assert.equal(other.revision, 0)
    assert.equal(other.config.enabled, true)

    const bob = getCapabilityEnvelope('bob', 'opencode', dir)
    assert.equal(bob.revision, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exportCapabilityYaml includes detector keys', () => {
  const yaml = exportCapabilityYaml(defaultEnvelope('openjiuwen'))
  assert.match(yaml, /llm_thinking_loop:/)
  assert.match(yaml, /repeat_tool:/)
  assert.match(yaml, /notify_user_on_warning:/)
})

test('validate and merge pass through a third detector domain', () => {
  const ok = validateCapabilityConfigBody({
    enabled: true,
    detectors: {
      synth_probe: { enabled: true, threshold: 9 },
    },
    recovery: { notify_user_on_warning: true },
  })
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  assert.equal((ok.config.detectors.synth_probe as { threshold: number }).threshold, 9)

  const merged = mergeCapabilityIntoLocalRasConfig({}, ok.config, { revision: 1 }, 'opencode')
  const ras = merged.agent_ras as {
    detectors: Record<string, Record<string, unknown>>
    platforms: { opencode: { detectors: Record<string, Record<string, unknown>> } }
  }
  assert.equal(ras.detectors.synth_probe.threshold, 9)
  assert.equal(ras.platforms.opencode.detectors.synth_probe.threshold, 9)
})
