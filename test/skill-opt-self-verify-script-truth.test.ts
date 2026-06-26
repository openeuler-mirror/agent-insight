import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyScriptTruth, makeYearAssertion, makeNumericAssertion, type ScriptAssertion } from '@/lib/engine/skill-opt/self-verify-structural';

// 脚本真值门（①.5）单测——引擎是通用的（跑脚本、执行声明的任意断言）；年份是其中一条
// 数据集驱动推导出的断言。覆盖：真值年份过/不过、log_year=None、回显假阳、非日期脚本跳过、
// 多脚本容错、以及「执行任意断言」的通用性。

function hasPython(): boolean { try { execFileSync('python3', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } }
const PY = hasPython();
const SKIP = !PY ? 'python3 不可用' : false;

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'truth-log-')), 'messages');
fs.writeFileSync(LOG, 'Jun 17 07:07:00 combo ftpd[1]: connection from 1.2.3.4 at Fri Jun 17 07:07:00 2005\n');
const SKILL = '---\nname: d\n---\n运行 `scripts/a.py`';
const py = (body: string) => `import sys\nif __name__ == '__main__':\n${body}\n`;
const YEAR2005: ScriptAssertion[] = [makeYearAssertion('2005')];

test('脚本算出 2005 → 过', { skip: SKIP }, () => {
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"first_event_time\": \"2005-06-14T07:07:00\"}')") }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('脚本算出 2026 不含 2005（run C 类）→ 失败', { skip: SKIP }, () => {
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"first_event_time\": \"2026-06-14T07:07:00\"}')") }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, false);
  assert.ok(r.failures.join(' ').includes('2026') && r.failures.join(' ').includes('2005'));
});

test('有日期字段但没算出年份（e2e log_year=None 类）→ 失败', { skip: SKIP }, () => {
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"log_year\": null, \"first_event_time\": \"\"}')") }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, false);
  assert.ok(r.failures.join(' ').includes('没算出任何年份'));
});

test('回显原始日志里的 2005 不算「算对」（e2e 假阳回归）→ 失败', { skip: SKIP }, () => {
  const body = "    print('{\"log_year\": null, \"first_event_time\": \"\", \"samples\": [{\"text\": \"connection at Fri Jun 17 07:07:00 2005\"}]}')";
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py(body) }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, false, '回显的 2005 不在 ISO 时间戳/year 字段里，不该当成算对');
});

test('输出无日期字段（非日期脚本）→ 断言跳过、不误伤', { skip: SKIP }, () => {
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"matched\": 999}')") }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.skipped && c.name.includes('year')), '年份断言应因无日期字段而跳过');
});

test('多脚本：主脚本算对、另一脚本崩 → 仍过（单脚本崩被容忍）', { skip: SKIP }, () => {
  const r = verifyScriptTruth({
    'SKILL.md': SKILL,
    'scripts/a.py': py("    print('{\"first_event_time\": \"2005-06-14T07:07:00\"}')"),
    'scripts/helper.py': py('    raise SystemExit(2)'),
  }, { logPath: LOG, assertions: YEAR2005 });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('通用引擎：执行任意声明的断言（非年份）', { skip: SKIP }, () => {
  const hasMatched: ScriptAssertion = { id: 'has-matched', describe: 'stdout 须含 MATCHED', check: (out) => ({ pass: out.includes('MATCHED'), detail: out.includes('MATCHED') ? 'ok' : '缺 MATCHED' }) };
  const good = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('RESULT: MATCHED 999')") }, { logPath: LOG, assertions: [hasMatched] });
  assert.equal(good.ok, true);
  const bad = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('RESULT: none')") }, { logPath: LOG, assertions: [hasMatched] });
  assert.equal(bad.ok, false);
});

test('数值断言：算出值含期望→过 / 不含→失败 / 仅引号串回显→跳过', { skip: SKIP }, () => {
  const A: ScriptAssertion[] = [makeNumericAssertion('总数', '1815')];
  assert.equal(verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"total\": 1815}')") }, { logPath: LOG, assertions: A }).ok, true);
  assert.equal(verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"total\": 906}')") }, { logPath: LOG, assertions: A }).ok, false);
  // 1815 只出现在引号串里（回显）→ 非值位 → 跳过、不算「算对」
  const echoed = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('{\"text\": \"matched 1815 lines\"}')") }, { logPath: LOG, assertions: A });
  assert.ok(echoed.checks.some((c) => c.skipped));
});

test('空断言 → 整体跳过（诚实 no-op）', () => {
  const r = verifyScriptTruth({ 'SKILL.md': SKILL, 'scripts/a.py': py("    print('x')") }, { logPath: LOG, assertions: [] });
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.skipped));
});
