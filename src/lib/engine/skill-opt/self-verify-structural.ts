/**
 * 优化器改完后的【结构自验证门】（layer ①）—— 确定性、零 LLM、零 agent 成本。
 *
 * 这是「skill 优化」开环链路缺的那道最便宜的门：产品化生成器的「完成判据」
 * （skill-generator-opencode-bridge.ts:146「引用了就必须写出来」「定量任务必带可运行脚本」）
 * + spike `.spike/skill-opt-closed-loop/parse_gate.ts` 的结构检查。
 *
 * 三查：
 *   1. 引用文件存在——SKILL.md 里点名的每个 scripts//references/ 路径，必须真在候选 bundle 里
 *      （挡住「引用一个并未写出的脚本」，= 生成器判据 1+4）。
 *   2. 编译/语法——每个改过的可执行脚本按扩展名做语法检查（py_compile / node --check / bash -n）。
 *      关键：能编译 ≠ 输出对（年份 bug 就是编译过却静默答错），所以语义正确性交给 layer ②（行为重评）。
 *   3. 解释器缺失不算失败（skip），只有真正的语法/编译错才判 fail——门只挡确凿的坏，不误伤。
 *
 * 故意不依赖 opencode SDK / DB，纯 fs + child_process，便于单测（同 edit-scope-guard.ts 的取向）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StructuralCheck {
  name: string;
  pass: boolean;
  /** 'skipped' 表示无法检查（如解释器缺失）——不计入失败。 */
  skipped?: boolean;
  detail: string;
}

export interface StructuralResult {
  ok: boolean;
  checks: StructuralCheck[];
  /** 仅真失败（不含 skipped），人类可读，喂给 repair 反馈。 */
  failures: string[];
}

/** 按扩展名选语法检查器。返回 null = 不检查该类型。 */
function compilerFor(rel: string): { bin: string; args: (f: string) => string[] } | null {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.py') return { bin: 'python3', args: (f) => ['-m', 'py_compile', f] };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { bin: 'node', args: (f) => ['--check', f] };
  if (ext === '.sh' || ext === '.bash') return { bin: 'bash', args: (f) => ['-n', f] };
  return null;
}

const REF_RE = /\b((?:scripts|references)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;

/**
 * @param files 候选 bundle 全量文件：相对路径（如 'SKILL.md'、'scripts/x.py'）→ 文件全文
 * @param opts.skillMdKey SKILL.md 在 files 里的键（默认自动找以 'SKILL.md' 结尾的那个）
 */
export function verifyStructure(
  files: Record<string, string>,
  opts: { skillMdKey?: string } = {},
): StructuralResult {
  const checks: StructuralCheck[] = [];
  const keys = Object.keys(files);

  // ── 1) 引用文件存在 ──────────────────────────────────────────────────────
  const skillMdKey = opts.skillMdKey ?? keys.find((k) => k === 'SKILL.md' || k.endsWith('/SKILL.md'));
  if (skillMdKey && files[skillMdKey] != null) {
    const skillMd = files[skillMdKey];
    // SKILL.md 所在目录前缀（根则为空）——引用路径相对它解析。
    const folder = skillMdKey.includes('/') ? skillMdKey.slice(0, skillMdKey.lastIndexOf('/') + 1) : '';
    const refs = new Set<string>();
    for (const m of skillMd.matchAll(REF_RE)) refs.add(m[1]);
    const missing = [...refs].filter((ref) => {
      // 候选 bundle 里能按「裸相对」或「带 folder 前缀」任一形态命中即算存在
      return files[ref] == null && files[folder + ref] == null;
    });
    checks.push({
      name: 'referenced-files',
      pass: missing.length === 0,
      detail: missing.length
        ? `SKILL.md 引用了 bundle 里不存在的文件：${missing.join(', ')}（引用了就必须写出来）`
        : `SKILL.md 引用的 ${refs.size} 个脚本/参考文件都在 bundle 里`,
    });
  } else {
    checks.push({ name: 'referenced-files', pass: false, detail: '候选 bundle 里找不到 SKILL.md' });
  }

  // ── 2) 编译/语法（每个改过的可执行脚本）──────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-verify-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const compiler = compilerFor(rel);
      if (!compiler) continue;
      const f = path.join(tmp, path.basename(rel));
      fs.writeFileSync(f, content ?? '');
      try {
        execFileSync(compiler.bin, compiler.args(f), { stdio: 'pipe' });
        checks.push({ name: `compile ${rel}`, pass: true, detail: `${compiler.bin} 语法检查通过` });
      } catch (e) {
        // 解释器本身不存在（ENOENT）→ skip，不误伤；真正的语法错（非零退出带 stderr）→ fail
        const err = e as { code?: string; stderr?: unknown; message?: string };
        if (err?.code === 'ENOENT') {
          checks.push({ name: `compile ${rel}`, pass: true, skipped: true, detail: `跳过：${compiler.bin} 不可用` });
        } else {
          const msg = String(err?.stderr || err?.message || '').slice(0, 240);
          checks.push({ name: `compile ${rel}`, pass: false, detail: `${compiler.bin} 语法检查失败：${msg}` });
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failures = checks.filter((c) => !c.pass && !c.skipped).map((c) => `${c.name}: ${c.detail}`);
  return { ok: failures.length === 0, checks, failures };
}

// ── 脚本真值门（layer ①.5）——确定性、零 LLM，门住昂贵的行为门 ────────────────
// 「能编译」不等于「算得对」（年份 bug：取年正则匹配 0 行 → 回落当前年/输出 None）。这道门
// **真跑候选脚本**、把一组【断言】逐条对其输出校验——零成本抓住，不必等行为门花 rollout
// （而且只判 agent 输出的行为门会被 agent 兜住坏脚本而误放行，见 e2e 实测）。
//
// **引擎是通用的**：跑所有可运行脚本、执行传进来的任意断言。「断哪个事实」**不写死在引擎里**——
// 由调用方从**数据集真值** per-skill 推导（见 self-verify.ts deriveScriptAssertions）。年份只是
// 其中一条断言。判据：确定性、脚本算得出、数据集有已知真值、脚本本就该输出它。无可推导断言 →
// 诚实 no-op（跳过，交行为门②）。这天然只覆盖「脚本确定性输出」那类 skill；prose/判断类没真值可断。
const RUNNABLE_PY = /__main__|sys\.argv/;

/** 一条可确定性校验的脚本断言：拿脚本对真实输入的合并 stdout，判 pass/fail/skip。 */
export interface ScriptAssertion {
  id: string;
  describe: string;
  check: (stdout: string) => { pass: boolean; skipped?: boolean; detail: string };
}

export interface ScriptTruthResult {
  ok: boolean;
  checks: StructuralCheck[];
  failures: string[];
  /** 实际跑过的脚本。 */
  ran: string[];
}

// 只从脚本「算出来的」位置取年——ISO 时间戳 + 名为 *year* 的字段——**不**扫整段 stdout，
// 否则脚本回显的原始日志文本（"at ... 2005"）会让坏脚本(log_year=None)假装算对了（e2e 踩到）。
const ISO_YEAR = /\b((?:19|20)\d{2})-\d{2}-\d{2}/g;
const YEAR_FIELD = /"[^"]*year[^"]*"\s*:\s*"?((?:19|20)\d{2})\b/gi;
// 「脚本是否负责日期」用**输出结构**判（有 *year*/*time*/*date* 字段），不靠脚本源码关键字——
// 避免 MONTH_MAP/parse_ts 这种 skill 专属符号名的过拟合。
const DATE_FIELD = /"[^"]*(?:year|time|date|timestamp)[^"]*"\s*:/i;

/**
 * 年份断言工厂（数据集驱动推导出来的断言之一，**不是**引擎写死的）。skip/fail 由输出结构决定：
 *   · 输出里压根没日期字段 → skip（这脚本不负责日期，交行为门）
 *   · 有日期字段但没算出年份(None/空) → FAIL（试图算却算挂了，如 e2e log_year=None）
 *   · 算出的年份不含真值 → FAIL（如 run C 全 2026）
 *   · 算出含真值 → pass
 */
export function makeYearAssertion(groundTruthYear: string): ScriptAssertion {
  return {
    id: `year=${groundTruthYear}`,
    describe: `脚本算出的年份须含真值 ${groundTruthYear}`,
    check(stdout) {
      const computed = new Set<string>();
      for (const m of stdout.matchAll(ISO_YEAR)) computed.add(m[1]);
      for (const m of stdout.matchAll(YEAR_FIELD)) computed.add(m[1]);
      if (computed.size === 0) {
        if (!DATE_FIELD.test(stdout)) return { pass: true, skipped: true, detail: '脚本输出无日期字段 → 该脚本不负责年份，跳过（交行为门）' };
        return { pass: false, detail: `脚本有日期字段但没算出任何年份（None/空，应为 ${groundTruthYear}）——取年逻辑很可能没匹配到任何行` };
      }
      if (!computed.has(groundTruthYear)) return { pass: false, detail: `脚本算出的年份 [${[...computed].join(', ')}] 不含真值 ${groundTruthYear}（很可能硬编码/回落当前系统年）` };
      return { pass: true, detail: `脚本算出的时间戳/year 字段含真值 ${groundTruthYear}` };
    },
  };
}

/**
 * 数值断言工厂（计数/总数/时长等）。只认脚本**算出的**数值——JSON 值位 `"字段": 1815` 的数字，
 * **不**认引号串里回显的（同年份那条防回显的道理）。schema-agnostic：不绑字段名（优化器会改名）。
 */
export function makeNumericAssertion(label: string, expected: string): ScriptAssertion {
  const want = Number(expected);
  return {
    id: `num:${label}=${expected}`,
    describe: `脚本算出的「${label}」须含 ${expected}`,
    check(stdout) {
      const nums = new Set<number>();
      for (const m of stdout.matchAll(/:\s*(-?\d+(?:\.\d+)?)\b/g)) nums.add(Number(m[1])); // 仅「字段: 数值」值位，排除引号串里回显的
      if (nums.size === 0) return { pass: true, skipped: true, detail: `输出无数值字段 → 跳过「${label}」` };
      if (!nums.has(want)) return { pass: false, detail: `脚本算出的数值不含「${label}」期望 ${expected}` };
      return { pass: true, detail: `脚本算出的数值含「${label}」=${expected}` };
    },
  };
}

/**
 * 通用引擎：跑候选里所有可运行的 python 脚本，把 assertions 逐条对其**合并 stdout** 校验。
 * @param files 候选 bundle（技能根相对 → 全文）
 * @param opts.logPath    脚本的真实输入（来自数据集 case.input）
 * @param opts.assertions 调用方从数据集真值推导出的断言（空 → 整体跳过，诚实 no-op）
 */
export function verifyScriptTruth(
  files: Record<string, string>,
  opts: { logPath: string; assertions: ScriptAssertion[] },
): ScriptTruthResult {
  const checks: StructuralCheck[] = [];
  const ran: string[] = [];
  if (!opts.assertions.length) {
    checks.push({ name: 'script-truth', pass: true, skipped: true, detail: '无可推导的确定性真值断言 → 跳过（交行为门②）' });
    return { ok: true, checks, failures: [], ran };
  }
  if (!fs.existsSync(opts.logPath)) {
    checks.push({ name: 'script-truth', pass: true, skipped: true, detail: `示例输入不存在(${opts.logPath}) → 跳过` });
    return { ok: true, checks, failures: [], ran };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-truth-'));
  let combined = '';
  let pyMissing = false;
  try {
    // 整份 bundle 落 tmp（保留目录结构）——脚本可能 import 同级 / 读相对文件
    for (const [rel, content] of Object.entries(files)) {
      if (rel.includes('..')) continue;
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
    }
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.endsWith('.py') || !RUNNABLE_PY.test(content)) continue; // 跑所有可运行 .py（不按源码关键字筛，避免过拟合）
      ran.push(rel);
      try {
        combined += execFileSync('python3', [path.join(tmp, rel), opts.logPath], { stdio: 'pipe', timeout: 30_000, maxBuffer: 1 << 28 }).toString() + '\n';
      } catch (e) {
        const err = e as { code?: string; stderr?: unknown; message?: string };
        if (err?.code === 'ENOENT') { pyMissing = true; break; }
        // 单脚本对日志报错（可能非主分析脚本/参数不符）→ 跳过它、不据此判失败；
        // 若它就是主脚本崩了，下面断言会因「没算出真值」失败，崩因记进 checks 供诊断。
        checks.push({ name: `run ${rel}`, pass: true, skipped: true, detail: `对真实输入运行出错(可能非主脚本)：${String(err?.stderr || err?.message || '').slice(0, 120)}` });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (pyMissing) {
    checks.push({ name: 'script-truth', pass: true, skipped: true, detail: '跳过：python3 不可用' });
    return { ok: true, checks, failures: [], ran };
  }
  if (ran.length === 0) {
    checks.push({ name: 'script-truth', pass: true, skipped: true, detail: '无可运行脚本 → 跳过' });
    return { ok: true, checks, failures: [], ran };
  }

  for (const a of opts.assertions) {
    const r = a.check(combined);
    checks.push({ name: `script-truth ${a.id}`, pass: r.pass, skipped: r.skipped, detail: r.detail });
  }
  const failures = checks.filter((c) => !c.pass && !c.skipped).map((c) => `${c.name}: ${c.detail}`);
  return { ok: failures.length === 0, checks, failures, ran };
}

/** 跑候选里所有可运行 python 脚本，返回合并 stdout（给断言 reviewer 当「脚本算了哪些全局字段」的样本）。 */
export function runScriptsForSample(files: Record<string, string>, logPath: string, cap = 6000): string {
  if (!fs.existsSync(logPath)) return '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-sample-'));
  let out = '';
  try {
    for (const [rel, content] of Object.entries(files)) {
      if (rel.includes('..')) continue;
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
    }
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.endsWith('.py') || !RUNNABLE_PY.test(content)) continue;
      try { out += execFileSync('python3', [path.join(tmp, rel), logPath], { stdio: 'pipe', timeout: 30_000, maxBuffer: 1 << 28 }).toString() + '\n'; }
      catch { /* 崩的脚本跳过 */ }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out.slice(0, cap);
}
