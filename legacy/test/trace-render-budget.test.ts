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
import {
    resolveEventRenderCount,
    truncateForPreview,
    TRACE_EVENT_RENDER_BATCH,
} from '@/lib/client/trace-render-budget';

test('preview text within budget is returned unchanged', () => {
    const preview = truncateForPreview('short output', 100);
    assert.equal(preview.text, 'short output');
    assert.equal(preview.truncated, false);
    assert.equal(preview.totalChars, 12);
});

test('long preview text is cut at the budget and reports the full size', () => {
    const text = 'x'.repeat(50_000);
    const preview = truncateForPreview(text, 20_000);
    assert.equal(preview.text.length, 20_000);
    assert.equal(preview.truncated, true);
    assert.equal(preview.totalChars, 50_000);
});

test('preview never splits a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀`;
    const preview = truncateForPreview(text, 10);
    assert.equal(preview.text, 'a'.repeat(9));
    assert.equal(preview.truncated, true);
});

test('an agent with few calls renders every event in one batch', () => {
    assert.equal(resolveEventRenderCount([0, 1, 2], TRACE_EVENT_RENDER_BATCH), 3);
});

test('a trace with hundreds of calls renders only the first batch', () => {
    const indexes = Array.from({ length: 500 }, (_, index) => index);
    assert.equal(resolveEventRenderCount(indexes, TRACE_EVENT_RENDER_BATCH), TRACE_EVENT_RENDER_BATCH);
});

test('searching reveals every event so matches are in the DOM', () => {
    const indexes = Array.from({ length: 500 }, (_, index) => index);
    assert.equal(
        resolveEventRenderCount(indexes, TRACE_EVENT_RENDER_BATCH, { revealAll: true }),
        500,
    );
});

test('revealing a selected event expands the batch up to its top-level row', () => {
    const indexes = [0, 2, 4, 6, 8];
    assert.equal(
        resolveEventRenderCount(indexes, 2, { revealThrough: 6 }),
        4,
    );
});

test('revealing an event inside the last row keeps the whole list', () => {
    const indexes = [0, 2, 4, 6, 8];
    assert.equal(
        resolveEventRenderCount(indexes, 2, { revealThrough: 7 }),
        5,
    );
});

test('reveal index inside the current batch does not grow it', () => {
    const indexes = [0, 2, 4, 6, 8];
    assert.equal(
        resolveEventRenderCount(indexes, 3, { revealThrough: 2 }),
        3,
    );
});
