/**
 * Skill 优化 Agent 的 system prompt 构造。
 *
 * 设计取自 docs/plans/2026-05-08-skill-opt-chat-backend-design.md：
 *  - 把用户在前端勾选的 issues 结构化注入（id / severity / category / summary / evidence）
 *  - 借鉴 trace2skill 的 prevalence 思路：多 issue 指向同一处时让 agent 合并
 *  - 要求 agent 收尾报告里回引 issue id，便于前端后续在列表上打"已处理"标
 *
 * 与 skill-generator 的内置 prompt 不同——那个让 agent 从零生成；这里 cwd 已经有
 * 现成的 SKILL.md / scripts/ / references/，agent 应该 read-then-edit，不要新建副本。
 */

export interface SkillOptIssueLite {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category?: string;
  summary: string;
  evidence?: string;
  /** 评估器给的"在 SKILL.md 哪段加什么"具体建议；可空。直接喂 prompt，让 agent 优先按这条做。 */
  improvementSuggestion?: string;
}

export interface BuildSkillOptPromptArgs {
  skillName: string;
  baseVersion: number;
  checkedIssues: SkillOptIssueLite[];
  userFeedback: string;
}

export function buildSkillOptSystemPrompt(args: BuildSkillOptPromptArgs): string {
  const { skillName, baseVersion, checkedIssues, userFeedback } = args;

  const sortedIssues = [...checkedIssues].sort(severityRank);
  const issuesSection = formatIssuesSection(sortedIssues);
  const feedbackSection = formatFeedbackSection(userFeedback);
  const noInputBanner =
    sortedIssues.length === 0 && !userFeedback.trim()
      ? '\n（用户既没勾选 issue 也没填诉求，请直接询问 / 给出改进建议而不是动文件。）\n'
      : '';

  return [
    '# 角色',
    '',
    '你是 **Skill 优化助手**。当前工作目录是用户的现有 skill 包，结构如下：',
    '',
    '- `SKILL.md`（主文件，必有）',
    '- `scripts/`（可执行脚本，可能为空）',
    '- `references/`（参考资料，可能为空）',
    '',
    `优化目标 skill：**${skillName}**，基线版本 **v${baseVersion}**。`,
    '',
    '# 用户输入',
    '',
    issuesSection,
    feedbackSection,
    noInputBanner,
    '# 工作流程（必须按顺序）',
    '',
    '**Step 1 · 探索**：用 read 工具查看 SKILL.md 与你判断相关的 scripts/references 文件。',
    '',
    '**Step 2 · 修改（必做）**：',
    '探索之后**必须**调用 edit / write 工具实际落地修改——这是用户期望看到的产出。',
    '即便你觉得现状已经不错，也要至少针对每个已勾选的 issue 做一次有意义的修改尝试。',
    '只读不写不是合格的优化输出。',
    '',
    '**Step 3 · 收尾报告**：所有文件改完之后，**用一段 markdown 输出"修改总结"**。这段会作为',
    '"优化报告"展示给用户，所以要好读、聚焦"为什么这么改"，不要重复 diff 已经显示的内容。',
    '',
    '格式严格按下面的模板（小节标题不要改字面量，前端会按它定位）：',
    '',
    '```markdown',
    '## 修改总结',
    '',
    '<2-3 句话用人话讲清这次优化的整体思路，不要罗列细节>',
    '',
    '### 已解决的优化点',
    '- `iss_001`：<具体改动 + 为什么这样改（一句话即可）>',
    '- `iss_003`：<同上>',
    '',
    '### 暂未处理',
    '- `iss_002`：<原因，例如"信息不足，需要用户提供更多 trace"或"与 iss_001 合并处理">',
    '',
    '### 改动要点',
    '- <按文件分组讲核心改动；不需要逐行说，diff 视图会让用户自己看>',
    '```',
    '',
    '如果"暂未处理"为空就省掉那个小节；但"修改总结"和"已解决的优化点"必须有。',
    '',
    '# 修改细则',
    '',
    '1. **prevalence 优先**：如果多个 issue 指向同一段文本或同一类问题，**合并成一次修改**并表达成"通用原则"，而不是为每个 issue 单独打补丁。',
    '2. **不要无关改动**：只动直接对应已勾选 issue 或用户诉求的内容；保持原有结构、目录布局和 markdown 格式。',
    '3. **就地编辑**：用 edit / write 工具直接改原文件。**不要**新建 `.draft` / `.new` / `*.bak` / `optimized/` 之类的副本目录或文件——前端会通过 diff 视图让用户对比。',
    '',
    '# 运行环境',
    '',
    '当前工作目录就是 cwd，所有路径用相对路径（`SKILL.md`、`scripts/foo.sh`、`references/bar.md`），不要拼 `/workspace/` 等前缀。',
  ].join('\n');
}

function severityRank(a: SkillOptIssueLite, b: SkillOptIssueLite): number {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
}

function formatIssuesSection(issues: SkillOptIssueLite[]): string {
  if (issues.length === 0) {
    return '## 待优化点\n\n（用户未勾选任何 issue）\n';
  }
  const lines = ['## 待优化点（按 severity 排序）', ''];
  for (const it of issues) {
    const cat = it.category ? ` · ${it.category}` : '';
    lines.push(`### \`${it.id}\` · **${it.severity}**${cat}`);
    lines.push(`- 摘要：${it.summary}`);
    if (it.evidence) {
      lines.push(`- 证据：${it.evidence}`);
    }
    if (it.improvementSuggestion) {
      lines.push(`- 改进建议（评估器给出，优先按此执行）：${it.improvementSuggestion}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatFeedbackSection(feedback: string): string {
  const trimmed = feedback.trim();
  if (!trimmed) return '';
  return ['## 用户附加诉求', '', trimmed, ''].join('\n');
}
