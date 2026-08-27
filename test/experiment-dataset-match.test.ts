import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchDatasetCases,
  describeMatchResult,
  findBestDatasetInputMatch,
  toDatasetCases,
} from '../src/lib/engine/experiment/dataset-match';
import { matchAgentDatasetCase } from '../src/lib/engine/evaluation/dataset-case-match';
import type { AgentDatasetRecord } from '../src/server/agent_datasets_storage';

describe('实验 ③ 步与数据集互通', () => {
  const cases = [
    { key: 'c1', input: '查询订单物流', referenceOutput: null },
    { key: 'c2', input: '  处理重复扣款  ', referenceOutput: '' },
    { key: 'c3', input: '修改收货地址', referenceOutput: '人工标注的答案' },
    { key: 'c4', input: '数据集里没有的任务', referenceOutput: null },
  ];
  const dataset = [
    { input: '查询订单物流', expectedOutput: '应给出物流节点与延迟原因' },
    { input: '处理重复扣款', expectedOutput: '应发起原路退款并告知时效' },
    { input: '修改收货地址', expectedOutput: '数据集里的答案' },
  ];

  it('默认跳过已标注：命中回填、已标注跳过、未命中计数', () => {
    const r = matchDatasetCases(cases, dataset);
    assert.equal(r.matched, 2);
    assert.equal(r.skipped, 1);
    assert.equal(r.unmatched, 1);
    assert.equal(r.updates.c1, '应给出物流节点与延迟原因');
    // 输入两侧空白被规整后仍能命中
    assert.equal(r.updates.c2, '应发起原路退款并告知时效');
    // 人工标注不被覆盖
    assert.equal(r.updates.c3, undefined);
  });

  it('overwrite=true 时覆盖已标注', () => {
    const r = matchDatasetCases(cases, dataset, true);
    assert.equal(r.matched, 3);
    assert.equal(r.skipped, 0);
    assert.equal(r.updates.c3, '数据集里的答案');
  });

  it('Trace 输入包含数据集输入时回填', () => {
    const r = matchDatasetCases(
      [{ key: 'x', input: '查询订单物流状态', referenceOutput: null }],
      dataset,
    );
    assert.equal(r.matched, 1);
    assert.equal(r.updates.x, '应给出物流节点与延迟原因');
    assert.equal(r.unmatched, 0);
  });

  it('包含关系方向固定：数据集输入包含 Trace 输入时不回填', () => {
    const r = matchDatasetCases(
      [{ key: 'x', input: '查询订单', referenceOutput: null }],
      dataset,
    );
    assert.equal(r.matched, 0);
    assert.equal(r.unmatched, 1);
  });

  it('多个数据集输入被包含时优先最长、最具体的一条', () => {
    const candidates = [
      { input: '查询订单', expectedOutput: '宽泛答案' },
      { input: '查询订单物流', expectedOutput: '具体答案' },
    ];
    const r = matchDatasetCases(
      [{ key: 'x', input: '请帮我查询订单物流状态', referenceOutput: null }],
      candidates,
    );
    assert.equal(r.updates.x, '具体答案');
    assert.equal(findBestDatasetInputMatch('请帮我查询订单物流状态', candidates), candidates[1]);
  });

  it('服务端自动匹配同样使用 Trace 包含数据集输入的方向', async () => {
    const serverDataset: AgentDatasetRecord = {
      id: 'dataset-1', user: 'tester', name: 'test', description: '', targetAgent: '', targetSkill: '',
      tags: [], fields: [], datasetKind: 'ideal_output', createdAt: '', updatedAt: '',
      cases: [
        {
          id: 'short', input: '查询订单', expectedOutput: '宽泛答案', evaluationFocus: '', tags: [], trajectory: '',
        },
        {
          id: 'specific', input: '查询订单物流', expectedOutput: '具体答案', evaluationFocus: '', tags: [], trajectory: '',
        },
      ],
    };
    const result = await matchAgentDatasetCase({
      user: 'tester',
      traceQuery: '请帮我查询订单物流状态',
      requireExpectedOutput: true,
      datasets: [serverDataset],
    });
    assert.equal(result.match?.caseEntry.id, 'specific');
    assert.equal(result.match?.matchedBy, 'contains');
  });

  it('数据集侧忽略空答案与重复输入（取首条）', () => {
    const r = matchDatasetCases(
      [{ key: 'a', input: 'q', referenceOutput: null }, { key: 'b', input: 'blank', referenceOutput: null }],
      [
        { input: 'q', expectedOutput: '首条' },
        { input: 'q', expectedOutput: '重复应被忽略' },
        { input: 'blank', expectedOutput: '   ' },
      ],
    );
    assert.equal(r.updates.a, '首条');
    assert.equal(r.updates.b, undefined);
    assert.equal(r.unmatched, 1);
  });

  it('同一 input 的参考答案和能力目录可来自不同数据项', () => {
    const r = matchDatasetCases(
      [{ key: 'c1', input: 'q', referenceOutput: null, evaluatorContext: null }],
      [
        { input: 'q', values: { available_tools: [{ name: 'search' }] } },
        { input: 'q', expectedOutput: '正确答案' },
      ],
    );
    assert.equal(r.updates.c1, '正确答案');
    assert.deepEqual(r.contextUpdates.c1.availableTools, [{ name: 'search' }]);
    assert.equal(r.matched, 1);
    assert.equal(r.contextMatched, 1);
    assert.equal(r.unmatched, 0);
  });

  it('参考答案和能力目录分别选择各自最长的包含项', () => {
    const r = matchDatasetCases(
      [{ key: 'c1', input: '请查询订单物流状态', referenceOutput: null, evaluatorContext: null }],
      [
        { input: '查询订单', expectedOutput: '订单答案' },
        { input: '查询订单物流', values: { available_tools: [{ name: 'tracking' }] } },
      ],
    );
    assert.equal(r.updates.c1, '订单答案');
    assert.deepEqual(r.contextUpdates.c1.availableTools, [{ name: 'tracking' }]);
  });

  it('摘要文案随结果变化', () => {
    assert.equal(describeMatchResult({
      updates: {}, contextUpdates: {}, matched: 2, skipped: 1, unmatched: 1,
      contextMatched: 0, contextSkipped: 0,
    }),
      '已回填 2 条 · 跳过 1 条已标注 · 1 条未匹配');
    assert.equal(describeMatchResult({
      updates: {}, contextUpdates: {}, matched: 3, skipped: 0, unmatched: 0,
      contextMatched: 0, contextSkipped: 0,
    }), '已回填 3 条');
  });

  it('按包含关系导入 available_tools / available_skills，并保留显式空目录', () => {
    const r = matchDatasetCases(
      [
        { key: 'a', input: '需要搜索', referenceOutput: null, evaluatorContext: null },
        { key: 'b', input: '无需工具', referenceOutput: null, evaluatorContext: null },
      ],
      [
        {
          input: '需要搜索',
          values: {
            available_tools: [{ name: 'search' }],
            available_skills: [{ name: 'research_playbook', description: '检索后归纳资料' }],
          },
        },
        { input: '无需工具', values: { available_tools: '[]' } },
      ],
    );
    assert.equal(r.contextMatched, 2);
    assert.deepEqual(r.contextUpdates.a.availableTools, [{ name: 'search' }]);
    assert.deepEqual(r.contextUpdates.a.availableSkills, [{
      name: 'research_playbook', description: '检索后归纳资料',
    }]);
    assert.deepEqual(r.contextUpdates.b.availableTools, []);
    assert.equal(r.unmatched, 0);
  });

  it('存为数据集：只导出已标注的 case 且去空白', () => {
    const out = toDatasetCases([
      { input: ' a ', referenceOutput: ' ans ' },
      { input: 'b', referenceOutput: '' },
      { input: '', referenceOutput: 'x' },
    ]);
    assert.deepEqual(out, [{ input: 'a', expectedOutput: 'ans' }]);
  });

  it('存为数据集时导出 Tool/Skill 目录，包括显式空数组', () => {
    const out = toDatasetCases([{
      input: 'q', referenceOutput: null,
      evaluatorContext: {
        schemaVersion: 1,
        availableTools: [],
        availableSkills: [{ name: 'research_playbook' }],
      },
    }]);
    assert.deepEqual(out, [{
      input: 'q', expectedOutput: '',
      values: { available_tools: [], available_skills: [{ name: 'research_playbook' }] },
    }]);
  });
});
