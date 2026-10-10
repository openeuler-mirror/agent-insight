import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveAnomalyStatus, normalizeAnomalyFilter } from '@/lib/reliability/anomaly-status'

test('deriveAnomalyStatus prefers detecting then abnormal then unknown', () => {
  assert.equal(deriveAnomalyStatus({ eventCount: 0, hasDetecting: true }), 'detecting')
  assert.equal(deriveAnomalyStatus({ eventCount: 2 }), 'abnormal')
  assert.equal(deriveAnomalyStatus({ eventCount: 0 }), 'unknown')
})

test('normalizeAnomalyFilter accepts design values', () => {
  assert.equal(normalizeAnomalyFilter('abnormal'), 'abnormal')
  assert.equal(normalizeAnomalyFilter('ALL'), 'all')
  assert.equal(normalizeAnomalyFilter('nope'), 'all')
})
