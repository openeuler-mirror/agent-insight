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
