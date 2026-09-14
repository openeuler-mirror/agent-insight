import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createPiSessionHost } from '../../../platform_adapter/pi/host_control.ts'

function fakeCtx({ sessionId, hasUI = true, isIdle = false } = {}) {
  const calls = { abort: 0, notify: [], sendUserMessage: [] }
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    hasUI,
    isIdle: () => isIdle,
    abort: () => {
      calls.abort += 1
    },
    ui: {
      notify: (message, level) => {
        calls.notify.push([message, level])
      },
    },
  }
  return { ctx, calls }
}

function hostWith(ctx, overrides = {}) {
  const pi = {
    sendUserMessage: (message, options) => {
      overrides.sendCalls.push([message, options])
    },
    ...overrides.pi,
  }
  const ctxRef = { current: ctx }
  return {
    host: createPiSessionHost({ pi, ctxRef, sessionId: 'pi:s1' }),
    pi,
  }
}

describe('pi host control requestAbortStream', () => {
  it('aborts via ctx and reports pi.abort channel', async () => {
    const { ctx, calls } = fakeCtx({ sessionId: 's1' })
    const { host } = hostWith(ctx)
    const result = await host.requestAbortStream()
    assert.deepEqual(result, { ok: true, channel: 'pi.abort' })
    assert.equal(calls.abort, 1)
  })

  it('fails open with no_ctx when session mismatches', async () => {
    const { ctx } = fakeCtx({ sessionId: 'other' })
    const { host } = hostWith(ctx)
    const result = await host.requestAbortStream()
    assert.equal(result.ok, false)
    assert.equal(result.channel, 'pi.abort')
    assert.equal(result.error, 'no_ctx')
  })

  it('fails with no_ctx when no session captured yet', async () => {
    const { host } = hostWith(null)
    const result = await host.requestAbortStream()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no_ctx')
  })
})

describe('pi host control emitUserNotice', () => {
  it('delivers info notification when UI present', async () => {
    const { ctx, calls } = fakeCtx({ sessionId: 's1', hasUI: true })
    const { host } = hostWith(ctx)
    const result = await host.emitUserNotice('检查到异常，请注意')
    assert.deepEqual(result, { ok: true, channel: 'pi.notify' })
    assert.deepEqual(calls.notify, [['检查到异常，请注意', 'info']])
  })

  it('degrades to noop log when headless (hasUI=false)', async () => {
    const { ctx, calls } = fakeCtx({ sessionId: 's1', hasUI: false })
    const { host } = hostWith(ctx)
    const result = await host.emitUserNotice('headless')
    assert.deepEqual(result, { ok: true, channel: 'pi.notice.noop' })
    assert.deepEqual(calls.notify, [])
  })

  it('degrades to noop when ctx missing', async () => {
    const { host } = hostWith(null)
    const result = await host.emitUserNotice('any')
    assert.deepEqual(result, { ok: true, channel: 'pi.notice.noop' })
  })

  it('reports failure when notify throws', async () => {
    const { ctx } = fakeCtx({ sessionId: 's1', hasUI: true })
    ctx.ui.notify = () => {
      throw new Error('tui gone')
    }
    const { host } = hostWith(ctx)
    const result = await host.emitUserNotice('boom')
    assert.equal(result.ok, false)
    assert.equal(result.channel, 'pi.notify')
    assert.match(result.error, /tui gone/)
  })
})

describe('pi host control pushSteering', () => {
  it('sends directly when idle (new turn)', async () => {
    const sendCalls = []
    const { ctx } = fakeCtx({ sessionId: 's1', isIdle: true })
    const { host } = hostWith(ctx, { sendCalls })
    const result = await host.pushSteering('请改用方案 B')
    assert.deepEqual(result, { ok: true, channel: 'pi.send' })
    assert.deepEqual(sendCalls, [['请改用方案 B', undefined]])
  })

  it('queues as steer while streaming', async () => {
    const sendCalls = []
    const { ctx } = fakeCtx({ sessionId: 's1', isIdle: false })
    const { host } = hostWith(ctx, { sendCalls })
    const result = await host.pushSteering('请改用方案 B')
    assert.deepEqual(result, { ok: true, channel: 'pi.steer' })
    assert.deepEqual(sendCalls, [['请改用方案 B', { deliverAs: 'steer' }]])
  })

  it('fails with no_ctx when session mismatched', async () => {
    const { ctx } = fakeCtx({ sessionId: 'other' })
    const { host } = hostWith(ctx)
    const result = await host.pushSteering('msg')
    assert.equal(result.ok, false)
    assert.equal(result.channel, 'pi.steer')
    assert.equal(result.error, 'no_ctx')
  })

  it('reports failure when sendUserMessage throws', async () => {
    const { ctx } = fakeCtx({ sessionId: 's1', isIdle: true })
    const pi = {
      sendUserMessage: () => {
        throw new Error('streaming without deliverAs')
      },
    }
    const host = createPiSessionHost({ pi, ctxRef: { current: ctx }, sessionId: 'pi:s1' })
    const result = await host.pushSteering('msg')
    assert.equal(result.ok, false)
    assert.match(result.error, /deliverAs/)
  })
})
