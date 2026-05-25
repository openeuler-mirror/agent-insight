/** 自建评估器卡片 JSON 模型（与 API / DB 存储一致） */

export type EvaluatorType = 'LLM' | 'Code' | 'Custom RPC';
export type EvaluatorSource = 'preset' | 'custom';

export interface LlmEvaluatorConfig {
  model: string;
  systemPrompt: string;
  /** 单段 user prompt（新格式） */
  userPrompt?: string;
}

export const CUSTOM_EVALUATOR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

export function isValidCustomEvaluatorName(name: string): boolean {
  return CUSTOM_EVALUATOR_NAME_PATTERN.test(name.trim());
}

export const CUSTOM_EVALUATOR_ALLOWED_VARIABLES = [
  'input',
  'output',
  'reference_output',
  'trajectory',
] as const;

export function findUnsupportedCustomEvaluatorVariables(prompt: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt)) !== null) {
    const key = match[1];
    if (!CUSTOM_EVALUATOR_ALLOWED_VARIABLES.includes(key as typeof CUSTOM_EVALUATOR_ALLOWED_VARIABLES[number])) {
      found.add(key);
    }
  }
  return Array.from(found);
}

export interface CodeEvaluatorConfig {
  language: 'python' | 'javascript';
  scoreMode: '0-1' | 'pass-fail';
  sourceCode: string;
}

export interface EvaluatorCard {
  id: string;
  name: string;
  description: string;
  evaluatorType: EvaluatorType;
  source: EvaluatorSource;
  targetTypes: string[];
  objectives: string[];
  scenarios: string[];
  runMode: string;
  scoreRange: string;
  popularity: number;
  mappedMetrics: string[];
  status: 'ready' | 'draft' | 'template';
  creator?: string;
  llmConfig?: LlmEvaluatorConfig;
  codeConfig?: CodeEvaluatorConfig;
  /** 当评估器有真实运行实现时，给出"前往评测执行"的页面路由。
   *  目前仅 preset-agent-trace-quality 有：/eval/trajectory（基于 deepagents 实现）。 */
  runtimeHref?: string;
  /** 描述该评估器的运行实现（卡片底部说明用），如 "trajectory-evaluator (deepagents 协作)" */
  runtimeNote?: string;
}
