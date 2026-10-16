import assert from 'node:assert/strict';
import test from 'node:test';

import { saveExecutionRecord } from '@/lib/storage/data-service';
import { prismaRaw } from '@/lib/storage/prisma';

// 验证 Execution.endpoint 的存储 seam：saveExecutionRecord 带 endpoint → 落库到 Execution.endpoint。
test('saveExecutionRecord 持久化 endpoint 到 Execution', async () => {
  const id = `test-endpoint-${Date.now()}`;
  try {
    await saveExecutionRecord({
      upload_id: id,
      framework: 'opencode',
      model: 'Qwen3-Coder-30B-A3B-Instruct-FP8',
      endpoint: 'http://vllm.test:8000',
      user: 'test',
    });
    const row = await prismaRaw.execution.findUnique({ where: { id }, select: { endpoint: true, model: true } });
    assert.equal(row?.endpoint, 'http://vllm.test:8000');
    assert.equal(row?.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');

    // 更新路径也应保留/更新 endpoint
    await saveExecutionRecord({ upload_id: id, framework: 'opencode', endpoint: 'http://vllm-b.test:9000' });
    const row2 = await prismaRaw.execution.findUnique({ where: { id }, select: { endpoint: true } });
    assert.equal(row2?.endpoint, 'http://vllm-b.test:9000');
  } finally {
    await prismaRaw.execution.deleteMany({ where: { id } });
  }
});
