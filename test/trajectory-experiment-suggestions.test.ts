import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EvidenceBlock } from '@/components/eval/EvidenceBlock';
import {
  attachTrajectorySkillSuggestions,
  EXPERIMENT_TRAJECTORY_TIMEOUTS,
} from '@/lib/engine/experiment/faithful-preset-evaluators';

test('实验轨迹评分与 Skill 建议使用独立的专属超时预算', () => {
  assert.deepEqual(EXPERIMENT_TRAJECTORY_TIMEOUTS, {
    scoreMs: 5 * 60_000,
    suggestionAttemptMs: 7 * 60_000,
    suggestionMaxAttempts: 2,
    resultRowMs: 20 * 60_000,
  });
});

test('轨迹建议只挂到完整性评分点，并合并为 Markdown 建议', () => {
  const points = [
    { label: '完整性', score: 70, evidence: { md: '关键动作覆盖依据' } },
    { label: '工具选择', score: 100, evidence: { json: { verdict: 'met' } } },
    { label: '冗余度', score: 100, evidence: { md: '无冗余调用' } },
  ];

  const result = attachTrajectorySkillSuggestions(points, [
    {
      category: '缺少护栏',
      severity: 'high',
      summary: '缺少暴力破解判定证据',
      evidence: 'trace 中未执行判定脚本。',
      improvementSuggestion: '在 SKILL.md 中增加脚本执行与证据引用要求。',
    },
    {
      category: '指令模糊',
      severity: 'medium',
      summary: '失败后的核验步骤不明确',
      evidence: 'trace 中首次失败后直接输出结论。',
      improvementSuggestion: '明确失败后必须再次核验最终状态。',
    },
  ]);

  assert.equal(result[0].skillAttributable, true);
  assert.equal(
    result[0].suggestion,
    '- **缺少暴力破解判定证据**：在 SKILL.md 中增加脚本执行与证据引用要求。\n'
      + '- **失败后的核验步骤不明确**：明确失败后必须再次核验最终状态。',
  );
  assert.equal(result[1].suggestion, undefined);
  assert.equal(result[2].suggestion, undefined);
});

test('空轨迹建议不产生标签或占位内容', () => {
  const points = [{ label: '完整性', score: 100, evidence: { md: '全部覆盖' } }];
  assert.equal(attachTrajectorySkillSuggestions(points, []), points);

  const caseDetail = readFileSync('src/components/eval/ExperimentCaseDetail.tsx', 'utf8');
  const evidenceBlock = readFileSync('src/components/eval/EvidenceBlock.tsx', 'utf8');
  assert.match(caseDetail, />证据与建议</);
  assert.match(caseDetail, /supplementalMarkdown=\{point\.suggestion\}/);
  assert.doesNotMatch(caseDetail, /当前没有改进建议/);
  assert.match(evidenceBlock, /\*\*证据\*\*/);
  assert.match(evidenceBlock, /\*\*Skill 改进建议\*\*/);
  assert.match(evidenceBlock, /`证据：\$\{preview\(ev, evaluatorId\)\}`/);
  assert.doesNotMatch(evidenceBlock, /roleLabel|format === 'JSON'/);
});

test('新增轨迹评估器将结构化证据展示为中文文本', () => {
  const html = renderToStaticMarkup(createElement(EvidenceBlock, {
    evaluatorId: 'preset-agent-step-efficiency',
    evidence: {
      json: {
        dimension: 'step_necessity',
        verdict: 'met',
        reason: '各步骤均服务于日志审计任务。',
        issues: [],
      },
    },
    supplementalMarkdown: '- 合并可批量执行的检查步骤。',
  }));

  assert.match(html, /判断：/);
  assert.match(html, /达成/);
  assert.match(html, /依据：各步骤均服务于日志审计任务。/);
  assert.match(html, /Skill 改进建议：- 合并可批量执行的检查步骤。/);
  assert.doesNotMatch(html, /step_necessity|dimension|verdict|issues/);
});

test('建议预览保留负数开头的连字符', () => {
  const html = renderToStaticMarkup(createElement(EvidenceBlock, {
    evaluatorId: 'preset-agent-step-efficiency',
    evidence: { md: '误差分析依据' },
    supplementalMarkdown: '-10% 的误差',
  }));

  assert.match(html, /Skill 改进建议：-10% 的误差/);
});
