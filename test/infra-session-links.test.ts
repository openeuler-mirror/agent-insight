import assert from 'node:assert/strict';
import test from 'node:test';

import { groupSessionInfraTargets, getSessionLinks, setSessionLinks } from '@/lib/infra/sessions';
import { prismaRaw } from '@/lib/storage/prisma';

// --- 纯函数：按 (endpoint, model) 归并窗口 ---
test('groupSessionInfraTargets：按 (endpoint,model) 归并，窗口取组内 min/max，丢弃无 endpoint', () => {
  const targets = groupSessionInfraTargets([
    { endpoint: 'http://a:8000', model: 'Qwen', startMs: 100, endMs: 200 },
    { endpoint: 'http://a:8000', model: 'Qwen', startMs: 300, endMs: 500 }, // 同组 → 合并窗口
    { endpoint: 'http://a:8000', model: 'Llama', startMs: 150, endMs: 250 }, // 同源不同模型 → 另一组
    { endpoint: 'http://b:8000', model: 'Qwen', startMs: 120, endMs: 130 }, // 另一源
    { endpoint: null, model: 'X', startMs: 0, endMs: 9 }, // 无 endpoint → 丢弃
  ]);
  assert.equal(targets.length, 3, '三个 (endpoint,model) 组');
  const aQwen = targets.find(t => t.endpoint === 'http://a:8000' && t.model === 'Qwen');
  assert.ok(aQwen);
  assert.equal(aQwen.startMs, 100, '窗口起=组内最早');
  assert.equal(aQwen.endMs, 500, '窗口止=组内最晚');
  assert.ok(targets.some(t => t.endpoint === 'http://a:8000' && t.model === 'Llama'));
  assert.ok(targets.some(t => t.endpoint === 'http://b:8000' && t.model === 'Qwen'));
});

test('groupSessionInfraTargets：空输入返回空', () => {
  assert.deepEqual(groupSessionInfraTargets([]), []);
});

// --- DB：人工覆盖集合的读写（按 rootExecutionId 覆盖） ---
test('get/setSessionLinks：按 root 覆盖式保存与读取', async () => {
  const root = 'test-root-' + 'links';
  await prismaRaw.sessionInfraLink.deleteMany({ where: { rootExecutionId: root } });
  try {
    assert.deepEqual(await getSessionLinks(root), [], '初始为空');

    await setSessionLinks(root, [{ sourceId: 's1', model: 'Qwen' }, { sourceId: 's2', model: null }]);
    let links = await getSessionLinks(root);
    assert.equal(links.length, 2);
    assert.ok(links.some(l => l.sourceId === 's1' && l.model === 'Qwen'));
    assert.ok(links.some(l => l.sourceId === 's2' && l.model === null));

    // 覆盖：再次 set 用新集合整体替换
    await setSessionLinks(root, [{ sourceId: 's3', model: 'Llama' }]);
    links = await getSessionLinks(root);
    assert.equal(links.length, 1);
    assert.equal(links[0].sourceId, 's3');

    // 清空
    await setSessionLinks(root, []);
    assert.deepEqual(await getSessionLinks(root), []);
  } finally {
    await prismaRaw.sessionInfraLink.deleteMany({ where: { rootExecutionId: root } });
  }
});
