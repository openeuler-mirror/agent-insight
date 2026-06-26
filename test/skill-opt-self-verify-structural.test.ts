import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { verifyStructure } from '@/lib/engine/skill-opt/self-verify-structural';

// 优化器改完后的【结构自验证门 ①】单测。纯确定性、零 LLM。
// 验三件事：引用文件存在、脚本能编译、以及——关键——结构门**抓不到**「能编译却答错」
// 的语义 bug（年份案就是它，留给行为门 ② 抓），这条边界本身就是设计意图。

function hasPython(): boolean {
  try { execFileSync('python3', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}
const PY = hasPython();

const SKILL_MD = (body: string) => `---\nname: demo\ndescription: d\n---\n${body}`;

test('referenced-files: SKILL.md 引用的脚本都存在 → 过', () => {
  const r = verifyStructure({
    'SKILL.md': SKILL_MD('先运行 `scripts/analyze.py`，所有数字引用其输出。'),
    'scripts/analyze.py': 'print("ok")\n',
  });
  const ref = r.checks.find((c) => c.name === 'referenced-files');
  assert.equal(ref?.pass, true, '引用齐全应通过');
});

test('referenced-files: SKILL.md 引用了不存在的脚本 → 失败并点名', () => {
  const r = verifyStructure({
    'SKILL.md': SKILL_MD('运行 `scripts/missing.py` 做统计。'),
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures.join(' ').includes('scripts/missing.py'), '失败摘要应点名缺失文件');
});

test('referenced-files: 带 folder 前缀的 SKILL.md 也能解析引用', () => {
  // findSkillMd 会把 demo-skill/SKILL.md 当根；引用按裸相对解析
  const r = verifyStructure({
    'demo-skill/SKILL.md': SKILL_MD('见 `scripts/run.sh`'),
    'demo-skill/scripts/run.sh': 'echo hi\n',
  }, { skillMdKey: 'demo-skill/SKILL.md' });
  const ref = r.checks.find((c) => c.name === 'referenced-files');
  assert.equal(ref?.pass, true);
});

test('no SKILL.md → 结构门失败', () => {
  const r = verifyStructure({ 'scripts/x.py': 'print(1)\n' });
  assert.equal(r.ok, false);
  assert.ok(r.failures.join(' ').includes('SKILL.md'));
});

test('compile: 合法 python 脚本 → 过', { skip: !PY ? 'python3 不可用' : false }, () => {
  const r = verifyStructure({
    'SKILL.md': SKILL_MD('见 `scripts/ok.py`'),
    'scripts/ok.py': 'import re\nx = re.compile(r"\\d+")\nprint(x)\n',
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('compile: 语法错的 python → 失败', { skip: !PY ? 'python3 不可用' : false }, () => {
  const r = verifyStructure({
    'SKILL.md': SKILL_MD('见 `scripts/bad.py`'),
    'scripts/bad.py': 'def (:\n  pass\n', // 故意语法错
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures.join(' ').includes('scripts/bad.py'), '应点名编译失败的脚本');
});

test('设计边界：年份 bug 脚本「能编译却答错」→ 结构门放行（语义留给行为门 ②）', { skip: !PY ? 'python3 不可用' : false }, () => {
  // 这是真实事故脚本的最小复刻：RE_YEAR 对真日志匹配 0 行 → 回落 now().year=2026。
  // 它**语法完全合法**，所以结构门 ① 一定放行——正说明必须有行为门 ② 真跑+判官才抓得到。
  const buggyYear = [
    'import re, datetime',
    "RE_YEAR = re.compile(r'\\bat\\s+\\S+\\s+(\\d{4})\\b')  # 对 'at Fri Jun 17 ... 2005' 匹配不到",
    'def extract_year(line):',
    '    m = RE_YEAR.search(line)',
    '    return int(m.group(1)) if m else datetime.datetime.now().year',
    'print(extract_year("... at Fri Jun 17 07:07:00 2005"))',
  ].join('\n') + '\n';
  const r = verifyStructure({
    'SKILL.md': SKILL_MD('运行 `scripts/analyze_logs.py`，年份逐字引用其输出。'),
    'scripts/analyze_logs.py': buggyYear,
  });
  assert.equal(r.ok, true, '结构门对语法合法的脚本必放行——语义正确性是行为门的职责');
});
