import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { filterRuntimeModels, normalizeRuntimeModels } from '../src/lib/client/model-search';
import { RuntimeModelSelect } from '../src/components/eval/RuntimeModelSelect';

const models = [
  { id: '', label: '平台默认' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek Flash' },
  { id: 'openrouter/anthropic/claude-sonnet', label: 'Claude Sonnet' },
  { id: 'fixture/local', label: '本地模型' },
];

test('runtime models use case-insensitive literal substring matching', () => {
  assert.equal(filterRuntimeModels(models, '  '), models);
  for (const query of ['DEEPSEEK', '  deepseek flash ', 'v4-fl']) {
    assert.deepEqual(filterRuntimeModels(models, query), [models[1]]);
  }
  assert.deepEqual(filterRuntimeModels(models, 'openrouter'), [models[2]]);
  assert.deepEqual(filterRuntimeModels(models, 'sonnet'), [models[2]]);
  assert.deepEqual(filterRuntimeModels(models, '本地'), [models[3]]);
  assert.deepEqual(filterRuntimeModels(models, '平台默认'), [models[0]]);
  assert.deepEqual(filterRuntimeModels(models, 'dpsk'), []);
  assert.deepEqual(filterRuntimeModels(models, 'openrouter sonnet'), []);
  assert.deepEqual(filterRuntimeModels(models, 'nonexistent-model'), []);
  assert.equal(models.length, 4);
});

test('runtime model filtering does not truncate large catalogs or merge provider-specific IDs', () => {
  const catalog = Array.from({ length: 450 }, (_, i) => ({ id: `provider/model-${i}`, label: `Model ${i}` }));
  assert.equal(filterRuntimeModels(catalog, '').length, 450);
  assert.equal(filterRuntimeModels(catalog, 'model').length, 450);
  const sameName = [{ id: 'deepseek/model', label: 'model' }, { id: 'openrouter/model', label: 'model' }];
  assert.deepEqual(filterRuntimeModels(sameName, 'model'), sameName);
  assert.deepEqual(filterRuntimeModels(sameName, 'deepseek/model'), [sameName[0]]);
});

test('runtime model options deduplicate IDs and keep one display label per item', () => {
  assert.deepEqual(normalizeRuntimeModels([
    { id: '', label: '平台默认' },
    { id: ' deepseek/model ', label: 'DeepSeek Model' },
    { id: 'deepseek/model', label: 'duplicated label' },
    { id: 'fixture/local', label: '' },
  ]), [
    { id: 'deepseek/model', label: 'DeepSeek Model' },
    { id: 'fixture/local', label: 'fixture/local' },
  ]);
});

test('runtime model selector renders the selected value or platform default without mutating selection', () => {
  let changes = 0;
  for (const [value, options, expected] of [
    ['', [], '平台默认'],
    [models[1].id, models, 'DeepSeek Flash'],
    ['old-provider/model', models, 'old-provider/model'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(RuntimeModelSelect, {
      id: 'model', models: [...options], value, onChange: () => { changes++; },
    }));
    assert.ok(html.includes(expected));
    assert.ok(html.includes('type="button"'));
    assert.ok(html.includes('aria-expanded="false"'));
  }
  assert.equal(changes, 0);
});
