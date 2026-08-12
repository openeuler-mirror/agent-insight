import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

async function loadSyncMod() {
  return import(
    pathToFileURL(
      path.resolve('agent_ras/platform_adapter/opencode/config_sync.js'),
    ).href
  )
}

test('resolveRasConfigUrl rewrites ras-events to ras-config', async () => {
  const { resolveRasConfigUrl } = await loadSyncMod()
  assert.equal(
    resolveRasConfigUrl({ events_url: 'http://127.0.0.1:3000/api/ingest/ras-events' }),
    'http://127.0.0.1:3000/api/ingest/ras-config',
  )
})

test('syncCapabilityConfigFromInsight merges on content fingerprint mismatch', async () => {
  const { syncCapabilityConfigFromInsight } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agent_ras: {
        enabled: true,
        service: { python: '/keep/me' },
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'test-key',
        },
        ras_config_revision: 1,
        ras_config_revisions: { opencode: 1 },
      },
    }),
    'utf8',
  )

  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          syncEnabled: true,
          revision: 3,
          updatedAt: '2026-08-07T01:00:00.000Z',
          config: {
            enabled: false,
            detectors: {
              repeat_tool: {
                enabled: true,
                warning_threshold: 5,
                critical_threshold: 10,
                global_breaker_threshold: 10,
                unknown_tool_threshold: 10,
              },
              llm_thinking_loop: {
                enabled: true,
                detection_start_chars: 500,
                window_max_chars: 2000,
                loop_repeat_threshold: 5,
                similar_clause_sim_threshold: 0.95,
                semantic_eval_chars: 10000,
                semantic_content_enabled: true,
              },
            },
            recovery: { notify_user_on_warning: false },
          },
        }
      },
    }),
  })

  assert.equal(result.applied, true)
  assert.equal(result.reason, 'merged')
  assert.equal(result.revision, 3)
  assert.ok(result.contentHash)
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(saved.agent_ras.enabled, false)
  assert.equal(saved.agent_ras.service.python, '/keep/me')
  assert.equal(saved.agent_ras.ras_config_revision, undefined)
  assert.equal(saved.agent_ras.ras_config_revisions, undefined)
  assert.equal(saved.agent_ras.detectors.llm_thinking_loop.detection_start_chars, 500)
  assert.equal(
    saved.agent_ras.platforms.opencode.detectors.llm_thinking_loop.detection_start_chars,
    500,
  )
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.revision, 3)
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.updatedAt, '2026-08-07T01:00:00.000Z')
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.contentHash, result.contentHash)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncCapabilityConfigFromInsight applies on local content drift', async () => {
  const { syncCapabilityConfigFromInsight } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'test-key',
        },
        detectors: {
          repeat_tool: { enabled: true, warning_threshold: 5 },
          llm_thinking_loop: {
            detection_start_chars: 500,
            window_max_chars: 10000,
            semantic_eval_chars: 10000,
          },
        },
        recovery: { notify_user_on_warning: true },
      },
    }),
    'utf8',
  )

  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          syncEnabled: true,
          revision: 3,
          config: {
            enabled: true,
            detectors: {
              repeat_tool: { enabled: true, warning_threshold: 5 },
              llm_thinking_loop: {
                detection_start_chars: 300,
                window_max_chars: 1000,
                semantic_eval_chars: 2000,
              },
            },
            recovery: { notify_user_on_warning: true },
          },
        }
      },
    }),
  })

  assert.equal(result.applied, true)
  assert.equal(result.reason, 'content_drift')
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(
    saved.agent_ras.platforms.opencode.detectors.llm_thinking_loop.detection_start_chars,
    300,
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncCapabilityConfigFromInsight skips when fingerprint already matches', async () => {
  const { syncCapabilityConfigFromInsight, capabilityContentHash } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  const configPath = path.join(dir, 'config.json')
  const config = {
    enabled: true,
    detectors: {
      repeat_tool: { enabled: true, warning_threshold: 5 },
      llm_thinking_loop: { detection_start_chars: 300 },
    },
    recovery: { notify_user_on_warning: true },
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'test-key',
        },
        platforms: {
          opencode: {
            ...config,
            syncedFrom: { contentHash: 'stale', revision: 1 },
          },
        },
      },
    }),
    'utf8',
  )

  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { syncEnabled: true, revision: 99, config }
      },
    }),
  })

  assert.equal(result.applied, false)
  assert.equal(result.reason, 'already_current')
  assert.equal(result.contentHash, capabilityContentHash(config))
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  // No rewrite — syncedFrom stays stale until a real content change.
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.contentHash, 'stale')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncCapabilityConfigFromInsight keeps peer platform slices', async () => {
  const { syncCapabilityConfigFromInsight } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'k',
        },
        ras_config_revisions: { xiaoo: 4 },
        platforms: {
          xiaoo: {
            enabled: true,
            detectors: {
              repeat_tool: {},
              llm_thinking_loop: { detection_start_chars: 300 },
            },
            recovery: { notify_user_on_warning: false },
            syncedFrom: { contentHash: 'xiaoo-hash', revision: 4 },
          },
        },
      },
    }),
    'utf8',
  )

  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    platform: 'opencode',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          syncEnabled: true,
          revision: 3,
          config: {
            enabled: true,
            detectors: {
              repeat_tool: { warning_threshold: 5 },
              llm_thinking_loop: { detection_start_chars: 300 },
            },
            recovery: { notify_user_on_warning: true },
          },
        }
      },
    }),
  })

  assert.equal(result.applied, true)
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(saved.agent_ras.ras_config_revisions, undefined)
  assert.equal(saved.agent_ras.platforms.xiaoo.syncedFrom.contentHash, 'xiaoo-hash')
  assert.equal(
    saved.agent_ras.platforms.xiaoo.detectors.llm_thinking_loop.detection_start_chars,
    300,
  )
  assert.equal(
    saved.agent_ras.platforms.opencode.recovery.notify_user_on_warning,
    true,
  )
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.revision, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncCapabilityConfigFromInsight migrates legacy revision map when content matches', async () => {
  const { syncCapabilityConfigFromInsight, capabilityContentHash } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  const configPath = path.join(dir, 'config.json')
  const config = {
    enabled: true,
    detectors: {
      repeat_tool: { enabled: true, warning_threshold: 5 },
      llm_thinking_loop: { detection_start_chars: 300 },
    },
    recovery: { notify_user_on_warning: true },
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'test-key',
        },
        ras_config_revisions: { opencode: 3 },
        platforms: { opencode: { ...config } },
      },
    }),
    'utf8',
  )

  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          syncEnabled: true,
          revision: 3,
          updatedAt: '2026-08-07T03:00:00.000Z',
          config,
        }
      },
    }),
  })

  assert.equal(result.applied, true)
  assert.equal(result.reason, 'layout_migrate')
  assert.equal(result.contentHash, capabilityContentHash(config))
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(saved.agent_ras.ras_config_revisions, undefined)
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.contentHash, result.contentHash)
  assert.equal(saved.agent_ras.platforms.opencode.syncedFrom.revision, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncCapabilityConfigFromInsight skips when sync disabled', async () => {
  const { syncCapabilityConfigFromInsight } = await loadSyncMod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: 'http://example.test/api/ingest/ras-events',
          api_key: 'k',
        },
      },
    }),
    'utf8',
  )
  const result = await syncCapabilityConfigFromInsight({
    rasHome: dir,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { syncEnabled: false, revision: 9, config: null }
      },
    }),
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'sync_disabled_or_empty')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('defaultRasConfigFetch to closed loopback finishes within 5s', async () => {
  const { defaultRasConfigFetch, RAS_CONFIG_CURL_MAX_S } = await loadSyncMod()
  assert.ok(RAS_CONFIG_CURL_MAX_S <= 3)
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())))
  const url = `http://127.0.0.1:${port}/api/ingest/ras-config?platform=opencode`
  const started = Date.now()
  await assert.rejects(() => defaultRasConfigFetch(url, { method: 'GET' }))
  const elapsed = Date.now() - started
  assert.ok(
    elapsed < 5000,
    `loopback curl must fail-open quickly, took ${elapsed}ms (limit 5000ms)`,
  )
})

test('syncCapabilityConfigFromInsight fail-opens when loopback Insight is down', async () => {
  const { syncCapabilityConfigFromInsight } = await loadSyncMod()
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-sync-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      agent_ras: {
        insight: {
          enabled: true,
          events_url: `http://127.0.0.1:${port}/api/ingest/ras-events`,
          api_key: 'test-key',
        },
      },
    }),
    'utf8',
  )

  const started = Date.now()
  const result = await syncCapabilityConfigFromInsight({ rasHome: dir })
  const elapsed = Date.now() - started
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'exception')
  assert.ok(
    elapsed < 5000,
    `sync must fail-open within 5s when Insight is down, took ${elapsed}ms`,
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mergeCapabilityIntoLocalRasConfig is pure', async () => {
  const { mergeCapabilityIntoLocalRasConfig } = await loadSyncMod()
  const merged = mergeCapabilityIntoLocalRasConfig(
    { agent_ras: { service: { x: 1 }, ras_config_revisions: { opencode: 9 } } },
    {
      enabled: true,
      detectors: {
        repeat_tool: { enabled: false },
        llm_thinking_loop: { enabled: true },
      },
      recovery: { notify_user_on_warning: true },
    },
    { revision: 2, updatedAt: '2026-01-01T00:00:00.000Z', contentHash: 'abc' },
    'opencode',
  )
  assert.equal(merged.agent_ras.ras_config_revision, undefined)
  assert.equal(merged.agent_ras.ras_config_revisions, undefined)
  assert.equal(merged.agent_ras.platforms.opencode.detectors.llm_thinking_loop.enabled, true)
  assert.equal(merged.agent_ras.platforms.opencode.syncedFrom.contentHash, 'abc')
  assert.equal(merged.agent_ras.platforms.opencode.syncedFrom.revision, 2)
  assert.equal(merged.agent_ras.service.x, 1)
})
