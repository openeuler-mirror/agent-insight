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
 * 基于用户提供的标准答案 / 业务文档提取“关键观点”。
 *
 * - 关键观点 (root_causes)：回答中必须体现的业务相关结论、判断依据、关键事实
 * - 与具体问题场景相关，可选；同一个 skill 可以搭配不同场景下的关键观点
 */
export const generateRootCauseExtractionPrompt = (query: string, standardAnswer: string) => `
You are an expert in building evaluation criteria for AI agent outcomes.

Your task is to extract ONLY the expected key points (root_causes) from the standard answer.

Definition:
- root_causes are the business-facing conclusions, facts, judgments, or domain-specific points that the final answer should contain.
- They are scenario-dependent and may vary across different queries for the same skill.
- They come from the user-provided standard answer or business document, not from generic skill procedure inference.

User Query / Scenario:
"""
${query}
"""

Standard Answer:
"""
${standardAnswer}
"""

Return the result in the following JSON format:
{
  "root_causes": [
    { "content": "Description of key point", "weight": 1.0 }
  ]
}

Guidelines:
- Create 0-5 distinct key points.
- If the standard answer mainly describes process steps and does not contain obvious scenario-specific business points, it is valid to return an empty array.
- Each item's "content" should be concise but descriptive (one sentence).
- Weights should default to 1.0 unless a point is optional (0.5) or critical (2.0).
- Only extract points that are explicitly present or clearly implied by the standard answer.
- Do not turn generic workflow steps into key points unless they are business conclusions required in the final answer.
- The "content" field must follow the same language as the query or standard answer.
`;

/**
 * 基于 skill 定义提取“关键动作”。
 *
 * - 关键动作 (key_actions)：skill 流程约束中必须执行的核心步骤
 * - 对同一 skill / version 应尽量保持唯一且稳定
 */
export const generateKeyActionExtractionPrompt = (
  skillLabel: string,
  skillContent: string,
) => `
You are an expert in extracting canonical execution actions from an AI skill definition.

Your task is to extract ONLY the expected key actions (key_actions) from the skill definition.

Definition:
- key_actions are the canonical procedural steps that this skill requires the agent to perform.
- They should reflect workflow constraints, required checks, required tool usage, or required verification steps from the skill definition.
- They should be stable across different business scenarios that use the same skill.
- Do NOT derive key actions from a specific answer scenario. Derive them from the skill itself.

Skill Target:
"""
${skillLabel}
"""

Skill Definition:
"""
${skillContent}
"""

Return the result in the following JSON format:
{
  "key_actions": [
    { "content": "Description of key action", "weight": 1.0 }
  ]
}

Guidelines:
- Create 3-6 distinct key actions.
- Each item should describe a required step or required verification action, not a final conclusion.
- Keep the action list canonical and reusable for this skill version.
- Only extract actions explicitly required by the skill definition or clearly implied by its process constraints.
- Do not add scenario-specific business viewpoints or answer content here.
- The "content" field should follow the same language as the skill definition when practical.
`;

export const generateAnswerExtractionPrompt = (query: string, documentContent: string) => `
You are an expert at analyzing technical documents and producing structured diagnostic reports.

Given a user Query and a Case Document (which contains the solution or reference answer), produce a Standard Answer in the form of a structured diagnostic report.

User Query:
"""
${query}
"""

Case Document:
"""
${documentContent}
"""

**Output Requirements:**

1. Produce ONLY the diagnostic report itself — NO preamble, NO introduction like "以下是根据文档生成的..." or "Based on the document...". Start directly with the report content.
2. The report MUST follow this exact structure (adapt section content to the actual case):

# 诊断报告

---

## 1. 高阶结论 ⭐

* **问题现象**：一句话描述
* **问题类型**：实时 / 历史
* **影响范围**：主机 / 业务 / 用户
* **初步根因**：一句话定性

---

## 2. 根因分析（Why）

* **触发因素**：事件、变更或操作
* **瓶颈资源**：CPU / 内存 / IO / 网络 / 应用
* **故障路径**：

\`\`\`
[触发因素] ──> [资源瓶颈] ──> [系统现象]
\`\`\`

---

## 3. 关键证据 ⭐

* 3-6 条关键数据点，用"结论性数据"展示，不贴大段日志
* 保留支持结论的关键指标和异常点

---

## 4. 处置与建议

* **应急措施**：快速隔离或缓解
* **根因修复**：优化配置、防止复发

3. If the document is in Chinese, write the report in Chinese. If in English, write in English. Match the document language.
4. Preserve specific commands, configurations, metrics, and technical details from the document verbatim.
5. If some sections are not applicable (e.g. it's not a diagnostic scenario), adapt the structure to fit the content while maintaining the same level of detail and structure.

Return the result as a JSON object:
{
  "standard_answer": "The full diagnostic report in markdown format..."
}
`;
