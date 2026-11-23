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

import { createDeepAgent, LocalShellBackend } from "deepagents";
import { createModel, type ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import { join } from "node:path";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:evaluator-agent");

export function createEvaluatorAgent(opts: {
  workspaceRoot: string;
} & ModelOptions) {
  logger.log("Creating evaluator agent", {
    workspaceRoot: opts.workspaceRoot,
    modelId: opts.modelId ?? null,
    baseUrl: opts.baseUrl ?? null,
  });
  const model = createModel(opts);

  return createDeepAgent({
    model,
    systemPrompt: "你是一名资深的技能评测专家（Skill Evaluator）。你的目标是从多个维度评估技能：结构、触发以及端到端任务执行。\n\n输出格式：\n- 如果你的输出包含代码或 JSON 数据，必须使用 Markdown 代码块（例如 ```json\n...\n``` 或 ```python\n...\n```）进行格式化，以便前端显示。\n\n语言要求：\n- 除非用户明确要求使用其他语言，否则对于所有面向用户的自然语言文本，请使用中文回复。",
    // 加载全局 skills 目录
    skills: [join(process.cwd(), "skills")],
    tools: [], 
    backend: () =>
      new LocalShellBackend({
        rootDir: opts.workspaceRoot,
        inheritEnv: true,
      }),
  });
}
