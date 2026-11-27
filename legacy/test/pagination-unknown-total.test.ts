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
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pagination } from '../src/components/ui/pagination';

test('unknown totals permit next-page navigation using page lookahead without inventing a total', () => {
    for (const hasMore of [true, false]) {
        const html = renderToStaticMarkup(React.createElement(Pagination, {
            page: 2, pageSize: 20, total: null, hasMore, onPageChange: () => {},
        }));
        const next = html.match(/<button[^>]*aria-label="Next page"[^>]*>/)?.[0];
        assert.ok(next);
        assert.equal(/\sdisabled(?:=|\s|>)/.test(next), !hasMore);
        assert.ok(!html.includes('of 0') && !html.includes('NaN') && !html.includes('of null'));
        assert.match(html, /aria-current="page"[^>]*>2</);
    }
});
