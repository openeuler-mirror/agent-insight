// 变量维度策略测试：LLM 实现 + framework/skill stub + getDimension 映射。
// 覆盖：extractValue 取正确字段 / controlledFields 返回维度正确集 /
// framework/skill stub queryCandidateTraces 抛 NotImplemented / getDimension 映射。
// DB 测试（queryCandidateTraces）落在仓库 data/witty_insight.db（同 experiment-engine.test.ts）。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prisma } from '@/lib/storage/prisma';
import {
  LLM_DIMENSION,
  FRAMEWORK_DIMENSION,
  SKILL_DIMENSION,
  getDimension,
} from '@/lib/engine/experiment/variable-dimension';

// ─── extractValue ───────────────────────────────────────────────────────────

test('LLM_DIMENSION.extractValue 读 trace.model', () => {
  assert.equal(LLM_DIMENSION.extractValue({ model: 'glm-4.7' }), 'glm-4.7');
  assert.equal(LLM_DIMENSION.extractValue({ model: null }), '');
  assert.equal(LLM_DIMENSION.extractValue({ model: undefined }), '');
  assert.equal(LLM_DIMENSION.extractValue({}), '');
});

test('FRAMEWORK_DIMENSION.extractValue 读 trace.framework', () => {
  assert.equal(FRAMEWORK_DIMENSION.extractValue({ framework: 'opencode' }), 'opencode');
  assert.equal(FRAMEWORK_DIMENSION.extractValue({ framework: null }), '');
  assert.equal(FRAMEWORK_DIMENSION.extractValue({}), '');
});

test('SKILL_DIMENSION.extractValue 读 trace.skill', () => {
  assert.equal(SKILL_DIMENSION.extractValue({ skill: 'my-skill' }), 'my-skill');
  assert.equal(SKILL_DIMENSION.extractValue({ skill: null }), '');
  assert.equal(SKILL_DIMENSION.extractValue({}), '');
});

// ─── controlledFields ───────────────────────────────────────────────────────

test('LLM_DIMENSION.controlledFields 返回 agentName/skill/skillVersion', () => {
  const fields = LLM_DIMENSION.controlledFields().map((f) => f.field);
  assert.deepEqual(fields, ['agentName', 'skill', 'skillVersion']);
});

test('FRAMEWORK_DIMENSION.controlledFields 变 framework 时控制 agentName+skill+skillVersion+model', () => {
  const fields = FRAMEWORK_DIMENSION.controlledFields().map((f) => f.field);
  assert.deepEqual(fields, ['agentName', 'skill', 'skillVersion', 'model']);
});

test('SKILL_DIMENSION.controlledFields 变 skill 时控制 agentName+model', () => {
  const fields = SKILL_DIMENSION.controlledFields().map((f) => f.field);
  assert.deepEqual(fields, ['agentName', 'model']);
});

// ─── stub queryCandidateTraces 抛 NotImplemented ───────────────────────────

test('FRAMEWORK_DIMENSION.queryCandidateTraces 抛 NotImplemented', async () => {
  await assert.rejects(
    () => FRAMEWORK_DIMENSION.queryCandidateTraces('agent-x', 'opencode'),
    /NotImplemented.*framework/i,
  );
});

test('SKILL_DIMENSION.queryCandidateTraces 抛 NotImplemented', async () => {
  await assert.rejects(
    () => SKILL_DIMENSION.queryCandidateTraces('agent-x', 'my-skill'),
    /NotImplemented.*skill/i,
  );
});

// ─── getDimension 映射 ──────────────────────────────────────────────────────

test('getDimension: single → null', () => {
  assert.equal(getDimension('single'), null);
});

test('getDimension: llm → LLM_DIMENSION', () => {
  assert.equal(getDimension('llm'), LLM_DIMENSION);
});

test('getDimension: framework → FRAMEWORK_DIMENSION', () => {
  assert.equal(getDimension('framework'), FRAMEWORK_DIMENSION);
});

test('getDimension: skill → SKILL_DIMENSION', () => {
  assert.equal(getDimension('skill'), SKILL_DIMENSION);
});

test('getDimension: 未知 type → null', () => {
  assert.equal(getDimension('unknown' as never), null);
});

// ─── LLM_DIMENSION.queryCandidateTraces DB 集成 ─────────────────────────────

test('LLM_DIMENSION.queryCandidateTraces 按 agent+model 过滤并返回 TraceCandidate 字段', async (t) => {
  const agent = `var-dim-agent-${Date.now()}`;
  const modelA = 'test-model-a';
  const modelB = 'test-model-b';

  const created: string[] = [];
  t.after(async () => {
    await prisma.execution.deleteMany({ where: { id: { in: created } } });
  });

  // 创建 3 条 Execution：2 条 modelA + 1 条 modelB，全属同一 agent
  for (let i = 0; i < 2; i++) {
    const e = await prisma.execution.create({
      data: { agentName: agent, model: modelA, query: `q-${i}`, taskId: `t-${i}` },
    });
    created.push(e.id);
  }
  const e3 = await prisma.execution.create({
    data: { agentName: agent, model: modelB, query: 'q-other', taskId: 't-other' },
  });
  created.push(e3.id);

  // 查 modelA：应返回 2 条
  const candidates = await LLM_DIMENSION.queryCandidateTraces(agent, modelA);
  assert.equal(candidates.length, 2);
  // 字段齐全
  const first = candidates[0];
  assert.ok(first.id);
  assert.equal(first.agentName, agent);
  assert.equal(first.model, modelA);
  assert.ok(typeof first.query === 'string');
  assert.ok(first.timestamp instanceof Date);
});

test('LLM_DIMENSION.queryCandidateTraces 无匹配返回空数组', async () => {
  const candidates = await LLM_DIMENSION.queryCandidateTraces(
    `nonexistent-agent-${Date.now()}`,
    'nonexistent-model',
  );
  assert.equal(candidates.length, 0);
});
