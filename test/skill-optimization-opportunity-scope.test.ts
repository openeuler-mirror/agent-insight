import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOptimizationScope,
  deriveOpportunitiesFromAggregatedIssues,
} from '../src/lib/engine/skill-optimization/opportunity-scope';
import {
  formatSkillEditRegion,
  resolveSkillEditRegionsForIssue,
} from '../src/lib/engine/skill-optimization/skill-edit-regions';

const SKILL_MD = `---
name: pdf-extractor
version: 1
description: 从 PDF 中抽取结构化文本与表格。
tags: [pdf, ocr]
---

# pdf-extractor

## When to use

用于 PDF 文本与表格抽取。

## How to use

\`\`\`bash
python scripts/main.py --input <file>
\`\`\`

## Examples

见 examples/ 目录。
`;

test('aggregated SkillIssue rows become ranked skill optimization opportunities', () => {
  const opportunities = deriveOpportunitiesFromAggregatedIssues([
    {
      id: 'issue-low',
      dedupKey: 'low',
      source: 'dynamic',
      severity: 'low',
      summary: '偶发低优先级问题',
      evidence: null,
      reasoning: null,
      suggestedFix: null,
      category: null,
      prevalenceCount: 10,
    },
    {
      id: 'issue-high',
      dedupKey: 'high',
      source: 'dynamic',
      severity: 'high',
      summary: '高优先级问题',
      evidence: 'trace-1',
      reasoning: 'Skill 缺少步骤。',
      suggestedFix: '补充步骤。',
      category: '轨迹偏差',
      prevalenceCount: 1,
    },
  ]);

  assert.equal(opportunities[0].issueId, 'issue-high');
  assert.equal(opportunities[0].category, '轨迹偏差');
  assert.equal(opportunities[0].targetFiles[0], 'SKILL.md');
  assert.equal(opportunities[1].issueId, 'issue-low');
});

test('optimization scope selects top-ranked SkillIssue opportunities and keeps deferred items', () => {
  const opportunities = deriveOpportunitiesFromAggregatedIssues([
    {
      id: 'issue-low',
      dedupKey: 'low',
      source: 'dynamic',
      severity: 'low',
      summary: '偶发低优先级问题',
      evidence: null,
      reasoning: null,
      suggestedFix: null,
      category: null,
      prevalenceCount: 10,
    },
    {
      id: 'issue-high',
      dedupKey: 'high',
      source: 'dynamic',
      severity: 'high',
      summary: '高优先级问题',
      evidence: 'trace-1',
      reasoning: 'Skill 缺少步骤。',
      suggestedFix: '补充步骤。',
      category: '轨迹偏差',
      prevalenceCount: 1,
    },
  ]);

  const scope = buildOptimizationScope(opportunities, { maxOpportunities: 1 });

  assert.equal(scope.selected.length, 1);
  assert.equal(scope.selected[0].issueId, 'issue-high');
  assert.deepEqual(scope.issueIds, ['issue-high']);
  assert.equal(scope.deferred.length, 1);
  assert.equal(scope.deferred[0].issueId, 'issue-low');
  assert.deepEqual(scope.allowedFiles, ['SKILL.md']);
});

test('optimization scope default limits select five opportunities', () => {
  const opportunities = deriveOpportunitiesFromAggregatedIssues(
    Array.from({ length: 6 }, (_, index) => ({
      id: `issue-${index}`,
      dedupKey: `issue-${index}`,
      source: 'dynamic' as const,
      severity: 'high' as const,
      summary: `高优先级问题 ${index}`,
      evidence: null,
      reasoning: null,
      suggestedFix: null,
      category: '轨迹偏差',
      prevalenceCount: 1,
    })),
  );

  const scope = buildOptimizationScope(opportunities);

  assert.equal(scope.limits.maxOpportunities, 5);
  assert.equal(scope.limits.maxFiles, 5);
  assert.equal(scope.selected.length, 5);
  assert.equal(scope.deferred.length, 1);
});

test('skill edit regions bind issues to frontmatter fields and markdown sections', () => {
  const descriptionRegions = resolveSkillEditRegionsForIssue(SKILL_MD, {
    category: 'description',
    summary: '描述冗长',
  });
  const exampleRegions = resolveSkillEditRegionsForIssue(SKILL_MD, {
    category: 'examples',
    summary: '缺少多页 PDF 示例',
  });
  const scriptRegions = resolveSkillEditRegionsForIssue(SKILL_MD, {
    category: 'scripts',
    summary: 'extract.py token 超限',
  });

  assert.equal(formatSkillEditRegion(descriptionRegions[0]), 'SKILL.md:frontmatter.description (L4)');
  assert.ok(exampleRegions.some(region => region.label === 'section:Examples'));
  assert.ok(scriptRegions.some(region => region.label === 'section:How to use'));
});

test('optimization scope exposes section-level allowed edit regions', () => {
  const opportunities = deriveOpportunitiesFromAggregatedIssues(
    [
      {
        id: 'issue-example',
        dedupKey: 'example',
        source: 'static',
        severity: 'high',
        summary: '缺少多页 PDF 示例',
        evidence: null,
        reasoning: null,
        suggestedFix: '在 Examples 中补充多页输入输出。',
        category: 'examples',
        prevalenceCount: 1,
      },
    ],
    { skillContent: SKILL_MD },
  );

  const scope = buildOptimizationScope(opportunities);

  assert.deepEqual(scope.allowedFiles, ['SKILL.md']);
  assert.equal(scope.allowedRegions.length, 1);
  assert.equal(scope.allowedRegions[0].label, 'section:Examples');
});
