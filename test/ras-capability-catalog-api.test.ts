import assert from 'node:assert/strict'
import test from 'node:test'

import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine'

test('getRasCapabilityCatalog returns seven submodes and domain schemas', async () => {
  const catalog = await getRasCapabilityCatalog({ force: true })
  assert.equal(catalog.submodes.length, 7)
  assert.ok(catalog.domains.length >= 2)

  const ids = catalog.submodes.map((s) => s.id).sort()
  assert.deepEqual(ids, [
    'generic_repeat',
    'global_circuit_breaker',
    'ping_pong',
    'plan_execution',
    'similar_clauses',
    'suffix_cycle',
    'unknown_tool_repeat',
  ])

  for (const domain of catalog.domains) {
    assert.ok(domain.id)
    assert.ok(domain.configDefaults && typeof domain.configDefaults === 'object')
    assert.ok(domain.configSchema && typeof domain.configSchema === 'object')
  }

  assert.ok(Object.keys(catalog.kindLabels || {}).length > 0)
})
