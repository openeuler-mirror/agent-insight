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

/**
 * 归并算子产出的 plan item（注入 prompt 用的精简形态）。
 * 与平铺 checkedIssues 互斥：有 plan 时 agent 按 plan 执行，不再自行二次合并。
 * 设计：docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md
 */
export interface SkillOptPlanItemLite {
  id: string;
  route: 'core' | 'reference' | 'backlog';
  title: string;
  rationale: string;
  severity: 'high' | 'medium' | 'low';
  targetFile?: string;
  anchorText?: string;
  proposedEdit?: string;
  prevalence?: number;
}

export interface BuildSkillOptPromptArgs {
  skillName: string;
  baseVersion: number;
  checkedIssues: SkillOptIssueLite[];
  userFeedback: string;
  /** 归并 plan（core/reference 路由的待执行条目）；非空时替代 checkedIssues 注入 */
  planItems?: SkillOptPlanItemLite[];
}

export function buildSkillOptSystemPrompt(args: BuildSkillOptPromptArgs): string {
  const { skillName, baseVersion, checkedIssues, userFeedback, planItems } = args;

  const planMode = Array.isArray(planItems) && planItems.length > 0;
  const sortedIssues = [...checkedIssues].sort(severityRank);
  const issuesSection = planMode ? formatPlanSection(planItems!) : formatIssuesSection(sortedIssues);
  const feedbackSection = formatFeedbackSection(userFeedback);
  const noInputBanner =
    !planMode && sortedIssues.length === 0 && !userFeedback.trim()
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
    `- \`${planMode ? 'item_001' : 'iss_001'}\`：<具体改动 + 为什么这样改（一句话即可）>`,
    `- \`${planMode ? 'item_003' : 'iss_003'}\`：<同上>`,
    '',
    '### 暂未处理',
    `- \`${planMode ? 'item_002' : 'iss_002'}\`：<原因，例如"信息不足，需要用户提供更多 trace"${planMode ? '' : '或"与 iss_001 合并处理"'}>`,
    '',
    '### 改动要点',
    '- <按文件分组讲核心改动；不需要逐行说，diff 视图会让用户自己看>',
    '```',
    '',
    '如果"暂未处理"为空就省掉那个小节；但"修改总结"和"已解决的优化点"必须有。',
    '',
    '# 修改细则',
    '',
    planMode
      ? '1. **按 plan 执行**：上面的计划条目已经过归并算子去重与冲突消解，**不要再自行二次合并或改变范围**；core 条目逐条落实，reference 条目写入/追加 `references/` 对应文件。'
      : '1. **prevalence 优先**：如果多个 issue 指向同一段文本或同一类问题，**合并成一次修改**并表达成"通用原则"，而不是为每个 issue 单独打补丁。',
    planMode
      ? '2. **锚点最小编辑（关键纪律）**：每个 plan item 带了 `目标位置`（targetFile + 锚点原文）。用 `edit` 在该锚点处做**最小必要修改**，不要整段/整文件重写。改动范围严格限定在 plan 列出的条目，**没被任何 item 指向的文件/段落一律不动**。'
      : '2. **不要无关改动**：只动直接对应已勾选 issue 或用户诉求的内容；保持原有结构、目录布局和 markdown 格式。',
    '3. **就地编辑**：用 edit / write 工具直接改原文件。**不要**新建 `.draft` / `.new` / `*.bak` / `optimized/` 之类的副本目录或文件——前端会通过 diff 视图让用户对比。',
    planMode
      ? '4. **保护既有可用产物（防回归，关键）**：现有 `scripts/` 里能正确运行的脚本是基线的核心资产。'
        + '**默认不重写脚本**；只有当某 plan item 明确指向某脚本的缺陷时才改它，且**只改那个缺陷**。'
        + '改脚本时**严禁顺手改动它的输出口径**——事件分类规则、计数方式、时间窗/日期解析算法、输出 JSON 的字段名与结构，'
        + '除非有 item 明确要求，否则**逐字保留原样**（曾出现过：重写脚本时新加的日期解析把无年份时间戳算错、把事件分类数改掉，导致统计口径漂移、分数不升反降）。'
        + '能用「在 SKILL.md 加约束」解决的，就不要改脚本。同理**不要改 SKILL.md 的输出报告模板/结构**，除非某 item 明确指向它。'
      : '4. **定量缺失优先补脚本（关键）**：若勾选的 issue 指向「精确数字缺失 / 计数不准 / 排名缺失 / 引用了不存在的脚本」，'
        + '\n   你**必须**用 write 工具补齐或修复对应的**可运行脚本**（优先 Python，仅标准库）并真实落盘，'
        + '\n   再在 SKILL.md 落两条硬约束：①「先运行该脚本、所有计数/排名/时间窗逐字引用脚本输出、禁止肉眼估算」；'
        + '\n   ②一张「问题类型 → 必答小节」的输出模板（让综合类问题不漏报关键观点）。**严禁只在 SKILL.md 里引用一个并不存在的脚本。**',
    '5. **写盘前禁止声明完成**：在 SKILL.md 引用的每个文件都用 write 落盘之前，不要输出「修改总结」；',
    '   收尾前用 `ls` / `read` 自检：SKILL.md 里引用的每个 scripts/references 文件都真实存在；缺哪个补哪个。',
    '6. **定量正确性（不止"文件在"，要"算得对"）**：脚本里的日期/年份、计数、IP 等必须**解析自日志真实内容**——'
      + '年份要从日志行里解析出来（如 ftpd 连接行尾的真实年份），**禁止硬编码、禁止回落到当前系统年份**（曾出现取年正则匹配 0 行 → 静默用 2026 的真实事故）；'
      + '数字一律来自脚本输出、禁止编造。这是「能编译却答错」最常翻车的地方，改完会有自动评测复跑校验，错了会被打回重修。',
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

/**
 * 归并 plan 注入：core（本轮必做）/ reference（写入 references/）分组展示。
 * 锚点（targetFile + anchorText）已经过后端校验真实存在，agent 可直接定位。
 */
function formatPlanSection(items: SkillOptPlanItemLite[]): string {
  const core = items.filter(it => it.route === 'core');
  const reference = items.filter(it => it.route === 'reference');
  const lines = ['## 优化计划（已归并去重，按条执行）', ''];

  const renderItem = (it: SkillOptPlanItemLite) => {
    lines.push(`### \`${it.id}\` · **${it.severity}**`);
    lines.push(`- 标题：${it.title}`);
    if (it.rationale) lines.push(`- 归并理由：${it.rationale}`);
    if (it.targetFile) {
      lines.push(`- 目标位置：\`${it.targetFile}\`${it.anchorText ? `，锚点原文："${it.anchorText}"` : ''}`);
    }
    if (it.proposedEdit) lines.push(`- 建议修改：${it.proposedEdit}`);
    if (it.prevalence && it.prevalence > 1) lines.push(`- 累计检出：${it.prevalence} 次`);
    lines.push('');
  };

  if (core.length > 0) {
    lines.push(`#### 本轮核心修改（${core.length} 条，必做）`, '');
    core.forEach(renderItem);
  }
  if (reference.length > 0) {
    lines.push(`#### 长尾沉淀（${reference.length} 条，写入 references/，不占 SKILL.md 主文件）`, '');
    reference.forEach(renderItem);
  }
  return lines.join('\n');
}
