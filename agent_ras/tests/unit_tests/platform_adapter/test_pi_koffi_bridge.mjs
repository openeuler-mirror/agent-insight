import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  embedCall,
  embedReady,
  embedInitError,
} from '../../../platform_adapter/pi/bridge/koffi_bridge.ts'

describe('pi koffi bridge fail-open', () => {
  it('fails open when koffi is unavailable (node ESM, no require)', () => {
    process.env.AGENT_INSIGHT_RAS_HOME = mkdtempSync(join(tmpdir(), 'ras-pi-bridge-'))
    assert.equal(embedReady(), false)
    assert.match(String(embedInitError()), /koffi unavailable/)
  })

  it('returns null from embedCall after failed init', () => {
    const out = embedCall('hello', 'pi:test', { platform: 'pi' })
    assert.equal(out, null)
  })

  it('stays failed after repeated calls', () => {
    assert.equal(embedCall('observe', 'pi:test', {}), null)
    assert.equal(embedReady(), false)
    assert.ok(embedInitError())
  })
})
