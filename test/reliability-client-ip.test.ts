import assert from 'node:assert/strict'
import test from 'node:test'

import { isLoopbackIp, pickDisplayClientIp } from '@/lib/reliability/client-ip'

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
