import { OpenAI } from 'openai';
import { z } from 'zod';
import { getActiveConfig } from '@/lib/storage/server-config';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { evaluateResultAccuracy } from './result-accuracy-evaluator';
import {
  evaluateInstructionAdherence,
  type StructuredJudgePrompt,
  type StructuredResultInvoker,
} from './instruction-adherence-evaluator';
import { evaluateAnswerQuality } from './answer-quality-evaluator';
import { evaluateFaithfulness } from './faithfulness-evaluator';
import { parseLooseJson } from './task-completion-json';

export { scoreInstructionVerdicts } from './instruction-adherence-evaluator';
export { scoreAnswerQuality } from './answer-quality-evaluator';
export { scoreFaithfulnessClaims } from './faithfulness-evaluator';

export const RESULT_METRIC_KEYS = ['faithfulness', 'instruction-adherence', 'answer-quality', 'accuracy'] as const;
export type ResultMetricKey = typeof RESULT_METRIC_KEYS[number];

export interface ResultMetricResult {
  score: number | null;
  method: 'grounding' | 'deterministic' | 'self-rubric' | 'gt-rubric';
  confidence: number;
  evidence: Record<string, unknown>;
  note?: string;
  failed?: boolean;
}

function parseJson(raw: string): unknown {
  const parsed = parseLooseJson(raw);
  if (!parsed) throw new Error('评测模型返回内容不是可解析的 JSON 对象');
  return parsed;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return textOf(obj.text ?? obj.content ?? obj.output ?? obj.result ?? '');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return String(content ?? '');
}

function messagesOf(interaction: unknown): Array<Record<string, unknown>> {
  if (!interaction || typeof interaction !== 'object') return [];
  const obj = interaction as Record<string, unknown>;
  const requests = Array.isArray(obj.requestMessages) ? obj.requestMessages : [];
  const response = obj.responseMessage ? [obj.responseMessage] : [];
  return [...requests, ...response].filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'),
  );
}

export function extractRelevantSystemInstructions(interactions: unknown[]): string[] {
  const out: string[] = [];
  for (const interaction of interactions) {
    for (const message of messagesOf(interaction)) {
      if (String(message.role ?? '') !== 'system') continue;
      const text = textOf(message.content).trim();
      if (text && !out.includes(text)) out.push(text.slice(0, 8000));
    }
  }
  return out.slice(0, 4);
}

async function createClient(user?: string | null): Promise<{ client: OpenAI; model: string } | null> {
  const config = await getActiveConfig(user);
  if (!config) return null;
  const { customFetch } = getProxyConfig();
  return {
    client: new OpenAI({
      apiKey: config.apiKey || 'no-api-key-required',
      baseURL: String(config.baseUrl || 'https://api.deepseek.com').replace(/\/chat\/completions\/?$/, ''),
      defaultHeaders: config.headers,
      fetch: customFetch,
      timeout: Number(process.env.RESULT_QUALITY_TIMEOUT_MS || process.env.JUDGMENT_TIMEOUT_MS || 300000),
    }),
    model: config.model || 'deepseek-chat',
  };
}

async function invokeStructured<S extends z.ZodTypeAny>(
  user: string | null | undefined,
  prompt: string | StructuredJudgePrompt,
  schema: S,
): Promise<z.output<S>> {
  const llm = await createClient(user);
  if (!llm) throw new Error('未配置可用的评测模型');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = typeof prompt === 'string'
    ? [{ role: 'user', content: prompt }]
    : [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];
  const response = await llm.client.chat.completions.create({
    model: llm.model,
    temperature: 0,
    top_p: 1,
    seed: 42,
    messages,
  });
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('评测模型返回空内容');
  return schema.parse(parseJson(content));
}

export interface ResultMetricInputs {
  query: string;
  finalResult: string;
  interactions?: unknown[];
  relevantSystemInstructions?: string[];
  expectedOutput?: string;
}

export async function runSingleResultMetric(
  key: ResultMetricKey,
  inputs: ResultMetricInputs,
  invoke: StructuredResultInvoker,
): Promise<ResultMetricResult> {
  switch (key) {
    case 'faithfulness': {
      const result = await evaluateFaithfulness({
        query: inputs.query,
        finalResult: inputs.finalResult,
        interactions: inputs.interactions ?? [],
        invoke,
      });
      return { ...result, method: 'grounding' };
    }
    case 'instruction-adherence': {
      const result = await evaluateInstructionAdherence({
        query: inputs.query,
        relevantSystemInstructions: inputs.relevantSystemInstructions ?? [],
        finalResult: inputs.finalResult,
        invoke,
      });
      return { ...result, method: 'self-rubric' };
    }
    case 'answer-quality': {
      const result = await evaluateAnswerQuality({
        query: inputs.query,
        finalResult: inputs.finalResult,
        invoke,
      });
      return { ...result, method: 'self-rubric' };
    }
    case 'accuracy': {
      const result = await evaluateResultAccuracy({
        query: inputs.query,
        expectedOutput: inputs.expectedOutput ?? '',
        actualOutput: inputs.finalResult,
        invoke,
      });
      return {
        score: result.score,
        method: 'gt-rubric',
        confidence: result.confidence,
        note: result.note,
        evidence: result.evidence,
      };
    }
  }
}

export async function createResultInvoke(user?: string | null): Promise<StructuredResultInvoker> {
  return async (prompt, schema) => invokeStructured(user, prompt, schema);
}
