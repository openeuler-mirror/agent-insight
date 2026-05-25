/**
 * L1 静态规则集（确定性，零成本，每次上传都跑）。
 * TS port + 扩展自 skills/skill-optimizer/scripts/engine/linter.py。
 *
 * 每条规则产出一个 LinterDiagnosis；orchestrator 再把它转成 SkillIssue。
 * dedupKey = ruleId，跨 evaluation 聚合时同 rule 自动归一。
 */

import matter from 'gray-matter';
import type { Severity } from '../prevalence';

export interface LinterDiagnosis {
  ruleId: string;
  severity: Severity;
  dimension: 'role' | 'structure' | 'content';
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

  let parsed: { data: Record<string, unknown>; raw: string } | null = null;
  try {
    const m = matter(content);
    if (!m.matter || m.matter.trim() === '') {
      out.push({
        ruleId: 'frontmatter_missing',
        severity: 'high',
        dimension: 'structure',
        summary: '缺少 YAML frontmatter',
        evidence: '文件开头未发现 `---` YAML 块',
        reasoning: 'Skill 必须以 YAML frontmatter 开头，框架据此解析 name/description。',
        suggestedFix: '在文件开头添加：\n```\n---\nname: <kebab-case-name>\ndescription: <第三人称描述>\n---\n```',
      });
    } else {
      parsed = { data: (m.data || {}) as Record<string, unknown>, raw: m.matter };
    }
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
        dimension: 'role',
        summary: 'frontmatter 缺少 `name` 字段',
        evidence: parsed.raw,
        reasoning: 'name 是 Skill 的主键标识，必填。',
        suggestedFix: '在 frontmatter 添加 `name: <kebab-case-name>`。',
      });
    } else {
      const name = data.name as string;
      if (name.length > MAX_NAME_LEN) {
        out.push({
          ruleId: 'name_too_long',
          severity: 'medium',
          dimension: 'role',
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
          dimension: 'role',
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
        dimension: 'role',
        summary: 'frontmatter 缺少 `description` 字段',
        evidence: parsed.raw,
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
