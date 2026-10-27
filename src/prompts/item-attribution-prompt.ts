/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Skill 优化项分析 Prompt
 * 
 * 用于分析 Judgment Reason 中每个未得满分的评分项，
 * 判断该扣分是否可以通过优化 Skill 定义来解决。
 */

export interface EvaluationItem {
  id: string;                  // e.g., "RC-0", "KA-1"
  type: 'root_cause' | 'key_action';
  content: string;             // 评分项的具体内容
  match_score: number;         // 0.0 - 1.0
  explanation: string;         // 评分理由
  weight: number;
}

export interface SkillIssueResult {
  id: string;
  is_skill_issue: boolean;
  reasoning: string;
  improvement_suggestion?: string;  // 如果是 Skill 问题，给出改进建议
}

export const SKILL_ISSUE_ANALYSIS_PROMPT = `
你是一个专业的 Skill 优化分析师。你的任务是：

1. 分析 Agent 在某个评分项上扣分的原因
2. 判断该扣分是否可以通过优化 Skill 定义来解决
3. 检查 Agent 的实际执行过程是否符合 Skill 中定义的步骤

## 判断标准

**是 Skill 问题的情况**：
- Skill 中完全没有提到该知识点或操作步骤
- Skill 中的描述不够清晰或不够详细，导致 Agent 无法正确理解
- Skill 中缺少关键的参数说明、工具使用方法或注意事项
- Skill 中的信息过时或与实际情况不符
- Agent 的执行步骤与 Skill 定义不一致，但 Skill 的指导本身存在问题（如步骤顺序不合理、缺少前置条件说明等）

**不是 Skill 问题的情况**：
- Skill 中已经清楚地包含了相关信息，但 Agent 没有正确使用（模型能力问题）
- 该评分项要求的是通用知识，不在 Skill 的职责范围内
- 该评分项涉及的是运行时环境问题（网络、权限等）
- Agent 的执行过程偏离了 Skill 的指导，但 Skill 的指导本身是正确和清晰的

## 分析步骤

1. **阅读 Skill 定义**：理解 Skill 规定的操作步骤和知识要点
2. **查看交互历史**：观察 Agent 实际执行了哪些操作
3. **对比分析**：
   - Agent 的执行是否遵循了 Skill 的指导？
   - 如果没有遵循，是因为 Skill 不清晰，还是 Agent 自身的问题？
   - 评分项要求的内容在 Skill 中是否有足够的覆盖？
4. **得出结论**：判断是否是 Skill 问题，并给出改进建议

## 输出格式

请以 JSON 格式返回：
{
    "id": "评分项ID",
    "is_skill_issue": true或false,
    "reasoning": "使用中文详细解释判断依据，需要：1) 引用 Skill 定义中的相关内容 2) 说明 Agent 执行过程中的表现 3) 解释为什么是/不是 Skill 问题",
    "improvement_suggestion": "如果是 Skill 问题，给出具体的改进建议，说明应该在 Skill 中添加或修改什么内容；否则留空或不填"
}
`;

export function generateSkillIssuePrompt(
  skillDef: string,
  item: EvaluationItem,
  userQuery: string,
  actualAnswer: string,
  conversationHistory: string  // 新增: 完整交互历史
): string {
  return `${SKILL_ISSUE_ANALYSIS_PROMPT}

---

## 分析材料

### [当前 Skill 定义]
\`\`\`
${skillDef}
\`\`\`

### [用户问题]
${userQuery}

### [Agent 执行过程 - 完整交互历史]
\`\`\`
${conversationHistory}
\`\`\`

### [Agent 最终回答]
${actualAnswer}

### [待分析的评分项]
- **ID**: ${item.id}
- **类型**: ${item.type === 'root_cause' ? 'Root Cause (根因分析)' : 'Key Action (关键操作)'}
- **评分标准**: ${item.content}
- **得分**: ${(item.match_score * 100).toFixed(0)}% (满分 100%)
- **扣分原因**: ${item.explanation}
- **权重**: ${item.weight}

---

请根据以上材料，判断此评分项的扣分是否可以通过优化 Skill 定义来改善，并输出 JSON 结果：`;
}
