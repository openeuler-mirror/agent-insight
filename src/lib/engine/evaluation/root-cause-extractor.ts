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
    },
    temperature: 0.1,
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
