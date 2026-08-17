import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import test from 'node:test'

import {
  clientIpFromRequest,
  isLoopbackIp,
  normalizePublicIp,
  pickDisplayClientIp,
} from '@/lib/reliability/client-ip'

test('isLoopbackIp catches 127.x and ::1', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true)
  assert.equal(isLoopbackIp('127.1.2.3'), true)
  assert.equal(isLoopbackIp('::1'), true)
  assert.equal(isLoopbackIp('10.20.3.18'), false)
  assert.equal(isLoopbackIp('192.168.1.5'), false)
})

test('pickDisplayClientIp prefers non-loopback reported/observed', () => {
  assert.equal(
    pickDisplayClientIp({ reportedIp: '127.0.0.1', observedIp: '10.20.3.18' }),
    '10.20.3.18',
  )
  assert.equal(
    pickDisplayClientIp({ reportedIp: '10.20.3.18', observedIp: '127.0.0.1' }),
    '10.20.3.18',
  )
  assert.equal(
    pickDisplayClientIp({ reportedIp: '127.0.0.1', observedIp: '127.0.0.1' }),
    '127.0.0.1',
  )
})

test('normalizePublicIp rejects local, private, reserved, and mapped loopback addresses', () => {
  for (const value of [
    '127.0.0.1',
    '::ffff:127.0.0.1',
    '10.0.0.8',
    '172.20.0.1',
    '192.168.1.5',
    '100.64.0.1',
    '169.254.1.2',
    '::1',
    'fe80::1',
    'fd00::1',
    '2001:db8::1',
  ]) {
    assert.equal(normalizePublicIp(value), null, value)
  }
  assert.equal(normalizePublicIp('8.8.8.8'), '8.8.8.8')
  assert.equal(normalizePublicIp('2404:6800:4008:c00::65'), '2404:6800:4008:c00::65')
})

test('clientIpFromRequest reads direct connection IP only when explicitly enabled', () => {
  const req = new Request('https://insight.test/api/ingest/upload', {
    headers: {
      'x-forwarded-for': '8.8.8.8, 10.0.0.2',
      'x-real-ip': '1.1.1.1',
    },
  })
  assert.equal(clientIpFromRequest(req, { trustedHeader: null }), null)
  assert.equal(
    clientIpFromRequest(req, { trustedHeader: null, allowDirectConnection: true }),
    '8.8.8.8',
  )
  assert.equal(clientIpFromRequest(req, { trustedHeader: 'x-forwarded-for' }), '8.8.8.8')
  assert.equal(clientIpFromRequest(req, { trustedHeader: 'x-real-ip' }), '1.1.1.1')
})

test('clientIpFromRequest uses the public request host for OpenCode on the server itself', () => {
  const req = new Request('http://119.3.152.42:3000/api/ingest/upload', {
    headers: { 'x-forwarded-for': '::ffff:127.0.0.1' },
  })
  assert.equal(
    clientIpFromRequest(req, {
      trustedHeader: null,
      allowDirectConnection: true,
      clientHostName: hostname(),
    }),
    '119.3.152.42',
  )
  assert.equal(
    clientIpFromRequest(req, {
      trustedHeader: null,
      allowDirectConnection: true,
      clientHostName: 'another-computer',
    }),
    null,
  )
})

test('clientIpFromRequest returns null for localhost even when the header is trusted', () => {
  const req = new Request('http://localhost:3000/api/ingest/upload', {
    headers: { 'x-forwarded-for': '::ffff:127.0.0.1' },
  })
  assert.equal(clientIpFromRequest(req, { trustedHeader: 'x-forwarded-for' }), null)
})
