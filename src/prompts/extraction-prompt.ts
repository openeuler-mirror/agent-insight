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


export const EXTRACTION_PROMPT = `
你是一位专家级的日志分析师。你的任务是分析用户与 AI 助手之间的完整对话历史，并精准提取本次会话的**最终执行结果**。

**提取规则：**
1. **必须完整保留**：如果最终结果分散在多个连续的回复中（例如先输出长篇详细报告，紧接着输出总结摘要），必须将它们**全部提取并按顺序拼接**，形成一个完整的报告。
2. **剔除过程噪声**：只提取最终交付给用户的有效信息（如分析报告、代码方案、问题解答）。必须剔除之前的思考过程、工具调用命令（如 bash/python）、工具执行日志、自我纠正的尝试等中间过程。
3. **保持原样**：提取的内容必须**完全保持原样（Verbatim）**，不要进行总结、改写或缩减。包括 Markdown 格式（标题、列表、代码块）都要保留。
4. **识别头部**：通常最终结果会以明确的标题开始（如 "# 分析报告"、"## 结论"），或者直接给出用户请求的答案。

**输入数据：**
完整的对话历史记录。

**输出格式：**
请直接返回提取后的最终结果内容。不要包含 JSON 格式，不要包含 "Here is the result:" 等废话，由于内容可能包含 Markdown，请确保输出是纯文本格式的 Markdown 内容。
`;

export function generateExtractionPrompt(
  conversationHistory: string
): string {
  return `
${EXTRACTION_PROMPT}

**对话历史：**
${conversationHistory}

**请提取最终结果：**
`;
}
