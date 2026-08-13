import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeReliabilityClientId,
  normalizeTraceClientMetadata,
} from '@/lib/reliability/trace-client'

test('trace client metadata accepts stable identity and host snapshot', () => {
  const metadata = normalizeTraceClientMetadata(
    {
      client_id: 'cli_12345678-1234-1234-1234-123456789abc',
      host: {
        hostname: 'dev-host',
        reported_ip: '10.20.30.40',
      },
      observedIp: '203.0.113.99',
    },
    '198.51.100.8',
  )

  assert.deepEqual(metadata, {
    clientId: 'cli_12345678-1234-1234-1234-123456789abc',
    hostIp: '10.20.30.40',
    hostName: 'dev-host',
    observedIp: '198.51.100.8',
  })
})

test('trace client metadata rejects malformed identity and IP values', () => {
  const metadata = normalizeTraceClientMetadata(
    {
      client_id: 'worker-1',
      host: {
        hostname: 'bad\nname',
        reported_ip: 'not-an-ip',
      },
    },
    'also-not-an-ip',
  )

  assert.deepEqual(metadata, {
    clientId: null,
    hostIp: null,
    hostName: null,
    observedIp: null,
  })
  assert.equal(normalizeReliabilityClientId('cli_x'), null)
})
