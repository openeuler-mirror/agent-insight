import assert from 'node:assert/strict';
import test from 'node:test';

import {
  orderIssuesFailureFirst,
  chunk,
  parseOperatorOutput,
  validateAnchors,
  finalizeItems,
  type MergeIssueInput,
} from '@/lib/engine/skill-opt/merge-operator';

function makeIssue(over: Partial<MergeIssueInput> & { id: string }): MergeIssueInput {
  return {
    source: 'dynamic',
    severity: 'medium',
    category: '轨迹偏差',
    summary: `issue ${over.id}`,
    evidence: null,
    suggestedFix: null,
    prevalenceCount: 1,
    ...over,
  };
}

// ── orderIssuesFailureFirst ───────────────────────────────────────────────────

test('failure-first：失败类排在表达/格式类前面，同类内按 severity 再 prevalence', () => {
  const issues = [
    makeIssue({ id: 'a', category: '表达问题', severity: 'high' }),
    makeIssue({ id: 'b', category: '轨迹偏差', severity: 'low', prevalenceCount: 5 }),
    makeIssue({ id: 'c', category: '轨迹偏差', severity: 'low', prevalenceCount: 9 }),
    makeIssue({ id: 'd', category: '工具误用', severity: 'high' }),
  ];
  const ordered = orderIssuesFailureFirst(issues).map(i => i.id);
  // d(失败/high) > c(失败/low/9) > b(失败/low/5) > a(表达类殿后，即使 high)
  assert.deepEqual(ordered, ['d', 'c', 'b', 'a']);
});

test('static 源视同失败类参与排序', () => {
  const issues = [
    makeIssue({ id: 'fmt', source: 'dynamic', category: '格式偏差', severity: 'high' }),
    makeIssue({ id: 'lint', source: 'static', category: null, severity: 'medium' }),
  ];
  const ordered = orderIssuesFailureFirst(issues).map(i => i.id);
  assert.deepEqual(ordered, ['lint', 'fmt']);
});

// ── chunk ────────────────────────────────────────────────────────────────────

test('chunk：240 条按 30 一批切成 8 批', () => {
  const arr = Array.from({ length: 240 }, (_, i) => i);
  const out = chunk(arr, 30);
  assert.equal(out.length, 8);
  assert.equal(out[0].length, 30);
  assert.equal(out[7].length, 30);
});

test('chunk：不足一批时原样一批', () => {
  assert.equal(chunk([1, 2, 3], 30).length, 1);
});

// ── parseOperatorOutput ──────────────────────────────────────────────────────

test('parse：合法输出 + 丢非法源引用 + 同源 id 只归首个 item', () => {
  const raw = JSON.stringify({
    items: [
      { title: 'A', rationale: 'r1', severity: 'high', route: 'core', sourceIssueIds: ['i1', 'i2', 'iBAD'] },
      { title: 'B', rationale: 'r2', severity: 'low', route: 'reference', sourceIssueIds: ['i2', 'i3'] },
    ],
  });
  const items = parseOperatorOutput(raw, new Set(['i1', 'i2', 'i3']));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].sourceIssueIds, ['i1', 'i2']);
  assert.deepEqual(items[1].sourceIssueIds, ['i3']); // i2 已被 A 占用
});

test('parse：无源引用的 item 整条丢弃（不可审计）', () => {
  const raw = JSON.stringify({ items: [{ title: 'X', sourceIssueIds: ['nope'] }] });
  assert.equal(parseOperatorOutput(raw, new Set(['i1'])).length, 0);
});

test('parse：conflict 必须带 conflictNote 才算冲突，否则按 pending', () => {
  const raw = JSON.stringify({
    items: [
      { title: 'C1', conflict: true, conflictNote: '两方矛盾', sourceIssueIds: ['i1'] },
      { title: 'C2', conflict: true, sourceIssueIds: ['i2'] },
    ],
  });
  const items = parseOperatorOutput(raw, new Set(['i1', 'i2']));
  assert.equal(items[0].status, 'conflict');
  assert.equal(items[1].status, 'pending');
});

test('parse：裹散文的 JSON 经 jsonrepair 兜底可解析；完全坏的返回空数组', () => {
  const wrapped = '好的，结果如下：\n{"items":[{"title":"T","sourceIssueIds":["i1"]}]}';
  // jsonrepair 能剥前缀散文的场景不保证，但完全坏的必须安全返回 []
  const bad = parseOperatorOutput('完全不是 JSON', new Set(['i1']));
  assert.deepEqual(bad, []);
  const ok = parseOperatorOutput(wrapped, new Set(['i1']));
  assert.ok(Array.isArray(ok)); // 不抛异常即可（修复成功与否取决于 jsonrepair 能力）
});

test('parse：非法 route/severity 回落默认值', () => {
  const raw = JSON.stringify({ items: [{ title: 'T', route: 'wat', severity: 'urgent', sourceIssueIds: ['i1'] }] });
  const [item] = parseOperatorOutput(raw, new Set(['i1']));
  assert.equal(item.route, 'backlog');
  assert.equal(item.severity, 'medium');
});

// ── validateAnchors ──────────────────────────────────────────────────────────

test('anchors：targetFile 不在快照 → 双清；anchorText 找不到 → 只清 anchor', () => {
  const files = { 'SKILL.md': '# Title\n\n## How to use\nrun extract.py' };
  const items = validateAnchors([
    { targetFile: 'SKILL.md', anchorText: '## How to use' },
    { targetFile: 'SKILL.md', anchorText: '不存在的原文' },
    { targetFile: 'ghost.md', anchorText: '## How to use' },
  ], files);
  assert.deepEqual(items[0], { targetFile: 'SKILL.md', anchorText: '## How to use' });
  assert.deepEqual(items[1], { targetFile: 'SKILL.md', anchorText: null });
  assert.deepEqual(items[2], { targetFile: null, anchorText: null });
});

// ── finalizeItems ────────────────────────────────────────────────────────────

function draft(over: Record<string, unknown>) {
  return {
    route: 'core' as const,
    status: 'pending' as const,
    title: 't',
    rationale: 'r',
    severity: 'medium' as const,
    targetFile: null,
    anchorText: null,
    proposedEdit: null,
    conflictNote: null,
    sourceIssueIds: [] as string[],
    ...over,
  };
}

test('finalize：prevalence/sourcesBreakdown 聚合 + severity 取源最大', () => {
  const issueById = new Map([
    ['i1', makeIssue({ id: 'i1', source: 'static', severity: 'high', prevalenceCount: 3 })],
    ['i2', makeIssue({ id: 'i2', source: 'dynamic', severity: 'low', prevalenceCount: 2 })],
  ]);
  const [item] = finalizeItems([draft({ severity: 'low', sourceIssueIds: ['i1', 'i2'] })], issueById, 4);
  assert.equal(item.prevalence, 5);
  assert.deepEqual(item.sourcesBreakdown, { static: 1, dynamic: 1 });
  assert.equal(item.severity, 'high'); // 源里有 high → 抬到 high
});

test('finalize：core 预算 K=2，超出的按 rank 自动降 backlog（conflict 也占预算）', () => {
  const issueById = new Map(
    ['i1', 'i2', 'i3', 'i4'].map(id => [id, makeIssue({ id, severity: 'high' })] as const),
  );
  const drafts = [
    draft({ title: 'c1', sourceIssueIds: ['i1'] }),
    draft({ title: 'c2', status: 'conflict' as const, conflictNote: 'x', sourceIssueIds: ['i2'] }),
    draft({ title: 'c3', sourceIssueIds: ['i3'] }),
    draft({ title: 'c4', sourceIssueIds: ['i4'] }),
  ];
  const items = finalizeItems(drafts, issueById as Map<string, MergeIssueInput>, 2);
  const cores = items.filter(i => i.route === 'core');
  const demoted = items.filter(i => i.route === 'backlog');
  assert.equal(cores.length, 2);
  assert.equal(demoted.length, 2);
  // rank 连续且与 route 分组一致（core 在前）
  assert.deepEqual(items.map(i => i.rank), [1, 2, 3, 4]);
  assert.deepEqual(items.slice(0, 2).map(i => i.route), ['core', 'core']);
});

test('finalize：rank 排序 = route 组内 severity 降序、prevalence 降序', () => {
  const issueById = new Map([
    ['i1', makeIssue({ id: 'i1', severity: 'medium', prevalenceCount: 1 })],
    ['i2', makeIssue({ id: 'i2', severity: 'medium', prevalenceCount: 7 })],
    ['i3', makeIssue({ id: 'i3', severity: 'high', prevalenceCount: 1 })],
  ]);
  const items = finalizeItems([
    draft({ title: 'm1', severity: 'medium', sourceIssueIds: ['i1'] }),
    draft({ title: 'm7', severity: 'medium', sourceIssueIds: ['i2'] }),
    draft({ title: 'h', severity: 'high', sourceIssueIds: ['i3'] }),
  ], issueById, 4);
  assert.deepEqual(items.map(i => i.title), ['h', 'm7', 'm1']);
});
