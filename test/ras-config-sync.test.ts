import assert from 'node:assert/strict'
import fs from 'node:fs'
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

test('syncCapabilityConfigFromInsight merges when revision ahead', async () => {
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
  assert.equal(result.revision, 3)
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(saved.agent_ras.enabled, false)
  assert.equal(saved.agent_ras.service.python, '/keep/me')
  assert.equal(saved.agent_ras.ras_config_revision, 3)
  assert.equal(saved.agent_ras.detectors.llm_thinking_loop.detection_start_chars, 500)

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

test('mergeCapabilityIntoLocalRasConfig is pure', async () => {
  const { mergeCapabilityIntoLocalRasConfig } = await loadSyncMod()
  const merged = mergeCapabilityIntoLocalRasConfig(
    { agent_ras: { service: { x: 1 } } },
    {
      enabled: true,
      detectors: {
        repeat_tool: { enabled: false },
        llm_thinking_loop: { enabled: true },
      },
      recovery: { notify_user_on_warning: true },
    },
    2,
  )
  assert.equal(merged.agent_ras.ras_config_revision, 2)
  assert.equal(merged.agent_ras.service.x, 1)
})
