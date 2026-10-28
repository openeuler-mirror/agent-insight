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

import assert from 'node:assert/strict';
import test from 'node:test';

import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine';

/**
 * Runtime truth is getRasCapabilityCatalog / GET /api/agent-ras/catalog.
 * Static RAS_FAULT_MODE_CATALOG fixture and browser label-store were removed.
 */
test('capability catalog engine returns labeled sub-modes', async () => {
  const catalog = await getRasCapabilityCatalog({ force: true });
  assert.ok(catalog.submodes.length > 0);
  for (const row of catalog.submodes) {
    assert.ok(row.parent.zh.trim(), `${row.id} parent.zh`);
    assert.ok(row.parent.en.trim(), `${row.id} parent.en`);
    assert.ok(row.subMode.zh.trim(), `${row.id} subMode.zh`);
    assert.ok(row.subMode.en.trim(), `${row.id} subMode.en`);
    assert.ok(row.detects.zh.trim(), `${row.id} detects.zh`);
    assert.ok(row.recoverySummary.zh.trim(), `${row.id} recoverySummary.zh`);
    assert.ok(row.severities.length > 0, `${row.id} severities`);
    assert.ok(row.anomalyKind.trim(), `${row.id} anomalyKind`);
  }
});
