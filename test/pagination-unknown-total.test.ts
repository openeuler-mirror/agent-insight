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
