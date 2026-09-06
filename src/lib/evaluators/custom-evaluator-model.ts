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
  'dataset_input',
  'output',
  'reference_output',
  'trajectory',
] as const;

export type CustomEvaluatorVariable = (typeof CUSTOM_EVALUATOR_ALLOWED_VARIABLES)[number];

export function customEvaluatorUsesVariable(
  card: Pick<EvaluatorCard, 'llmConfig'>,
  variable: CustomEvaluatorVariable,
): boolean {
  const text = `${card.llmConfig?.systemPrompt ?? ''}\n${card.llmConfig?.userPrompt ?? ''}`;
  return new RegExp(`\\{\\{\\s*${variable}\\s*\\}\\}`).test(text);
}

export function findUnsupportedCustomEvaluatorVariables(prompt: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt)) !== null) {
    const key = match[1];
    if (!CUSTOM_EVALUATOR_ALLOWED_VARIABLES.includes(key as CustomEvaluatorVariable)) {
      found.add(key);
    }
  }
  return Array.from(found);
}

export interface CodeEvaluatorConfig {
  language: 'python' | 'javascript';
  /** `0-1` 仅用于读取历史配置，保存时统一迁移为 `0-100`。 */
  scoreMode: '0-100' | '0-1' | 'pass-fail';
  sourceCode: string;
}

export interface EvaluatorCard {
  id: string;
  name: string;
  description: string;
  evaluatorType: EvaluatorType;
  source: EvaluatorSource;
  /** 类目（注册时元数据，运行时不可变）：res=结果评测 / traj=轨迹评测。
   *  决定该评估器结果在 Trace 评测详情的呈现板块与实验类目均分归属。
   *  预置评估器由 registry 声明；自建评估器由创建表单填入。缺省视为 'res'。 */
  category?: 'res' | 'traj';
  targetTypes: string[];
  objectives: string[];
  scenarios: string[];
  runMode: string;
  scoreRange: string;
  popularity: number;
  mappedMetrics: string[];
  status: 'ready' | 'draft' | 'template';
  creator?: string;
  /** 自建 LLM 评估器的评分点清单（可选）。留空=自由模式（Judge 自行提取评分点）；
   *  填写=清单模式（平台在 judge 请求中注入"按清单逐条给分"指令并以结构化输出锁定
   *  points.label，输出必含这些评分点）。清单不拼接进用户提示词——运行时三段式组装，
   *  见 judge-assembly.ts。 */
  pointsDef?: Array<{ label: string; note?: string }>;
  llmConfig?: LlmEvaluatorConfig;
  codeConfig?: CodeEvaluatorConfig;
  /** 当评估器有真实运行实现时，给出"前往评测执行"的页面路由。
   *  目前仅 preset-agent-trace-quality 有：/eval/trajectory（基于 deepagents 实现）。 */
  runtimeHref?: string;
  /** 描述该评估器的运行实现（卡片底部说明用），如 "trajectory-evaluator (deepagents 协作)" */
  runtimeNote?: string;
}
