import test from 'node:test';
import assert from 'node:assert/strict';

import { extractKeyPointIssuesFromRawAnalysis } from '../src/lib/engine/evaluation/derive-skill-opt-points';

test('extractKeyPointIssuesFromRawAnalysis maps result-analysis skill attribution into existing opt issue fields', () => {
  const issues = extractKeyPointIssuesFromRawAnalysis(JSON.stringify({
    resultEvaluation: {
      key_point_findings: [
        {
          content: 'JOIN::exec 是 CPU 主要瓶颈',
          covered: false,
          severity: 'high',
          explanation: '最终答案没有明确指出 JOIN::exec 是主要瓶颈。',
          missing_reason: '缺少执行阶段和占比证据。',
          evidence: {
            actual: '热点集中在排序阶段。',
            expected: 'JOIN::exec 占 78.34%。',
          },
          trace_root_cause: {
            failure_reason: 'trace 中读到了排序热点，但没有继续归纳到 JOIN::exec。',
            related_steps: [
              {
                step_index: 5,
                kind: 'tool',
                name: 'read',
                evidence: '只读到了 create_sort_index 区域。',
              },
            ],
          },
          is_skill_attributable: true,
          attribution_reason: '如果 Skill 强制要求输出前核对热点函数所属执行阶段，可以降低复现概率。',
          improvement_suggestion: '在 SKILL.md 中增加：输出瓶颈结论前必须说明热点函数所属执行阶段与占比证据。',
        },
      ],
    },
  }));

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'high');
  assert.equal(issues[0].category, '关键观点遗漏');
  assert.equal(issues[0].summary, 'JOIN::exec 是 CPU 主要瓶颈');
  assert.match(issues[0].evidence, /结果分析：最终答案没有明确指出 JOIN::exec 是主要瓶颈。/);
  assert.match(issues[0].evidence, /缺失原因：缺少执行阶段和占比证据。/);
  assert.match(issues[0].evidence, /过程根因：trace 中读到了排序热点，但没有继续归纳到 JOIN::exec。/);
  assert.match(issues[0].evidence, /相关步骤：#5 · tool · read · 只读到了 create_sort_index 区域。/);
  assert.match(issues[0].evidence, /Skill归因：如果 Skill 强制要求输出前核对热点函数所属执行阶段，可以降低复现概率。/);
  assert.equal(
    issues[0].reasoning,
    '如果 Skill 强制要求输出前核对热点函数所属执行阶段，可以降低复现概率。',
  );
  assert.equal(
    issues[0].improvementSuggestion,
    '在 SKILL.md 中增加：输出瓶颈结论前必须说明热点函数所属执行阶段与占比证据。',
  );
});
