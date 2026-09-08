import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentFromNative, resolveComparisonTargets } from '../src/lib/engine/experiment/comparison-target-selection';

const assets = [
  { id: 'agent-v2', kind: 'target', assetKey: 'agent', content: { type: 'agent' }, archived: false },
  { id: 'agent-v1', kind: 'target', assetKey: 'agent', content: { type: 'agent' }, archived: false },
  { id: 'skill-v2', kind: 'target', assetKey: 'skill', content: { type: 'skill' }, archived: false },
  { id: 'skill-v1', kind: 'target', assetKey: 'skill', content: { type: 'skill' }, archived: false },
  { id: 'other-v2', kind: 'target', assetKey: 'other', content: { type: 'skill' }, archived: false },
  { id: 'other-v1', kind: 'target', assetKey: 'other', content: { type: 'skill' }, archived: false },
];

test('目录晚到时按当前 Skill 对比类型修正默认 Agent，选 Skill v2/v1', () => {
  assert.deepEqual(resolveComparisonTargets([], '', '', 'skill'), { targetId: '', targetBId: '' });
  assert.deepEqual(resolveComparisonTargets(assets, 'agent-v2', '', 'skill'), { targetId: 'skill-v2', targetBId: 'skill-v1' });
});

test('保留已有合法版本选择，也保留用户选中的同版本 A/B 以显示校验', () => {
  assert.deepEqual(resolveComparisonTargets(assets, 'skill-v1', 'skill-v2', 'skill'), { targetId: 'skill-v1', targetBId: 'skill-v2' });
  assert.deepEqual(resolveComparisonTargets(assets, 'skill-v1', 'skill-v1', 'skill'), { targetId: 'skill-v1', targetBId: 'skill-v1' });
  assert.deepEqual(resolveComparisonTargets(assets, 'agent-v1', 'agent-v2', 'agent'), { targetId: 'agent-v1', targetBId: 'agent-v2' });
});

test('A 改选其他 Skill 时，B 自动改为该 Skill 的另一个可用版本', () => {
  assert.deepEqual(resolveComparisonTargets(assets, 'other-v1', 'skill-v1', 'skill'), { targetId: 'other-v1', targetBId: 'other-v2' });
});

test('没有匹配目标或没有第二个版本时清空无效选择', () => {
  assert.deepEqual(resolveComparisonTargets(assets.filter(a => a.content.type === 'agent'), 'skill-v2', 'skill-v1', 'skill'), { targetId: '', targetBId: '' });
  assert.deepEqual(resolveComparisonTargets(assets.filter(a => a.id !== 'other-v2'), 'other-v1', 'skill-v1', 'skill'), { targetId: 'other-v1', targetBId: '' });
});

test('归档目标和非目标资产不能作为默认值', () => {
  const catalog = [
    { id: 'dataset', kind: 'dataset', assetKey: 'skill', content: { type: 'skill' }, archived: false },
    { id: 'archived', kind: 'target', assetKey: 'skill', content: { type: 'skill' }, archived: true },
    ...assets,
  ];
  assert.deepEqual(resolveComparisonTargets(catalog, '', 'dataset', 'skill'), { targetId: 'skill-v2', targetBId: 'skill-v1' });
  assert.deepEqual(resolveComparisonTargets(catalog.slice(0, 2), '', '', 'skill'), { targetId: '', targetBId: '' });
});

test('保留明确选中的同类型归档目标，使回归原条件可见而非静默换成其他版本', () => {
  const catalog = [
    { id: 'archived-v2', kind: 'target', assetKey: 'skill', content: { type: 'skill' }, archived: true },
    { id: 'archived-v1', kind: 'target', assetKey: 'skill', content: { type: 'skill' }, archived: true },
    ...assets,
  ];
  assert.deepEqual(resolveComparisonTargets(catalog, 'archived-v2', 'archived-v1', 'skill'), { targetId: 'archived-v2', targetBId: 'archived-v1' });
  assert.deepEqual(resolveComparisonTargets(catalog, 'archived-v2', '', 'skill'), { targetId: 'archived-v2', targetBId: 'skill-v2' });
  assert.deepEqual(resolveComparisonTargets(catalog, 'skill-v1', 'archived-v1', 'skill'), { targetId: 'skill-v1', targetBId: 'archived-v1' });
  assert.deepEqual(resolveComparisonTargets(catalog.slice(0, 2), 'archived-v2', '', 'skill'), { targetId: 'archived-v2', targetBId: '' });
  assert.deepEqual(resolveComparisonTargets(catalog, 'other-v2', 'archived-v1', 'skill'), { targetId: 'other-v2', targetBId: 'other-v1' });
});


test('原生 Agent 切换到版本化数据集时保留同名 Agent，不默认改成其他 Agent', () => {
  const catalog = [
    { id: 'first-agent', kind: 'target', assetKey: 'first', name: 'Agent A', content: { type: 'agent' } },
    { id: 'b-archived', kind: 'target', assetKey: 'b', name: 'Agent B', archived: true, content: { type: 'agent' } },
    { id: 'b-active', kind: 'target', assetKey: 'b', name: 'Agent B', archived: false, content: { type: 'agent' } },
    { id: 'same-name-skill', kind: 'target', assetKey: 'skill', name: 'Skill only', content: { type: 'skill' } },
  ];
  assert.equal(resolveAgentFromNative(catalog, 'native:Agent B'), 'b-active');
  assert.equal(resolveAgentFromNative(catalog.filter(asset => asset.id !== 'b-active'), 'native:Agent B'), 'b-archived');
  assert.equal(resolveAgentFromNative(catalog, 'native:Unknown Agent'), 'native:Unknown Agent');
  assert.equal(resolveAgentFromNative(catalog, 'native:Skill only'), 'native:Skill only');
  assert.equal(resolveAgentFromNative(catalog, 'b-archived'), 'b-archived');
  assert.equal(resolveAgentFromNative(catalog, ''), '');
  assert.equal(resolveAgentFromNative([], 'native:Agent B'), 'native:Agent B');
});
