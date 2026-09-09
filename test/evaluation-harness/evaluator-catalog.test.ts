import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatorCards } from '../../src/components/evaluation-harness/evaluator-catalog';

const asset = (id: string, version: number, extra = {}) => ({
  id, kind: 'evaluator', assetKey: 'business-rules', name: '业务规则', version,
  archived: false, content: { type: 'rules', checkNames: ['路由'] },
  contentHash: id, createdAt: '', ...extra,
});

test('native evaluator cards retain the selected immutable version and rule category', () => {
  const assets = [asset('v1', 1), asset('v3', 3, { archived: true }), asset('v2', 2)];
  const latest = evaluatorCards(assets, {});
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, 'v2');
  assert.equal(latest[0].source, 'preset');
  assert.equal(latest[0].category, 'traj');
  assert.deepEqual(latest[0].pointsDef, [{ label: '路由' }]);
  assert.equal(evaluatorCards(assets, { 'business-rules': 'v1' })[0].id, 'v1');
  assert.equal(evaluatorCards(assets, { 'business-rules': 'v3' })[0].id, 'v2');
});

test('custom LLM versions remain custom and do not expose connection secrets in native card metadata', () => {
  const cards = evaluatorCards([asset('custom-1', 1, {
    assetKey: 'my-judge', name: '业务评分',
    content: { type: 'llm', prompt: '根据预期答案和证据评分', credentialId: 'private-id' },
  }), asset('target', 1, { kind: 'target' })], {});
  assert.equal(cards.length, 1);
  assert.equal(cards[0].source, 'custom');
  assert.equal(cards[0].category, 'res');
  assert.equal(cards[0].llmConfig?.systemPrompt, '根据预期答案和证据评分');
  assert.equal(JSON.stringify(cards).includes('private-id'), false);
});
