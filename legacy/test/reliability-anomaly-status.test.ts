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
