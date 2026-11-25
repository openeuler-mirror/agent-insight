import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWizardDatasetVersion, readReusableAssetVersionRefs } from '../src/lib/client/wizard-asset-versions';

test('历史评测集版本覆盖当前Case定义并保留原Benchmark展示元数据，旧请求不可污染另一评测集', () => {
  const current = { id: 'dataset-a', name: 'Current', cases: [{ id: 'one', input: 'new' }], benchmark: { adapterKey: 'adapter' } };
  const selection = { businessId: 'dataset-a', versionId: 'v1', content: { id: 'dataset-a', name: 'Old', cases: [{ id: 'one', input: 'old', turns: [{ input: 'old' }] }] } };
  const versioned = mergeWizardDatasetVersion(current, selection);
  assert.equal(versioned?.name, 'Old');
  assert.equal(versioned?.cases[0].input, 'old');
  assert.deepEqual(versioned?.benchmark, current.benchmark);
  assert.equal(mergeWizardDatasetVersion({ ...current, id: 'dataset-b' }, selection)?.cases[0].input, 'new');
});

test('复用配置从冻结记录取版本ID，保留稳定评估器ID且忽略不完整引用', () => {
  assert.deepEqual(readReusableAssetVersionRefs({ schemaVersion: 1, agent: { versionId: 'agent-v1' }, dataset: { versionId: 'dataset-v2' }, evaluators: { 'custom-one': { versionId: 'eval-v3' }, broken: { version: 1 } } }), {
    agent: 'agent-v1', dataset: 'dataset-v2', evaluators: { 'custom-one': 'eval-v3' },
  });
  assert.deepEqual(readReusableAssetVersionRefs({ agent: 'old-agent', evaluators: { 'custom-one': 'eval-v1' } }), { agent: 'old-agent', evaluators: { 'custom-one': 'eval-v1' } });
  assert.deepEqual(readReusableAssetVersionRefs(null), {});
});

test('复用只接受原Trace的精确ID，失效记录拒绝且验证请求有并发上限', async () => {
  const { validateReusableTraceIds } = await import('../src/lib/client/wizard-asset-versions');
  let running = 0, maxRunning = 0;
  await validateReusableTraceIds(Array.from({ length: 9 }, (_, i) => `trace-${i}`), async id => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--; return [{ id }];
  });
  assert.equal(maxRunning, 4);
  await assert.rejects(validateReusableTraceIds(['deleted'], async () => [{ id: 'other-trace-with-same-input' }]), /deleted.*已删除或无权访问/);
});
