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

import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { getActiveConfig } from '@/lib/storage/server-config';
import { generateRootCauseExtractionPrompt } from '@/prompts/config-extraction-prompt';
import { parseLooseJson } from './task-completion-json';
import { normalizeRootCauseItems, type RootCauseItem } from '@/lib/dataset-case-root-causes';

async function makeDirectModel(user?: string | null) {
  const config = await getActiveConfig(user);
  if (!config) return null;
  return new ChatOpenAI({
    apiKey: config.apiKey || 'no-api-key',
    model: config.model || 'deepseek-chat',
    configuration: {
      baseURL: config.baseUrl || 'https://api.deepseek.com',
      defaultHeaders: config.headers,
    },
    temperature: 0,
    topP: 1,
    modelKwargs: {
      seed: 42,
    },
  });
}

export async function extractRootCausesFromExpected(
  caseInput: string,
  expectedOutput: string,
  user?: string | null,
): Promise<RootCauseItem[]> {
  if (!String(expectedOutput || '').trim()) return [];
  const model = await makeDirectModel(user);
  if (!model) throw new Error('未配置评测模型，无法提取关键观点');
  const response = await model.invoke([
    new HumanMessage(generateRootCauseExtractionPrompt(caseInput || 'Task completion', expectedOutput)),
  ]);
  const content =
    typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const parsed = parseLooseJson(content);
  const rawItems = Array.isArray(parsed?.root_causes) ? parsed.root_causes : [];
  return normalizeRootCauseItems(rawItems);
}
