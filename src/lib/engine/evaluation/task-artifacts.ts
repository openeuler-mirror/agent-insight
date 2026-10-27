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

export interface TaskArtifactExtraction {
  input: string;
  output: string;
  trace: unknown[];
  warnings: string[];
}

export async function extractTaskArtifacts(args: {
  rawInput: string;
  fallbackOutput: string;
  interactions: unknown[];
}): Promise<TaskArtifactExtraction> {
  const input = args.rawInput;
  const output = args.fallbackOutput;
  const warnings: string[] = [];
  if (!input.trim()) warnings.push('原始用户输入为空，请在保存前补充。');
  if (!output.trim()) warnings.push('最终输出为空，请在保存前补充。');

  return {
    input,
    output,
    trace: args.interactions,
    warnings,
  };
}
