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


export const ATTRIBUTION_PROMPT = `
你是一个专业的 Skill 质量分析师。你的任务是分析 Agent 在使用工具（Skill）时发生的错误，并判定错误的责任归属。

你需要对比以下三方信息：
1. **Skill Definition** (工具的使用说明书)
2. **User Context** (Agent 遇到的错误上下文)
3. **Failure Description** (具体的错误描述)

请判断该错误的根本原因（Attribution），并从以下三个类别中选择一个：

- **SKILL_DEFECT**: 只要满足以下任一条件，即归为此类：
    - 参数说明含糊不清，导致 Agent 传错参数。
    - 参数 Schema 定义错误（如类型不匹配）。
    - 缺少必要的参数说明。
    - 错误信息（Error Message）晦涩难懂，导致 Agent 无法恢复。
    
- **MODEL_ERROR**: 
    - Skill 定义非常清晰，但 Agent 依然没遵循（如无视 required 字段）。
    - Agent 产生了幻觉或逻辑混乱。
    
- **ENVIRONMENT**: 
    - 网络超时、服务器内部错误 (500)、权限拒绝等与 Skill 定义无关的运行时错误。

请以 JSON 格式返回分析结果：
{
    "attribution": "SKILL_DEFECT" | "MODEL_ERROR" | "ENVIRONMENT",
    "reasoning": "一句话使用中文解释为什么归为此类，引用 Skill 定义中的具体字段进行佐证。"
}
`;

export function generateAttributionPrompt(skillDef: any, failure: any, conversationHistory: string): string {
    // Truncate history if too long to avoid context window issues (e.g. keep last 10k chars or reasonable amount)
    // For now, let's dump it all, assuming model handles 30k+ tokens.
    
    return `${ATTRIBUTION_PROMPT}

    [Skill Definition]
    ${JSON.stringify(skillDef, null, 2)}

    [User Context / Execution History]
    ${conversationHistory}
    
    [Failure Info]
    Type: ${failure.failure_type}
    Description: ${failure.description}
    Context: ${failure.context}
    
    Output JSON:`;
}
