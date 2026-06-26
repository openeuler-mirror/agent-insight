import { createHash } from 'crypto';
import { OpenAI } from 'openai';
import { z } from 'zod';
import { prisma } from '@/lib/storage/prisma';
import { getActiveConfig } from '@/lib/storage/server-config';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { canReuseRootCauseCache, hashExpectedOutput } from '@/lib/dataset-case-root-causes';
import { extractTaskResultArtifact } from './result-artifact-extractor';
import {
  hashAgentDatasetScope,
  loadUserAgentDatasets,
  matchAgentDatasetCase,
} from './dataset-case-match';
import { extractRootCausesFromExpected } from './root-cause-extractor';
import {
  evaluateResultAccuracy,
  hashAccuracyKeyPoints,
  normalizeAccuracyKeyPoints,
} from './result-accuracy-evaluator';
import {
  evaluateInstructionAdherence,
  type StructuredJudgePrompt,
  type StructuredResultInvoker,
} from './instruction-adherence-evaluator';
import { evaluateAnswerQuality } from './answer-quality-evaluator';
import {
  computeFaithfulnessInputHash,
  evaluateFaithfulness,
} from './faithfulness-evaluator';
import { parseLooseJson } from './task-completion-json';

export { scoreInstructionVerdicts } from './instruction-adherence-evaluator';
export { scoreAnswerQuality } from './answer-quality-evaluator';
export { scoreFaithfulnessClaims } from './faithfulness-evaluator';

export const RESULT_EVALUATOR_ID = 'result-quality';
export const RESULT_METRIC_KEYS = ['faithfulness', 'instruction-adherence', 'answer-quality', 'accuracy'] as const;
export type ResultMetricStorageKey = typeof RESULT_METRIC_KEYS[number];
export const RESULT_METRIC_VERSIONS: Record<ResultMetricStorageKey, string> = {
  faithfulness: '2.0.1',
  'instruction-adherence': '2.0.1',
  'answer-quality': '2.0.1',
  accuracy: '2.0.1',
};

export interface ResultEvalResult {
  score: number | null;
  method: 'grounding' | 'deterministic' | 'self-rubric' | 'gt-rubric';
  confidence: number;
  evidence: Record<string, unknown>;
  note?: string;
  failed?: boolean;
}

export interface ResultEvaluationRun {
  executionId: string;
  reused: boolean;
  metrics: Record<ResultMetricStorageKey, ResultEvalResult>;
}

interface ResultEvaluationCallDiagnostic {
  stage: string;
  status: 'done' | 'failed';
  durationMs: number;
  response?: unknown;
  error?: string;
}

export function computeInteractionsHash(interactions: unknown[], finalResult: string): string {
  return createHash('sha256').update(JSON.stringify({ interactions, finalResult })).digest('hex');
}

export function computeResultMetricInputHashes(input: {
  interactions: unknown[];
  query: string;
  relevantSystemInstructions: string[];
  finalResult: string;
  accuracyGroundTruthHash?: string;
}): Record<ResultMetricStorageKey, string> {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    faithfulness: computeFaithfulnessInputHash(input.interactions, input.finalResult),
    'instruction-adherence': hash({
      query: input.query,
      relevantSystemInstructions: input.relevantSystemInstructions,
      finalResult: input.finalResult,
    }),
    'answer-quality': hash({ query: input.query, finalResult: input.finalResult }),
    accuracy: hash({
      query: input.query,
      finalResult: input.finalResult,
      groundTruthScope: input.accuracyGroundTruthHash ?? 'no-ground-truth-scope',
    }),
  };
}

export function isReusableResultMetric(
  row: { status: string; evaluatorVersion: string; interactionsHash: string } | undefined,
  key: ResultMetricStorageKey,
  inputHash: string,
): boolean {
  return Boolean(
    row
    && row.status === 'done'
    && row.evaluatorVersion === RESULT_METRIC_VERSIONS[key]
    && row.interactionsHash === inputHash,
  );
}

export function shouldReuseResultEvaluation(
  rows: Array<{ metricKey: string; status: string; evaluatorVersion: string; interactionsHash: string }>,
  inputHashes: Record<ResultMetricStorageKey, string>,
): boolean {
  return RESULT_METRIC_KEYS.every((key) => {
    return isReusableResultMetric(rows.find((row) => row.metricKey === key), key, inputHashes[key]);
  });
}

function parseJson(raw: string): unknown {
  const parsed = parseLooseJson(raw);
  if (!parsed) throw new Error('评测模型返回内容不是可解析的 JSON 对象');
  return parsed;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      return textOf(obj.text ?? obj.content ?? obj.output ?? obj.result ?? '');
    }
    return '';
  }).filter(Boolean).join('\n');
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
  return [...requests, ...response].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
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

function na(method: ResultEvalResult['method'], note: string, evidence: Record<string, unknown> = {}): ResultEvalResult {
  return { score: null, method, confidence: 0, evidence: { ...evidence, reason: note }, note };
}

async function persistMetric(executionId: string, hash: string, key: ResultMetricStorageKey, result: ResultEvalResult): Promise<void> {
  await prisma.traceEvaluation.upsert({
    where: { executionId_evaluatorId_metricKey: { executionId, evaluatorId: RESULT_EVALUATOR_ID, metricKey: key } },
    create: {
      executionId, evaluatorId: RESULT_EVALUATOR_ID, evaluatorVersion: RESULT_METRIC_VERSIONS[key],
      dimension: 'result', metricKey: key, status: 'done', score: result.score, method: result.method,
      confidence: result.confidence, evidenceJson: JSON.stringify(result.evidence), note: result.note, interactionsHash: hash,
    },
    update: {
      evaluatorVersion: RESULT_METRIC_VERSIONS[key], status: 'done', score: result.score, method: result.method,
      confidence: result.confidence, evidenceJson: JSON.stringify(result.evidence), note: result.note,
      interactionsHash: hash, errorMessage: null, ranAt: new Date(),
    },
  });
}

async function markMetricFailed(
  executionId: string,
  hash: string,
  key: ResultMetricStorageKey,
  error: unknown,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const evidenceJson = JSON.stringify({ ...evidence, reason: message });
  await prisma.traceEvaluation.upsert({
    where: { executionId_evaluatorId_metricKey: { executionId, evaluatorId: RESULT_EVALUATOR_ID, metricKey: key } },
    create: {
      executionId, evaluatorId: RESULT_EVALUATOR_ID, evaluatorVersion: RESULT_METRIC_VERSIONS[key], dimension: 'result',
      metricKey: key, status: 'failed', method: methodForMetric(key), confidence: 0,
      interactionsHash: hash, evidenceJson, errorMessage: message,
    },
    update: {
      evaluatorVersion: RESULT_METRIC_VERSIONS[key], status: 'failed', score: null, method: methodForMetric(key), confidence: 0,
      interactionsHash: hash, evidenceJson, errorMessage: message, ranAt: new Date(),
    },
  });
}

function methodForMetric(key: ResultMetricStorageKey): ResultEvalResult['method'] {
  if (key === 'faithfulness') return 'grounding';
  if (key === 'accuracy') return 'gt-rubric';
  return 'self-rubric';
}

function metricFromRow(row: {
  score: number | null;
  method: string;
  confidence: number;
  evidenceJson: string | null;
  note: string | null;
}): ResultEvalResult {
  let evidence: Record<string, unknown> = {};
  try { evidence = row.evidenceJson ? JSON.parse(row.evidenceJson) : {}; } catch { /* ignore malformed historical evidence */ }
  return {
    score: row.score,
    method: row.method as ResultEvalResult['method'],
    confidence: row.confidence,
    evidence,
    note: row.note ?? undefined,
  };
}

export async function evaluateResultQuality(executionId: string): Promise<ResultEvaluationRun> {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    select: { id: true, taskId: true, query: true, finalResult: true, user: true },
  });
  if (!execution) throw new Error(`Execution ${executionId} 不存在`);
  const session = execution.taskId ? await prisma.session.findUnique({ where: { taskId: execution.taskId }, select: { interactions: true, query: true } }) : null;
  let interactions: unknown[] = [];
  try { interactions = session?.interactions ? JSON.parse(session.interactions) : []; } catch { interactions = []; }
  const query = String(execution.query || session?.query || '').trim();
  const extracted = execution.finalResult?.trim()
    ? { outputForEvaluation: execution.finalResult.trim() }
    : await extractTaskResultArtifact({ userTask: query, interactions, fallbackOutput: execution.finalResult || '', user: execution.user });
  const finalResult = String(extracted.outputForEvaluation || '').trim();
  const systems = extractRelevantSystemInstructions(interactions);
  const accuracyDatasets = execution.user ? await loadUserAgentDatasets(execution.user) : [];
  const accuracyDatasetScopeHash = hashAgentDatasetScope(accuracyDatasets);
  const hashes = computeResultMetricInputHashes({
    interactions,
    query,
    relevantSystemInstructions: systems,
    finalResult,
    accuracyGroundTruthHash: accuracyDatasetScopeHash,
  });
  const existing = await prisma.traceEvaluation.findMany({ where: { executionId, evaluatorId: RESULT_EVALUATOR_ID } }) as Array<{
    metricKey: string; status: string; evaluatorVersion: string; interactionsHash: string; score: number | null;
    method: string; confidence: number; evidenceJson: string | null; note: string | null;
  }>;
  const metrics = {} as Record<ResultMetricStorageKey, ResultEvalResult>;
  const keysToRun = RESULT_METRIC_KEYS.filter((key) => {
    const row = existing.find((item) => item.metricKey === key);
    if (!isReusableResultMetric(row, key, hashes[key])) return true;
    metrics[key] = metricFromRow(row!);
    return false;
  });
  if (!keysToRun.length) return { executionId, reused: true, metrics };

  await Promise.all(keysToRun.map((key) => prisma.traceEvaluation.upsert({
    where: { executionId_evaluatorId_metricKey: { executionId, evaluatorId: RESULT_EVALUATOR_ID, metricKey: key } },
    create: {
      executionId, evaluatorId: RESULT_EVALUATOR_ID, evaluatorVersion: RESULT_METRIC_VERSIONS[key],
      dimension: 'result', metricKey: key, status: 'running', method: methodForMetric(key),
      confidence: 0, interactionsHash: hashes[key],
    },
    update: {
      evaluatorVersion: RESULT_METRIC_VERSIONS[key], status: 'running', score: null, method: methodForMetric(key), confidence: 0,
      evidenceJson: null, note: null, interactionsHash: hashes[key], errorMessage: null, ranAt: new Date(),
    },
  })));

  if (!finalResult || !query) {
    const note = !finalResult ? '未提取到最终交付物' : '未提取到用户任务';
    for (const key of keysToRun) metrics[key] = na(methodForMetric(key), note);
    await Promise.all(keysToRun.map((key) => persistMetric(executionId, hashes[key], key, metrics[key])));
    return { executionId, reused: false, metrics };
  }

  const callDiagnostics: Partial<Record<ResultMetricStorageKey, ResultEvaluationCallDiagnostic[]>> = {};
  const trackedInvoker = (key: ResultMetricStorageKey): StructuredResultInvoker => async (prompt, schema) => {
    const records = callDiagnostics[key] ?? [];
    callDiagnostics[key] = records;
    const startedAt = Date.now();
    try {
      const response = await invokeStructured(execution.user, prompt, schema);
      records.push({ stage: prompt.stage, status: 'done', durationMs: Date.now() - startedAt, response });
      return response;
    } catch (error) {
      records.push({
        stage: prompt.stage,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const producers: Partial<Record<ResultMetricStorageKey, () => Promise<ResultEvalResult>>> = {};
  if (keysToRun.includes('faithfulness')) {
    producers.faithfulness = async () => {
      const result = await evaluateFaithfulness({
        query,
        finalResult,
        interactions,
        invoke: trackedInvoker('faithfulness'),
      });
      return {
        ...result,
        method: 'grounding',
        evidence: { ...result.evidence, calls: callDiagnostics.faithfulness ?? [] },
      };
    };
  }
  if (keysToRun.includes('instruction-adherence')) {
    producers['instruction-adherence'] = async () => {
      const result = await evaluateInstructionAdherence({
        query,
        relevantSystemInstructions: systems,
        finalResult,
        invoke: trackedInvoker('instruction-adherence'),
      });
      return {
        ...result,
        method: 'self-rubric',
        evidence: { ...result.evidence, calls: callDiagnostics['instruction-adherence'] ?? [] },
      };
    };
  }
  if (keysToRun.includes('answer-quality')) {
    producers['answer-quality'] = async () => {
      const result = await evaluateAnswerQuality({
        query,
        finalResult,
        invoke: trackedInvoker('answer-quality'),
      });
      return {
        ...result,
        method: 'self-rubric',
        evidence: { ...result.evidence, calls: callDiagnostics['answer-quality'] ?? [] },
      };
    };
  }
  if (keysToRun.includes('accuracy')) {
    producers.accuracy = async () => {
      if (!execution.user) {
        return na('gt-rubric', 'trace 缺少用户归属，无法匹配评测数据集', {
          accuracyStatus: 'no_ground_truth',
          datasetScopeHash: accuracyDatasetScopeHash,
        });
      }
      const matchResult = await matchAgentDatasetCase({
        user: execution.user,
        traceQuery: query,
        requireExpectedOutput: true,
        includeAllDatasetKinds: true,
        datasets: accuracyDatasets,
      });
      if (matchResult.error) {
        throw new Error(`准确性数据集语义匹配失败: ${matchResult.error}`);
      }
      if (!matchResult.match) {
        return na('gt-rubric', '未匹配到带预期输出的评测数据集 Case', {
          accuracyStatus: 'no_ground_truth',
          datasetScopeHash: accuracyDatasetScopeHash,
          matchReason: matchResult.matchReason,
        });
      }

      const { dataset, caseEntry, matchedBy, matchConfidence, matchReason } = matchResult.match;
      const cacheReusable = canReuseRootCauseCache(caseEntry.expectedOutput, caseEntry.rootCauseMeta);
      let keyPointSource: 'dataset-cache' | 'live-extract' | 'dataset-empty' = 'live-extract';
      let rootCauses = [] as Array<{ content: string; weight: number }>;
      if (cacheReusable && caseEntry.rootCauseMeta?.status === 'ready') {
        rootCauses = caseEntry.rootCauses ?? [];
        keyPointSource = 'dataset-cache';
      } else if (cacheReusable && caseEntry.rootCauseMeta?.status === 'empty') {
        keyPointSource = 'dataset-empty';
      } else {
        rootCauses = await extractRootCausesFromExpected(query, caseEntry.expectedOutput, execution.user);
      }
      const keyPoints = normalizeAccuracyKeyPoints(rootCauses);
      const matchEvidence = {
        datasetId: dataset.id,
        datasetName: dataset.name,
        caseId: caseEntry.id,
        matchedBy,
        matchConfidence,
        matchReason,
        datasetScopeHash: accuracyDatasetScopeHash,
        expectedOutputHash: hashExpectedOutput(caseEntry.expectedOutput),
        keyPointsHash: hashAccuracyKeyPoints(keyPoints),
        keyPointSource,
      };
      if (!keyPoints.length) {
        return na('gt-rubric', '预期输出未提取到可用关键观点', {
          accuracyStatus: 'no_ground_truth',
          ...matchEvidence,
        });
      }

      const judged = await evaluateResultAccuracy({
        query,
        expectedOutput: caseEntry.expectedOutput,
        actualOutput: finalResult,
        keyPoints,
        invoke: trackedInvoker('accuracy'),
      });
      return {
        score: judged.score,
        method: 'gt-rubric',
        confidence: judged.score == null ? 0 : Math.min(matchConfidence, judged.confidence),
        note: judged.note,
        evidence: {
          accuracyStatus: judged.score == null ? 'not_attempted' : 'scored',
          ...matchEvidence,
          ...judged.evidence,
          calls: callDiagnostics.accuracy ?? [],
        },
      };
    };
  }

  await Promise.all(keysToRun.map(async (key) => {
    try {
      const result = await producers[key]!();
      metrics[key] = result;
      await persistMetric(executionId, hashes[key], key, result);
      if (key === 'accuracy' && result.score != null) {
        await prisma.execution.update({
          where: { id: executionId },
          data: {
            answerScore: result.score / 100,
            isAnswerCorrect: result.score >= 80,
            judgmentReason: String(result.evidence.reason ?? '结果准确性评测'),
          },
        });
      }
    } catch (error) {
      await markMetricFailed(executionId, hashes[key], key, error, { calls: callDiagnostics[key] ?? [] });
      const labels: Record<ResultMetricStorageKey, string> = {
        faithfulness: '忠实度',
        'instruction-adherence': '指令遵循',
        'answer-quality': '答案质量',
        accuracy: '准确性',
      };
      metrics[key] = { ...na(methodForMetric(key), `${labels[key]}评测失败`), failed: true };
    }
  }));

  return { executionId, reused: false, metrics };
}

export function scheduleResultEvaluation(executionId: string, user?: string | null, signal?: AbortSignal): Promise<ResultEvaluationRun> {
  return withBackgroundOpencodeSlot(
    () => evaluateResultQuality(executionId),
    { label: `quality-result-eval:${executionId}`, taskType: 'quality-result-eval', user: user ?? undefined, signal },
  );
}
