import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SKILL_MANAGEMENT_MAX_PAGE_SIZE,
  SKILL_MANAGEMENT_PAGE_SIZE,
  parseSkillManagementQuery,
} from '../src/lib/skill-workbench/skill-management';

test('管理中心默认按 9 项分页并忽略未知来源', () => {
  const query = parseSkillManagementQuery(new URLSearchParams('source=legacy'));
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, SKILL_MANAGEMENT_PAGE_SIZE);
  assert.equal(query.source, 'all');
});

test('管理中心分页参数有正数校验和上限', () => {
  const query = parseSkillManagementQuery(new URLSearchParams('page=-3&pageSize=999'));
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, SKILL_MANAGEMENT_MAX_PAGE_SIZE);
});

test('管理中心查询会规范化空白并限制输入长度', () => {
  const query = parseSkillManagementQuery(new URLSearchParams({
    search: `  ${'a'.repeat(120)}  `,
    category: '  诊断  ',
    source: 'uploaded',
  }));
  assert.equal(query.search.length, 100);
  assert.equal(query.category, '诊断');
  assert.equal(query.source, 'uploaded');
});
