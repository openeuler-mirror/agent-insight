import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enforceEditScope } from '@/lib/engine/skill-opt/edit-scope-guard';

function tmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'editscope-'));
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  return d;
}

function baselineOf(files: Record<string, string>) {
  // 模拟 scanWorkspaceFiles 的产物：key=/workspace/<rel>, content=lines[]
  const out: Record<string, any> = {};
  for (const [rel, content] of Object.entries(files)) {
    out[`/workspace/${rel}`] = { content: content.split('\n'), created_at: '', modified_at: '' };
  }
  return out;
}

test('禁删守卫：优化器删掉基线脚本 → 自动还原', () => {
  const ws = tmpWorkspace();
  const baseFiles = { 'SKILL.md': '# skill\nrun analyze_logs.py', 'scripts/analyze_logs.py': 'print(1)\nprint(2)' };
  for (const [rel, c] of Object.entries(baseFiles)) fs.writeFileSync(path.join(ws, rel), c);
  const baseline = baselineOf(baseFiles);

  // agent 删掉 analyze_logs.py
  fs.rmSync(path.join(ws, 'scripts/analyze_logs.py'));
  assert.ok(!fs.existsSync(path.join(ws, 'scripts/analyze_logs.py')), '前置：已删除');

  const r = enforceEditScope(ws, baseline, { maxChangedLines: 0 });
  assert.deepEqual(r.restored, ['scripts/analyze_logs.py']);
  assert.ok(fs.existsSync(path.join(ws, 'scripts/analyze_logs.py')), '还原后文件存在');
  assert.equal(fs.readFileSync(path.join(ws, 'scripts/analyze_logs.py'), 'utf-8'), 'print(1)\nprint(2)');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('编辑预算：改动行数超阈值 → overBudget=true（不回滚）', () => {
  const ws = tmpWorkspace();
  const baseFiles = { 'SKILL.md': 'a\nb\nc' };
  fs.writeFileSync(path.join(ws, 'SKILL.md'), baseFiles['SKILL.md']);
  const baseline = baselineOf(baseFiles);

  // 大改：整段重写（>2 行变化）
  fs.writeFileSync(path.join(ws, 'SKILL.md'), 'X\nY\nZ\nW\nV');
  const r = enforceEditScope(ws, baseline, { maxChangedLines: 2 });
  assert.equal(r.restored.length, 0);
  assert.ok(r.changedLines > 2, `changedLines=${r.changedLines} 应>2`);
  assert.equal(r.overBudget, true);
  // 不自动回滚：内容仍是改后的
  assert.equal(fs.readFileSync(path.join(ws, 'SKILL.md'), 'utf-8'), 'X\nY\nZ\nW\nV');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('正常小改：不超预算、无删除 → 无动作', () => {
  const ws = tmpWorkspace();
  const baseFiles = { 'SKILL.md': 'a\nb\nc', 'scripts/x.sh': 'echo hi' };
  for (const [rel, c] of Object.entries(baseFiles)) fs.writeFileSync(path.join(ws, rel), c);
  const baseline = baselineOf(baseFiles);

  fs.writeFileSync(path.join(ws, 'SKILL.md'), 'a\nb\nc\nd'); // 加一行
  const r = enforceEditScope(ws, baseline, { maxChangedLines: 10 });
  assert.equal(r.restored.length, 0);
  assert.equal(r.overBudget, false);
  fs.rmSync(ws, { recursive: true, force: true });
});
