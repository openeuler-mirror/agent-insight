/** 评测数据集批量导入 Tool/Skill 目录字段的契约测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBatchJson } from '@/lib/dataset-batch-import';

test('导入 Tool/Skill 目录，并以顶层显式目录覆盖 values 中的旧值', () => {
  const result = parseBatchJson(JSON.stringify([
    {
      input: '分析日志',
      available_tools: [{ name: 'grep', description: '搜索文本' }],
      available_skills: [{ name: 'log-analysis', description: '分析日志模式' }],
    },
    {
      input: '无需工具',
      values: { scenario: 'boundary', available_tools: [{ name: 'stale' }] },
      available_tools: [],
    },
  ]), 'ideal_output');

  assert.deepEqual(result.cases.map((item) => item.values), [
    {
      available_tools: [{ name: 'grep', description: '搜索文本' }],
      available_skills: [{ name: 'log-analysis', description: '分析日志模式' }],
    },
    { scenario: 'boundary', available_tools: [] },
  ]);
});
