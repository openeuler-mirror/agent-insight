import assert from 'node:assert/strict'
import test from 'node:test'

import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine'

test('getRasCapabilityCatalog returns domain schemas for every submode', async () => {
  const catalog = await getRasCapabilityCatalog({ force: true })
  assert.ok(catalog.submodes.length > 0)
  assert.ok(catalog.domains.length > 0)

  const ids = catalog.submodes.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)

  for (const domain of catalog.domains) {
    assert.ok(domain.id)
    assert.ok(domain.configDefaults && typeof domain.configDefaults === 'object')
    assert.ok(domain.configSchema && typeof domain.configSchema === 'object')
  }

  assert.ok(Object.keys(catalog.kindLabels || {}).length > 0)
})
