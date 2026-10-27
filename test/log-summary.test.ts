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
import fs from 'node:fs';
import test from 'node:test';

test('only explicitly summarized progress is combined, with totals and a final flush', async () => {
  assert.ok(fs.existsSync('src/lib/logger/summary.ts'), 'summary implementation is missing');
  const { createProgressSummary } = await import('../src/lib/logger/summary');
  const lines: any[] = [];
  let now = 1000;
  const summary = createProgressSummary((fields) => lines.push(fields), () => now);
  for (let i = 0; i < 600; i++) { summary.record({ backlog: i, discovered: 1, parseErrors: 0 }); now += 100; }
  assert.equal(lines.length, 1);
  summary.flushIfDue();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].ticks, 599);
  assert.equal(lines[1].discovered, 599);
  assert.equal(lines[1].backlog, 599);
  summary.record({ backlog: 0, discovered: 2, parseErrors: 1 });
  summary.flush();
  assert.equal(lines.at(-1).parseErrors, 1);
  assert.equal(lines.at(-1).discovered, 2);
});
