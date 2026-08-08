/** Trace 评测 API 传递并持久化 Tool/Skill 上下文的最小集成测试。 */
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';
import { POST as evaluateTraces } from '@/app/api/experiments/eval-traces/route';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { prisma } from '@/lib/storage/prisma';

const TEST_USER = `eval-traces-context-${Date.now()}`;

test.after(async () => {
  setJudgeLlmCallerForTest(null);
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
});

test('eval-traces 将 pair 的 Tool/Skill 目录传给评估器并写入 case', async () => {
  let seen: unknown = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seen = JSON.parse(request.user).evaluation_input.capability_catalog;
    return JSON.stringify({
      dimensions: [
        { dimension: 'tool_necessity', verdict: 'met', reason: '调用服务于任务', suggestion: '' },
        { dimension: 'tool_match', verdict: 'met', reason: '能力与任务匹配', suggestion: '' },
        { dimension: 'parameter_validity', verdict: 'met', reason: '参数有上下文依据', suggestion: '' },
        { dimension: 'result_utilization', verdict: 'met', reason: '结果得到使用', suggestion: '' },
        { dimension: 'call_order', verdict: 'met', reason: '调用顺序满足依赖', suggestion: '' },
      ],
      issues: [],
      suggestions: [],
    });
  });
  const evaluatorContext = {
    schemaVersion: 1,
    availableTools: [{ name: 'search', inputSchema: { type: 'object' } }],
    availableSkills: [{ name: 'research_playbook', description: '检索后归纳资料' }],
  };
  const response = await evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        evaluators: ['preset-agent-tool-selection'],
        pairs: [{ caseId: 'dataset-case-1', taskId: 'trace-task-1', evaluatorContext }],
      }),
    },
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    { kind: 'tool', name: 'search', description: '', inputSchema: { type: 'object' } },
    { kind: 'skill', name: 'research_playbook', description: '检索后归纳资料' },
  ]);
  const stored = await prisma.experimentCase.findFirst({
    where: { experiment: { user: TEST_USER }, taskId: 'trace-task-1' },
  });
  assert.deepEqual(JSON.parse(stored!.evaluatorContextJson!), evaluatorContext);
});
