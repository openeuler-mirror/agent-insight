import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TraceFilterSidebar from '../src/components/observe/TraceFilterSidebar';

test('830 Trace filters expose observation fields without unsupported cost and evaluation fields', () => {
  const html = renderToStaticMarkup(createElement(TraceFilterSidebar, { clauses: [], onChange: () => {}, user: 'audit' }));
  for (const label of ['成本', '答案分', '答案正确']) assert.ok(!html.includes(label), `${label} must not be offered`);
  for (const label of ['耗时', 'Tokens', '模型']) assert.ok(html.includes(label), `${label} remains available`);
});
