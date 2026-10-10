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
