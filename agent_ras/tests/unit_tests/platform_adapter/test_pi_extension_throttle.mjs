import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  OBSERVE_MIN_CHARS,
  OBSERVE_HOT_CHARS,
  OBSERVE_HOT_GROWTH,
  OBSERVE_EARLY_GROWTH,
  shouldObserveGrowth,
  shouldObserveText,
  pickStreamingDelta,
  sessionKey,
} from '../../../platform_adapter/pi/extension.ts'

describe('pi extension throttle', () => {
  it('keeps OpenCode threshold constants', () => {
    assert.equal(OBSERVE_MIN_CHARS, 32)
    assert.equal(OBSERVE_HOT_CHARS, 100)
    assert.equal(OBSERVE_HOT_GROWTH, 40)
    assert.equal(OBSERVE_EARLY_GROWTH, 80)
  })

  it('suppresses below minimum chars', () => {
    assert.equal(shouldObserveGrowth(0, 0), false)
    assert.equal(shouldObserveGrowth(31, 0), false)
  })

  it('requires early growth of 80 below hot zone', () => {
    assert.equal(shouldObserveGrowth(32, 0), false)
    assert.equal(shouldObserveGrowth(79, 0), false)
    assert.equal(shouldObserveGrowth(80, 0), true)
    assert.equal(shouldObserveGrowth(99, 19), true)
  })

  it('requires hot growth of 40 at or above hot zone', () => {
    assert.equal(shouldObserveGrowth(100, 0), true)
    assert.equal(shouldObserveGrowth(100, 60), true)
    assert.equal(shouldObserveGrowth(100, 61), false)
    assert.equal(shouldObserveGrowth(500, 420), true)
    assert.equal(shouldObserveGrowth(600, 561), false)
  })

  it('suppresses non-positive growth', () => {
    assert.equal(shouldObserveGrowth(100, 100), false)
    assert.equal(shouldObserveGrowth(50, 100), false)
  })

  it('shouldObserveText delegates on text length', () => {
    assert.equal(shouldObserveText('x'.repeat(40), 0), false)
    assert.equal(shouldObserveText('x'.repeat(80), 0), true)
    assert.equal(shouldObserveText('', 0), false)
  })

  it('has no aborting branch (D-003)', () => {
    assert.equal(shouldObserveGrowth.length, 2)
  })
})

describe('pi streaming delta filter', () => {
  it('accepts assistant text deltas as llm_output', () => {
    const picked = pickStreamingDelta(
      { role: 'assistant', id: 'm1' },
      { type: 'text_delta', delta: 'abc' },
    )
    assert.deepEqual(picked, { channel: 'llm_output', delta: 'abc' })
  })

  it('accepts assistant thinking deltas as llm_reasoning', () => {
    const picked = pickStreamingDelta(
      { role: 'assistant', id: 'm1' },
      { type: 'thinking_delta', delta: 'th' },
    )
    assert.deepEqual(picked, { channel: 'llm_reasoning', delta: 'th' })
  })

  it('rejects non-assistant roles defensively', () => {
    assert.equal(pickStreamingDelta({ role: 'user' }, { type: 'text_delta', delta: 'a' }), null)
    assert.equal(pickStreamingDelta({ role: 'toolResult' }, { type: 'text_delta', delta: 'a' }), null)
    assert.equal(pickStreamingDelta(null, { type: 'text_delta', delta: 'a' }), null)
  })

  it('rejects non-delta events and empty deltas', () => {
    const message = { role: 'assistant', id: 'm1' }
    assert.equal(pickStreamingDelta(message, { type: 'text_start' }), null)
    assert.equal(pickStreamingDelta(message, { type: 'text_end', content: 'done' }), null)
    assert.equal(pickStreamingDelta(message, { type: 'toolcall_start' }), null)
    assert.equal(pickStreamingDelta(message, { type: 'text_delta', delta: '' }), null)
    assert.equal(pickStreamingDelta(message, { type: 'text_delta', delta: 5 }), null)
    assert.equal(pickStreamingDelta(message, null), null)
  })
})

describe('pi session key', () => {
  it('joins platform and native session id', () => {
    assert.equal(sessionKey('pi', 'abc'), 'pi:abc')
  })

  it('falls back to generic native id', () => {
    assert.equal(sessionKey('pi', ''), 'pi:session')
    assert.equal(sessionKey('pi', null), 'pi:session')
  })
})
