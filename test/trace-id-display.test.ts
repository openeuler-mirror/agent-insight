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
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdChip } from '../src/components/text/IdChip';

const value = '0123456789abcdef0123456789abcdef';

test('adaptive Trace ID keeps the full text available for column resizing', () => {
  const html = renderToStaticMarkup(createElement(IdChip, { value, adaptive: true }));
  assert.match(html, new RegExp(`>${value}</span>`));
  assert.doesNotMatch(html, /012345…cdef/);
  assert.match(html, /Copy ID/);
});

test('other ID chips retain the compact middle abbreviation', () => {
  const html = renderToStaticMarkup(createElement(IdChip, { value }));
  assert.match(html, /012345…cdef/);
});
