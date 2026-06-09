/**
 * L1 静态规则集（确定性，零成本，每次上传都跑）。
 *
 * 维度分工（2026-06 重整后）：
 *   - structure: 形式合规（frontmatter 字段、长度上限、命名规范）
 *   - security:  威胁扫描（硬编码 secret / 可疑 URL / 运行时拉远程指令）
 *
 * 历史维度 'role' / 'content' 已删：原 role 规则全部归到 structure；
 * 现行原则：L1 只做"形式与威胁的确定性检查"，语义判断（目的适配性 / 内容一致性 等）
 * 留给 L2 LLM judge。
 *
 * 每条规则产出一个 LinterDiagnosis；orchestrator 再把它转成 SkillIssue。
 * dedupKey = ruleId，跨 evaluation 聚合时同 rule 自动归一。
 */

import matter from 'gray-matter';
import type { Severity } from '../prevalence';

export interface LinterDiagnosis {
  ruleId: string;
  severity: Severity;
  dimension: 'structure' | 'security';
  summary: string;
  evidence?: string;
  reasoning?: string;
  suggestedFix?: string;
}

const MAX_SKILL_MD_CHARS = 5000;
const MAX_SKILL_MD_LINES = 500;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 1024;
const KEBAB_CASE = /^[a-z0-9-]+$/;

// ─────────────────────────────────────────────────────────────
// Structure 规则：SKILL.md 形式检查
// ─────────────────────────────────────────────────────────────

export function lintSkillContent(content: string): LinterDiagnosis[] {
  const out: LinterDiagnosis[] = [];

  const charCount = content.length;
  const lineCount = content.split(/\r?\n/).length;

  if (charCount > MAX_SKILL_MD_CHARS) {
    out.push({
      ruleId: 'length_chars_exceeded',
      severity: 'low',
      dimension: 'structure',
      summary: 'SKILL.md 字符数超过建议上限（5000）',
      evidence: `当前 ${charCount} 字符`,
      reasoning: '渐进式披露：SKILL.md 应作为目录，详细内容外置到 references/。过长会挤占 LLM 上下文。',
      suggestedFix: '把详细 API/示例/历史记录拆到 references/ 子文件，SKILL.md 只保留索引与触发条件。',
    });
  }

  if (lineCount > MAX_SKILL_MD_LINES) {
    out.push({
      ruleId: 'length_lines_exceeded',
      severity: 'low',
      dimension: 'structure',
      summary: 'SKILL.md 行数超过建议上限（500）',
      evidence: `当前 ${lineCount} 行`,
      reasoning: '同上：SKILL.md 应作为目录索引，长内容应外置。',
      suggestedFix: '把长段落、代码块、多步骤示例拆到 references/。',
    });
  }

  // frontmatter 解析：完全缺失也视为空对象，由 missing_name / missing_description 报告，
  // 不再单独报 `frontmatter_missing`（合并到下面的字段缺失检测里，修复指引更明确）。
  let parsed: { data: Record<string, unknown>; raw: string } | null = null;
  try {
    const m = matter(content);
    parsed = { data: (m.data || {}) as Record<string, unknown>, raw: m.matter ?? '' };
  } catch (e: any) {
    out.push({
      ruleId: 'frontmatter_invalid_yaml',
      severity: 'high',
      dimension: 'structure',
      summary: 'YAML frontmatter 语法错误',
      evidence: String(e?.message || e),
      reasoning: 'YAML 解析失败，框架将无法读取 name/description。',
      suggestedFix: '修正 YAML 语法（缩进、引号、冒号空格）。',
    });
  }

  if (parsed) {
    const { data } = parsed;

    if (!('name' in data) || typeof data.name !== 'string' || !data.name.trim()) {
      out.push({
        ruleId: 'frontmatter_missing_name',
        severity: 'high',
        dimension: 'structure',
        summary: 'frontmatter 缺少 `name` 字段',
        evidence: parsed.raw || '(整个 frontmatter 块缺失)',
        reasoning: 'name 是 Skill 的主键标识，必填。',
        suggestedFix: '在 frontmatter 添加 `name: <kebab-case-name>`。如完全没有 frontmatter，请在文件开头加 ```---\\nname: ...\\ndescription: ...\\n---```。',
      });
    } else {
      const name = data.name as string;
      if (name.length > MAX_NAME_LEN) {
        out.push({
          ruleId: 'name_too_long',
          severity: 'medium',
          dimension: 'structure',
          summary: `\`name\` 长度超过 ${MAX_NAME_LEN} 字符上限`,
          evidence: `name="${name}" (${name.length} chars)`,
          reasoning: 'Skill 规范：name ≤ 64 字符。',
          suggestedFix: '缩短为简洁的 kebab-case 短语。',
        });
      }
      if (!KEBAB_CASE.test(name)) {
        out.push({
          ruleId: 'name_not_kebab_case',
          severity: 'low',
          dimension: 'structure',
          summary: '`name` 不是 kebab-case',
          evidence: `name="${name}"`,
          reasoning: '规范：仅允许小写字母、数字、连字符。',
          suggestedFix: `重命名为小写连字符形式（如 \`${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}\`）。`,
        });
      }
    }

    if (!('description' in data) || typeof data.description !== 'string' || !data.description.trim()) {
      out.push({
        ruleId: 'frontmatter_missing_description',
        severity: 'high',
        dimension: 'structure',
        summary: 'frontmatter 缺少 `description` 字段',
        evidence: parsed.raw || '(整个 frontmatter 块缺失)',
        reasoning: 'description 是 LLM 选择 Skill 时的核心信号；缺失则触发不到。',
        suggestedFix: '添加第三人称、含具体触发信号词的 description。例：`Used when the user asks to extract tables from PDF files.`',
      });
    } else {
      const desc = data.description as string;
      if (desc.length > MAX_DESC_LEN) {
        out.push({
          ruleId: 'description_too_long',
          severity: 'medium',
          dimension: 'structure',
          summary: `\`description\` 长度超过 ${MAX_DESC_LEN} 字符上限`,
          evidence: `description=${desc.length} chars`,
          reasoning: '过长 description 会挤占 LLM 上下文。',
          suggestedFix: '保留触发信号词与场景，把详细背景搬到正文。',
        });
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Security 规则：威胁扫描（agent-scan issue codes 适配）
//
// 覆盖范围：W008 / E005 / W012 三条静态规则
// （E004/E006/W007/W009/W011/W013 走 L2 LLM judge；W014 在本项目 N/A）
// ─────────────────────────────────────────────────────────────

/**
 * W008 - 硬编码 Secret 检测
 *
 * 检测策略（regex 模式 + 关键字邻近）：
 *  - 已知格式：AWS access key / GitHub token / OpenAI key / Slack token
 *  - 通用模式：(api_key|token|secret|password) = "<long string>"
 *
 * 注意：检测对象是 SKILL.md + bundle 文本拼接。命中证据要脱敏，只暴露前 4 字符。
 */
interface SecretPattern {
  name: string;
  regex: RegExp;
  // value 在 regex match 中的 group index
  valueGroup: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS Access Key', regex: /\b(AKIA[0-9A-Z]{16})\b/g, valueGroup: 1 },
  { name: 'GitHub Token', regex: /\b(gh[ps]_[A-Za-z0-9]{36,})\b/g, valueGroup: 1 },
  { name: 'OpenAI API Key', regex: /\b(sk-[A-Za-z0-9]{20,})\b/g, valueGroup: 1 },
  { name: 'Slack Token', regex: /\b(xox[bpoa]-[A-Za-z0-9-]{10,})\b/g, valueGroup: 1 },
  { name: 'Snyk Token', regex: /\b(snyk_[A-Za-z0-9_]{20,})\b/g, valueGroup: 1 },
  {
    name: '通用 API Key / Token',
    // (api_key|token|secret|password) 后跟 = 或 :，值是 16+ 字符的字符串字面量
    regex: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|auth[_-]?token|bearer)\s*[=:]\s*["']([A-Za-z0-9_\-]{16,})["']/gi,
    valueGroup: 1,
  },
];

function maskSecret(s: string): string {
  if (s.length <= 6) return '***';
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(s.length - 4, 16))}`;
}

function locateLine(text: string, index: number): number {
  // 1-based line number
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * 在已拼接的 bundle 文本里定位命中位置，返回 "scripts/foo.py:14" 形式的精确坐标。
 * - 如果 text 不含 `--- 文件: <path> ---` 标记（即 SKILL.md 单文件输入），回退到 "<fallbackLabel>:<lineNo>"
 * - 标记之后的行号是相对于该文件本身（不是 bundle 全局行号）
 */
function locateFileAndLine(text: string, index: number, fallbackLabel: string): string {
  const FILE_MARKER = '--- 文件: ';
  const MARKER_END = ' ---\n';
  const before = text.slice(0, index);
  const lastMarker = before.lastIndexOf(FILE_MARKER);
  if (lastMarker < 0) {
    // 单文件输入：行号从开头算
    return `${fallbackLabel}:${locateLine(text, index)}`;
  }
  const markerEnd = text.indexOf(MARKER_END, lastMarker);
  if (markerEnd < 0) return `${fallbackLabel}:${locateLine(text, index)}`;
  const filePath = text.slice(lastMarker + FILE_MARKER.length, markerEnd);
  // 该文件内容起点 → index 的行数
  const fileContentStart = markerEnd + MARKER_END.length;
  const linesIntoFile = text.slice(fileContentStart, index).split('\n').length;
  return `${filePath}:${linesIntoFile}`;
}

function lintHardcodedSecrets(text: string, label: string): LinterDiagnosis[] {
  if (!text) return [];
  const out: LinterDiagnosis[] = [];
  const seen = new Set<string>();
  for (const pat of SECRET_PATTERNS) {
    let m: RegExpExecArray | null;
    // 必须 clone regex 才能复用（state 在 lastIndex）
    const re = new RegExp(pat.regex.source, pat.regex.flags);
    while ((m = re.exec(text)) !== null) {
      const raw = m[pat.valueGroup];
      if (!raw) continue;
      const dedupSig = `${pat.name}:${raw.slice(0, 8)}`;
      if (seen.has(dedupSig)) continue;
      seen.add(dedupSig);
      const where = locateFileAndLine(text, m.index, label);
      out.push({
        ruleId: `security_W008_hardcoded_secret`,
        severity: 'high',
        dimension: 'security',
        summary: `${where.split(':')[0]} 含硬编码 ${pat.name}`,
        evidence: `${where} → ${maskSecret(raw)}`,
        reasoning: 'API key / token / 私钥等敏感凭据被直接嵌入 skill 文本，会随 skill 内容外泄；同时违反"凭据用环境变量"原则。',
        suggestedFix: `改为从环境变量读取（如 \`os.environ["${pat.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}"]\`），缺失时硬 throw。`,
      });
    }
  }
  return out;
}

/**
 * E005 - 可疑下载 URL 检测
 *  - 短链域名：bit.ly / tinyurl / goo.gl / t.co / ow.ly / is.gd
 *  - 可执行后缀：.exe / .dmg / .msi / .ps1（出现在 URL 路径里）
 *  - Pastebin / 个人 raw：pastebin.com/raw/ / gist.github.com/.../raw
 */
const SUSPICIOUS_URL_PATTERNS: Array<{ name: string; regex: RegExp; severity: Severity }> = [
  { name: '短链 (bit.ly 等)', regex: /https?:\/\/(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd)\/\S+/gi, severity: 'high' },
  { name: '可执行文件 URL', regex: /https?:\/\/\S+?\.(?:exe|dmg|msi|ps1)(?:\?\S*)?/gi, severity: 'high' },
  { name: 'Pastebin / Gist raw', regex: /https?:\/\/(?:pastebin\.com\/raw|gist\.githubusercontent\.com)\/\S+/gi, severity: 'medium' },
];

function lintSuspiciousUrls(text: string, label: string): LinterDiagnosis[] {
  if (!text) return [];
  const out: LinterDiagnosis[] = [];
  const seen = new Set<string>();
  for (const pat of SUSPICIOUS_URL_PATTERNS) {
    const re = new RegExp(pat.regex.source, pat.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      const where = locateFileAndLine(text, m.index, label);
      out.push({
        ruleId: `security_E005_suspicious_url`,
        severity: pat.severity,
        dimension: 'security',
        summary: `${where.split(':')[0]} 含可疑下载 URL（${pat.name}）`,
        evidence: `${where} → ${url.length > 120 ? url.slice(0, 117) + '...' : url}`,
        reasoning: '短链 / 可执行文件 / 个人代码 raw 是恶意载荷的典型分发渠道；指引用户从此类源下载可能导致 RCE。',
        suggestedFix: '改为指向官方仓库（GitHub release / npmjs / PyPI），并附 checksum 验证。',
      });
    }
  }
  return out;
}

/**
 * W012 - 运行时拉远程并执行
 *  - curl … | sh / bash
 *  - wget … | sh / bash
 *  - eval(... fetch(...) ...) / exec(requests.get(...).text)
 *  - os.system("curl ... | bash")
 */
const RUNTIME_FETCH_EXEC_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'curl|sh', regex: /curl\s+[^\n|]*\|\s*(?:sh|bash|zsh)\b/gi },
  { name: 'wget|sh', regex: /wget\s+[^\n|]*\|\s*(?:sh|bash|zsh)\b/gi },
  { name: 'eval(fetch())', regex: /eval\s*\(\s*(?:await\s+)?(?:fetch|requests\.get|axios\.get|urllib\.request\.urlopen)\b/gi },
  { name: 'exec(http content)', regex: /(?:exec|Function)\s*\(\s*(?:await\s+)?(?:fetch|requests\.get|axios\.get|urllib)/gi },
];

function lintRuntimeFetchExec(text: string, label: string): LinterDiagnosis[] {
  if (!text) return [];
  const out: LinterDiagnosis[] = [];
  const seen = new Set<string>();
  for (const pat of RUNTIME_FETCH_EXEC_PATTERNS) {
    const re = new RegExp(pat.regex.source, pat.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0];
      const sig = `${pat.name}:${hit.slice(0, 32)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const where = locateFileAndLine(text, m.index, label);
      out.push({
        ruleId: `security_W012_runtime_fetch_exec`,
        severity: 'high',
        dimension: 'security',
        summary: `${where.split(':')[0]} 运行时拉远程指令并执行（${pat.name}）`,
        evidence: `${where} → ${hit.length > 100 ? hit.slice(0, 97) + '...' : hit}`,
        reasoning: '运行时从外部 URL 拉取代码或脚本并直接执行，相当于"未验证的远程代码注入入口"，无法审计、无法 pin 版本。',
        suggestedFix: '把依赖代码内嵌到 skill 本体，或锁定到具体版本的官方包（npm/pypi）；如确需下载，先 checksum 校验再执行。',
      });
    }
  }
  return out;
}

/**
 * 入口：扫描 SKILL.md + 资产 bundle（references + scripts）里的安全风险。
 *
 * - skillContent：SKILL.md 全文，单文件输入，evidence 用 "SKILL.md:<line>"
 * - bundleText：bundle 完整拼接（永不截断版本，由 content-loader.bundleTextFull 提供），
 *   内部已带 `--- 文件: <path> ---` 标记，locateFileAndLine 会自动定位到 "<path>:<line>"
 */
export function lintSecurity(
  skillContent: string,
  bundleText: string,
): LinterDiagnosis[] {
  const out: LinterDiagnosis[] = [];
  out.push(...lintHardcodedSecrets(skillContent, 'SKILL.md'));
  out.push(...lintHardcodedSecrets(bundleText, 'bundle'));
  out.push(...lintSuspiciousUrls(skillContent, 'SKILL.md'));
  out.push(...lintSuspiciousUrls(bundleText, 'bundle'));
  out.push(...lintRuntimeFetchExec(skillContent, 'SKILL.md'));
  out.push(...lintRuntimeFetchExec(bundleText, 'bundle'));
  return out;
}
