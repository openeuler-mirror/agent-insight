import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultExperimentName, displayedExperimentName } from '@/lib/engine/experiment/experiment-name';

test('实验默认名称使用当前本地日期和时间，不包含配置复用后缀', () => {
  assert.equal(
    defaultExperimentName(new Date(2026, 8, 24, 9, 5)),
    'Agent 评测 2026-09-24 09:05',
  );
});

test('历史复用标题按实验创建时间展示，普通和自定义名称保持原样', () => {
  const createdAt = new Date(2026, 8, 24, 10, 12);
  assert.equal(
    displayedExperimentName('Agent 评测 2026-09-21 18:35 · 同配置 · 同配置 · 复用评测配置', createdAt),
    'Agent 评测 2026-09-24 10:12',
  );
  assert.equal(displayedExperimentName('我的回归实验', createdAt), '我的回归实验');
  assert.equal(displayedExperimentName('我的回归实验 · 同配置', createdAt), '我的回归实验 · 同配置');
});
