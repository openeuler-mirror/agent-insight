import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  normalizeHost,
  credentialsMatch,
  shouldRestartWorker,
} = require('../scripts/install-fault-injection.js')

test('normalizeHost strips trailing slash and trims', () => {
  assert.equal(normalizeHost('http://localhost:3000/'), 'http://localhost:3000')
  assert.equal(normalizeHost('  http://127.0.0.1:3000  '), 'http://127.0.0.1:3000')
  assert.equal(normalizeHost(''), '')
})

test('credentialsMatch requires both apiKey and host', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000/' }),
    true,
  )
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_bbb', insightBaseUrl: 'http://localhost:3000' }),
    false,
  )
  assert.equal(
    credentialsMatch(desired, { apiKey: 'wi_aaa', insightBaseUrl: 'http://127.0.0.1:3000' }),
    false,
  )
  assert.equal(credentialsMatch(desired, null), false)
})

test('shouldRestartWorker: missing running environ → restart', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(shouldRestartWorker(desired, null), true)
})

test('shouldRestartWorker: matching credentials → keep', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    shouldRestartWorker(desired, {
      apiKey: 'wi_aaa',
      insightBaseUrl: 'http://localhost:3000/',
    }),
    false,
  )
})

test('shouldRestartWorker: apiKey mismatch → restart', () => {
  const desired = { apiKey: 'wi_gmail', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    shouldRestartWorker(desired, {
      apiKey: 'wi_admin',
      insightBaseUrl: 'http://localhost:3000',
    }),
    true,
  )
})

test('shouldRestartWorker: host mismatch → restart', () => {
  const desired = { apiKey: 'wi_aaa', insightBaseUrl: 'http://localhost:3000' }
  assert.equal(
    shouldRestartWorker(desired, {
      apiKey: 'wi_aaa',
      insightBaseUrl: 'http://127.0.0.1:3000',
    }),
    true,
  )
})
