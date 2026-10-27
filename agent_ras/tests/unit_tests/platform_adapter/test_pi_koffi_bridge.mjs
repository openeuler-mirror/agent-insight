/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
