import { createHash } from 'crypto';
import { z } from 'zod';
import {
  buildAgentCallTree,
  walkTree,
  type AgentEvent,
  type AgentNode,
  type RawInteraction,
} from '@/lib/engine/observability/agent-trace';
import {
  generateFaithfulnessClaimExtractionPrompt,
  generateFaithfulnessRepairPrompt,
  generateFaithfulnessVerdictPrompt,
  type FaithfulnessContextPromptItem,
} from '@/prompts/result-faithfulness-prompt';
import type {
  StructuredJudgePrompt,
  StructuredResultInvoker,
} from './instruction-adherence-evaluator';

const CONTEXT_BATCH_CHAR_LIMIT = 30_000;
const CONTEXT_CHUNK_CHARS = 2_500;
const CONTEXT_CHUNK_OVERLAP_LINES = 2;
const MAX_CONTEXTS_PER_CLAIM = 5;
const CLAIMS_PER_BATCH = 8;
const MAX_FAITHFULNESS_CLAIMS = 20;

const claimExtractionSchema = z.object({
  claims: z.array(z.object({
    claimId: z.string().min(1),
    claim: z.string().min(1),
    sourceQuote: z.string().min(1),
    requiresExhaustiveEvidence: z.boolean().default(false),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

const verdictSchema = z.object({
  verdicts: z.array(z.object({
    claimId: z.string().min(1),
    status: z.enum(['supported', 'contradicted', 'not_covered']),
    citations: z.array(z.object({
      contextId: z.string().min(1),
      evidenceQuote: z.string().min(1),
    })).default([]),
    reason: z.string().default(''),
    confidence: z.number().min(0).max(1).default(0),
  })).default([]),
});

export type FaithfulnessClaim = z.output<typeof claimExtractionSchema>['claims'][number];
export type FaithfulnessVerdict = z.output<typeof verdictSchema>['verdicts'][number];

export interface RetrievedContextSource {
  contextId: string;
  toolCallId?: string;
  interactionIndex: number;
  outputHash: string;
  agentNodeId: string;
}

export interface RetrievedContext extends FaithfulnessContextPromptItem {
  source: RetrievedContextSource;
}

export interface RetrievedContextChunk extends FaithfulnessContextPromptItem {
  parentContextId: string;
  startLine?: number;
  endLine?: number;
  source: RetrievedContextSource;
}

export interface FaithfulnessEvaluation {
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
  note?: string;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2).trim(); } catch { return String(value).trim(); }
}

function normalizedText(value: unknown): string {
  return textOf(value).replace(/\s+/gu, ' ').trim();
}

function eventResultText(event: AgentEvent): string {
  if (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'task') return textOf(event.output);
  return textOf(event.interaction?.content ?? event.summary ?? '');
}

function findProducerNode(root: AgentNode, finalResult: string): { node: AgentNode; interactionIndex: number } {
  const target = normalizedText(finalResult);
  const matches: Array<{ node: AgentNode; event: AgentEvent; exact: boolean }> = [];
  walkTree(root, (node) => {
    for (const event of node.events) {
      if (event.kind !== 'llm' && event.kind !== 'tool') continue;
      const candidate = normalizedText(eventResultText(event));
      if (!candidate || !target) continue;
      if (candidate === target || candidate.includes(target) || target.includes(candidate)) {
        matches.push({ node, event, exact: candidate === target });
      }
    }
  });
  matches.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.event.kind !== b.event.kind) return a.event.kind === 'llm' ? -1 : 1;
    return b.event.interactionIndex - a.event.interactionIndex;
  });
  const best = matches[0];
  return best
    ? { node: best.node, interactionIndex: best.event.interactionIndex }
    : { node: root, interactionIndex: Number.POSITIVE_INFINITY };
}

function activeCompactionIndex(node: AgentNode, finalInteractionIndex: number): number {
  return (node.compactions ?? [])
    .filter((item) => item.interactionIndex < finalInteractionIndex)
    .reduce((max, item) => Math.max(max, item.interactionIndex), -1);
}

export function extractRetrievedContexts(
  interactions: unknown[],
  finalResult: string,
): RetrievedContext[] {
  const tree = buildAgentCallTree(interactions as RawInteraction[]);
  if (!tree) return [];
  const producer = findProducerNode(tree, finalResult);
  const compactionIndex = activeCompactionIndex(producer.node, producer.interactionIndex);
  const contexts: RetrievedContext[] = [];
  for (const event of producer.node.events) {
    if (event.kind !== 'tool') continue;
    if (event.interactionIndex > producer.interactionIndex || event.interactionIndex <= compactionIndex) continue;
    const content = textOf(event.output);
    if (!content) continue;
    const contextId = `ctx-${contexts.length + 1}`;
    const rawStatus = String(event.toolStatus ?? '').toLowerCase();
    const status = /error|fail|cancel/.test(rawStatus)
      ? 'error' as const
      : /success|complete/.test(rawStatus)
        ? 'success' as const
        : undefined;
    contexts.push({
      contextId,
      content,
      ...(event.name ? { toolName: event.name } : {}),
      ...(status ? { status } : {}),
      source: {
        contextId,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        interactionIndex: event.interactionIndex,
        outputHash: createHash('sha256').update(content).digest('hex'),
        agentNodeId: producer.node.id,
      },
    });
  }
  return contexts;
}

export function computeFaithfulnessInputHash(interactions: unknown[], finalResult: string): string {
  const contexts = extractRetrievedContexts(interactions, finalResult).map((item) => ({
    toolName: item.toolName,
    status: item.status,
    outputHash: item.source.outputHash,
    interactionIndex: item.source.interactionIndex,
  }));
  return createHash('sha256').update(JSON.stringify({ finalResult, contexts })).digest('hex');
}

function hardSplitLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  for (let start = 0; start < line.length; start += maxChars) out.push(line.slice(start, start + maxChars));
  return out;
}

export function chunkRetrievedContexts(
  contexts: RetrievedContext[],
  maxChars = CONTEXT_CHUNK_CHARS,
): RetrievedContextChunk[] {
  const chunks: RetrievedContextChunk[] = [];
  for (const context of contexts) {
    if (context.content.length <= maxChars) {
      chunks.push({ ...context, parentContextId: context.contextId });
      continue;
    }
    const lines = context.content.split('\n').flatMap((line) => hardSplitLine(line, maxChars));
    let start = 0;
    let chunkIndex = 1;
    while (start < lines.length) {
      let end = start;
      let length = 0;
      while (end < lines.length) {
        const nextLength = length + lines[end].length + (end > start ? 1 : 0);
        if (end > start && nextLength > maxChars) break;
        length = nextLength;
        end += 1;
      }
      const contextId = `${context.contextId}#${chunkIndex}`;
      chunks.push({
        contextId,
        parentContextId: context.contextId,
        content: lines.slice(start, end).join('\n'),
        ...(context.toolName ? { toolName: context.toolName } : {}),
        ...(context.status ? { status: context.status } : {}),
        startLine: start + 1,
        endLine: end,
        source: { ...context.source, contextId },
      });
      if (end >= lines.length) break;
      start = Math.max(start + 1, end - CONTEXT_CHUNK_OVERLAP_LINES);
      chunkIndex += 1;
    }
  }
  return chunks;
}

function searchTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9_.:/@-]{2,}|[\u4e00-\u9fff]{2,}/gu) ?? []);
  const chinese = normalized.match(/[\u4e00-\u9fff]+/gu) ?? [];
  for (const word of chinese) {
    for (let index = 0; index < word.length - 1; index += 1) tokens.add(word.slice(index, index + 2));
  }
  return tokens;
}

function specialTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(
    /(?:\d{1,3}\.){3}\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?|\/?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+|\d+(?:\.\d+)?/gu,
  ) ?? []);
}

function contextScore(claim: FaithfulnessClaim, context: RetrievedContextChunk): number {
  const claimTokens = searchTokens(claim.claim);
  const contextTokens = searchTokens(context.content);
  let score = 0;
  for (const token of claimTokens) if (contextTokens.has(token)) score += 1;
  const contextLower = context.content.toLowerCase();
  for (const token of specialTokens(claim.claim)) if (contextLower.includes(token)) score += 5;
  return score;
}

function fallbackContexts(chunks: RetrievedContextChunk[]): RetrievedContextChunk[] {
  if (chunks.length <= MAX_CONTEXTS_PER_CLAIM) return chunks;
  const head = Math.ceil(MAX_CONTEXTS_PER_CLAIM / 2);
  return [...chunks.slice(0, head), ...chunks.slice(-(MAX_CONTEXTS_PER_CLAIM - head))];
}

export function selectCandidateContexts(
  claim: FaithfulnessClaim,
  chunks: RetrievedContextChunk[],
  sendAll: boolean,
): RetrievedContextChunk[] {
  if (sendAll) return chunks;
  const ranked = chunks
    .map((context, index) => ({ context, index, score: contextScore(claim, context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked[0]?.score) return fallbackContexts(chunks);
  return ranked.slice(0, MAX_CONTEXTS_PER_CLAIM).map((item) => item.context);
}

function limitFaithfulnessClaims(claims: FaithfulnessClaim[]): FaithfulnessClaim[] {
  return claims.slice(0, MAX_FAITHFULNESS_CLAIMS);
}

function contextCharLength(contexts: Iterable<RetrievedContextChunk>): number {
  let total = 0;
  for (const context of contexts) total += context.content.length;
  return total;
}

interface FaithfulnessVerificationBatch {
  claims: FaithfulnessClaim[];
  contexts: RetrievedContextChunk[];
  allowedContextIds: Record<string, string[]>;
}

function buildFaithfulnessVerificationBatches(input: {
  claims: FaithfulnessClaim[];
  chunks: RetrievedContextChunk[];
  sendAll: boolean;
}): FaithfulnessVerificationBatch[] {
  if (input.sendAll) {
    return batchItems(input.claims, CLAIMS_PER_BATCH).map((claims) => ({
      claims,
      contexts: input.chunks,
      allowedContextIds: Object.fromEntries(claims.map((claim) => [
        claim.claimId,
        input.chunks.map((context) => context.contextId),
      ])),
    }));
  }

  const batches: FaithfulnessVerificationBatch[] = [];
  let currentClaims: FaithfulnessClaim[] = [];
  let currentUnion = new Map<string, RetrievedContextChunk>();
  let currentAllowedContextIds: Record<string, string[]> = {};

  const flush = () => {
    if (!currentClaims.length) return;
    batches.push({
      claims: currentClaims,
      contexts: [...currentUnion.values()],
      allowedContextIds: currentAllowedContextIds,
    });
    currentClaims = [];
    currentUnion = new Map();
    currentAllowedContextIds = {};
  };

  for (const claim of input.claims) {
    const selected = selectCandidateContexts(claim, input.chunks, false);
    const nextUnion = new Map(currentUnion);
    for (const context of selected) nextUnion.set(context.contextId, context);
    const shouldStartNextBatch = currentClaims.length > 0
      && (
        currentClaims.length >= CLAIMS_PER_BATCH
        || contextCharLength(nextUnion.values()) > CONTEXT_BATCH_CHAR_LIMIT
      );
    if (shouldStartNextBatch) flush();
    currentClaims.push(claim);
    currentAllowedContextIds[claim.claimId] = selected.map((item) => item.contextId);
    for (const context of selected) currentUnion.set(context.contextId, context);
  }

  flush();
  return batches;
}

function assertUniqueIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} 包含重复 ID`);
}

export function validateFaithfulnessClaims(claims: FaithfulnessClaim[]): void {
  assertUniqueIds(claims.map((item) => item.claimId), '忠实度主张');
}

export function validateFaithfulnessVerdicts(input: {
  claims: FaithfulnessClaim[];
  verdicts: FaithfulnessVerdict[];
  allowedContextIds: Record<string, string[]>;
  contexts: RetrievedContextChunk[];
}): void {
  const expectedIds = input.claims.map((item) => item.claimId);
  const actualIds = input.verdicts.map((item) => item.claimId);
  assertUniqueIds(actualIds, '忠实度裁决');
  const expectedSet = new Set(expectedIds);
  if (actualIds.length !== expectedIds.length || actualIds.some((id) => !expectedSet.has(id))) {
    throw new Error('忠实度裁决输出 ID 与输入不一致');
  }
  const contextById = new Map(input.contexts.map((item) => [item.contextId, item]));
  for (const verdict of input.verdicts) {
    if (verdict.status !== 'not_covered' && verdict.citations.length === 0) {
      throw new Error(`忠实度裁决 ${verdict.claimId} 缺少证据引用`);
    }
    const allowedIds = new Set(input.allowedContextIds[verdict.claimId] ?? []);
    for (const citation of verdict.citations) {
      const context = contextById.get(citation.contextId);
      if (!allowedIds.has(citation.contextId) || !context) {
        throw new Error(`忠实度裁决 ${verdict.claimId} 引用了未授权 contextId`);
      }
    }
  }
}

/**
 * 从「实际输出」抽取可验证主张——准确性(逐条对**参考答案**判对错)与忠实度(逐条对
 * **trace 证据**判有无依据)用的是同一批 claim，故抽取只做一次、两处复用。
 * 抽取提示词只吃 (query, finalResult)，因此按二者哈希缓存：同一 case 内两个评估器
 * 先后执行时第二个直接命中，不重复调模型。
 */
const outputClaimCache = new Map<string, { claims: FaithfulnessClaim[]; confidence: number }>();

export async function extractOutputClaims(input: {
  query: string;
  finalResult: string;
  invoke: StructuredResultInvoker;
}): Promise<{ claims: FaithfulnessClaim[]; confidence: number }> {
  const key = createHash('sha256')
    .update(`${input.query} ${input.finalResult}`)
    .digest('hex');
  const hit = outputClaimCache.get(key);
  if (hit) return hit;

  const extracted = await invokeWithRepair({
    prompt: generateFaithfulnessClaimExtractionPrompt({ query: input.query, finalResult: input.finalResult }),
    schema: claimExtractionSchema,
    invoke: input.invoke,
    validate: (response) => validateFaithfulnessClaims(limitFaithfulnessClaims(response.claims)),
  });
  const out = {
    claims: limitFaithfulnessClaims(extracted.claims),
    confidence: extracted.confidence,
  };
  if (outputClaimCache.size > 200) outputClaimCache.clear(); // 朴素上限，防长驻进程内存增长
  outputClaimCache.set(key, out);
  return out;
}

export function scoreFaithfulnessClaims(claims: Array<{ status: string }>): number | null {
  if (!claims.length) return null;
  return clampScore((claims.filter((item) => item.status === 'supported').length / claims.length) * 100);
}

async function invokeWithRepair<S extends z.ZodTypeAny>(input: {
  prompt: StructuredJudgePrompt;
  schema: S;
  invoke: StructuredResultInvoker;
  validate: (response: z.output<S>) => void;
}): Promise<z.output<S>> {
  let firstResponse: z.output<S> | undefined;
  let firstError: unknown;
  try {
    firstResponse = await input.invoke(input.prompt, input.schema);
    input.validate(firstResponse);
    return firstResponse;
  } catch (error) {
    firstError = error;
  }
  const repaired = await input.invoke(
    generateFaithfulnessRepairPrompt({
      original: input.prompt,
      validationError: firstError instanceof Error ? firstError.message : String(firstError),
      invalidResponse: firstResponse,
    }),
    input.schema,
  );
  input.validate(repaired);
  return repaired;
}

function batchItems<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

export async function evaluateFaithfulness(input: {
  query: string;
  finalResult: string;
  interactions: unknown[];
  invoke: StructuredResultInvoker;
}): Promise<FaithfulnessEvaluation> {
  const contexts = extractRetrievedContexts(input.interactions, input.finalResult);
  if (!contexts.length) {
    return {
      score: null,
      confidence: 0,
      evidence: { reason: '本次 trace 没有可用工具证据', contextCount: 0 },
      note: '本次 trace 没有可用工具证据',
    };
  }

  // 与准确性共用同一批主张（抽取带缓存，谁先跑谁抽）
  const extracted = await extractOutputClaims({
    query: input.query,
    finalResult: input.finalResult,
    invoke: input.invoke,
  });
  const extractedClaims = extracted.claims;
  if (!extractedClaims.length) {
    return {
      score: null,
      confidence: extracted.confidence,
      evidence: { reason: '最终结果中没有可验证主张', claims: [], contextCount: contexts.length },
      note: '最终结果中没有可验证主张',
    };
  }

  const chunks = chunkRetrievedContexts(contexts);
  const sendAll = chunks.reduce((sum, item) => sum + item.content.length, 0) <= CONTEXT_BATCH_CHAR_LIMIT;
  const verdicts: FaithfulnessVerdict[] = [];
  const verificationBatches = buildFaithfulnessVerificationBatches({ claims: extractedClaims, chunks, sendAll });
  for (const [index, batch] of verificationBatches.entries()) {
    const prompt = generateFaithfulnessVerdictPrompt({
      claims: batch.claims.map((claim) => ({
        claimId: claim.claimId,
        claim: claim.claim,
        requiresExhaustiveEvidence: claim.requiresExhaustiveEvidence,
      })),
      contexts: batch.contexts.map((item) => ({
        contextId: item.contextId,
        content: item.content,
        ...(item.toolName ? { toolName: item.toolName } : {}),
        ...(item.status ? { status: item.status } : {}),
      })),
      claimContextIds: batch.allowedContextIds,
      batchIndex: index + 1,
    });
    const judged = await invokeWithRepair({
      prompt,
      schema: verdictSchema,
      invoke: input.invoke,
      validate: (response) => validateFaithfulnessVerdicts({
        claims: batch.claims,
        verdicts: response.verdicts,
        allowedContextIds: batch.allowedContextIds,
        contexts: batch.contexts,
      }),
    });
    verdicts.push(...judged.verdicts);
  }

  const verdictByClaim = new Map(verdicts.map((item) => [item.claimId, item]));
  const chunkById = new Map(chunks.map((item) => [item.contextId, item]));
  const claims = extractedClaims.map((claim) => {
    const verdict = verdictByClaim.get(claim.claimId)!;
    return {
      ...claim,
      status: verdict.status,
      reason: verdict.reason,
      confidence: verdict.confidence,
      citations: verdict.citations.map((citation) => {
        const context = chunkById.get(citation.contextId)!;
        return {
          contextId: citation.contextId,
          evidenceQuote: citation.evidenceQuote,
          toolName: context.toolName,
          toolCallId: context.source.toolCallId,
          interactionIndex: context.source.interactionIndex,
        };
      }),
    };
  });
  const supported = claims.filter((item) => item.status === 'supported').length;
  const contradicted = claims.filter((item) => item.status === 'contradicted').length;
  const notCovered = claims.filter((item) => item.status === 'not_covered').length;
  const score = scoreFaithfulnessClaims(claims);
  const verdictConfidence = verdicts.reduce((sum, item) => sum + item.confidence, 0) / verdicts.length;
  const confidence = Math.min(extracted.confidence, verdictConfidence);
  const reason = `${claims.length} 条可验证主张中 ${supported} 条有工具证据支持，${contradicted} 条与证据矛盾，${notCovered} 条证据未覆盖。`;
  return {
    score,
    confidence,
    evidence: {
      reason,
      claims,
      summary: { claimCount: claims.length, supported, contradicted, notCovered },
      contextCount: contexts.length,
      chunkCount: chunks.length,
      contextSelection: sendAll ? 'all' : 'claim-top-k-batched',
      claimLimit: MAX_FAITHFULNESS_CLAIMS,
      claimsPerBatch: CLAIMS_PER_BATCH,
      verificationBatchCount: verificationBatches.length,
    },
  };
}
