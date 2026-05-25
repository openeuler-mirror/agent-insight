import { OpenAI } from 'openai';
import { z } from 'zod';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_MAX_LLM_CALLS = 10;
const MAX_LLM_INPUT_CHARS = 1800;
const MAX_LLM_OUTPUT_CHARS = 3600;
const MAX_TOOL_ARGS_CHARS = 1200;
const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_FOLLOWUP_CONTEXT_CHARS = 24000;

type JsonObject = Record<string, unknown>;

interface TraceEvent {
  id: string;
  type: 'llm' | 'tool';
  order: number;
  interactionIndex: number;
  agent?: string;
  name?: string;
  input?: string;
  inputParts?: Array<{ role: string; name?: string; text: string }>;
  output?: string;
}

interface SourceCandidate {
  id: string;
  eventId: string;
  kind: 'llm_input' | 'llm_output' | 'tool_input' | 'tool_output';
  text: string;
  agent?: string;
  name?: string;
  interactionIndex?: number;
}

export interface ResultArtifactExtractionResult {
  status: 'found' | 'missing';
  outputForEvaluation: string | null;
  confidence: number;
  reason: string;
  sourceRefs: string[];
  rawAnalysis: JsonObject;
}

export interface ResultArtifactExtractionInput {
  userTask: string;
  interactions: unknown[];
  fallbackOutput?: string;
  user?: string | null;
  maxLlmCalls?: number;
  threshold?: number;
}

const firstPassSchema = z.object({
  has_task_output: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0),
  selected_source_id: z.string().nullable().default(null),
  needs_followup_context: z.boolean().default(false),
  followup_anchor_llm_call_id: z.string().nullable().default(null),
  reason: z.string().default(''),
});

const secondPassSchema = z.object({
  has_task_output: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0),
  selected_source_id: z.string().nullable().default(null),
  artifact_paths: z.array(z.string()).default([]),
  reason: z.string().default(''),
});

function getTimeoutMs(): number {
  const raw = Number(process.env.RESULT_ARTIFACT_TIMEOUT_MS || process.env.JUDGMENT_TIMEOUT_MS || 300000);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/chat\/completions\/?$/, '');
}

async function getLlmClient(user?: string | null) {
  const config = await getActiveConfig(user);
  if (!config) return { client: null, model: null };
  const { customFetch } = getProxyConfig();
  return {
    client: new OpenAI({
      apiKey: config.apiKey || 'no-api-key-required',
      baseURL: normalizeBaseUrl(config.baseUrl || 'https://api.deepseek.com'),
      fetch: customFetch,
      timeout: getTimeoutMs(),
    }),
    model: config.model || 'deepseek-chat',
  };
}

function parseJsonPayload<T>(raw: string): T | null {
  let jsonStr = raw.trim();
  if (!jsonStr) return null;
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    jsonStr = fenced[1];
  } else {
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last >= first) {
      jsonStr = jsonStr.substring(first, last + 1);
    }
  }
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringifyCompact(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 80);
  return `${value.slice(0, head)}\n...[中间内容已截断 ${value.length - head - tail} 字]...\n${value.slice(-tail)}`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      const obj = asObject(item);
      if (!obj) return stringifyCompact(item);
      return stringifyCompact(obj.text ?? obj.content ?? obj.input ?? obj);
    }).filter(Boolean).join('\n');
  }
  return stringifyCompact(content);
}

function getToolCalls(message: JsonObject | null): JsonObject[] {
  const raw = message?.tool_calls ?? message?.toolCalls;
  return Array.isArray(raw) ? raw.map(asObject).filter((item): item is JsonObject => Boolean(item)) : [];
}

function getToolName(toolCall: JsonObject): string {
  const fn = asObject(toolCall.function);
  return String(fn?.name || toolCall.name || toolCall.type || 'tool').trim();
}

function getToolArguments(toolCall: JsonObject): string {
  const fn = asObject(toolCall.function);
  return stringifyCompact(fn?.arguments ?? toolCall.arguments ?? toolCall.input ?? '');
}

function getToolOutput(toolCall: JsonObject): string {
  return stringifyCompact(toolCall.output ?? toolCall.result ?? toolCall.content ?? '');
}

function formatMessageList(messages: unknown, maxChars: number): string {
  if (!Array.isArray(messages)) return '';
  const text = messages.map((message, index) => {
    const obj = asObject(message);
    if (!obj) return '';
    const role = String(obj.role || 'message');
    const name = obj.name ? `/${String(obj.name)}` : '';
    return `[${index + 1}] ${role}${name}: ${contentToText(obj.content)}`;
  }).filter(Boolean).join('\n');
  return truncateMiddle(text, maxChars);
}

function formatMessageParts(messages: unknown): Array<{ role: string; name?: string; text: string }> {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(message => {
      const obj = asObject(message);
      if (!obj) return null;
      const text = contentToText(obj.content).trim();
      if (!text) return null;
      // 返回类型签名是 name?: string（可选属性），不是 name: string | undefined（必填可空），
      // 直接 name: undefined 会让 strict TS 认为类型不兼容，改用条件 spread。
      return {
        role: String(obj.role || 'message'),
        text,
        ...(obj.name ? { name: String(obj.name) } : {}),
      };
    })
    .filter((item): item is { role: string; name?: string; text: string } => Boolean(item));
}

function normalizeTraceEvents(interactions: unknown[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  let order = 0;
  let llmSeq = 0;
  let toolSeq = 0;

  for (let interactionIndex = 0; interactionIndex < interactions.length; interactionIndex += 1) {
    const item = asObject(interactions[interactionIndex]);
    if (!item) continue;

    const requestMessages = Array.isArray(item.requestMessages) ? item.requestMessages : [];
    for (const message of requestMessages) {
      const msg = asObject(message);
      if (!msg) continue;
      if (String(msg.role || '').toLowerCase() === 'tool') {
        toolSeq += 1;
        events.push({
          id: `tool-${toolSeq}`,
          type: 'tool',
          order: order++,
          interactionIndex,
          name: String(msg.name || msg.tool_call_id || 'tool'),
          input: '',
          output: contentToText(msg.content),
        });
      }
    }

    const responseMessage = asObject(item.responseMessage);
    if (responseMessage) {
      const output = contentToText(responseMessage.content);
      if (output || getToolCalls(responseMessage).length > 0) {
        llmSeq += 1;
        events.push({
          id: `llm-${llmSeq}`,
          type: 'llm',
          order: order++,
          interactionIndex,
          agent: String(item.agent || item.subagent_name || ''),
          input: formatMessageList(requestMessages, MAX_LLM_INPUT_CHARS),
          inputParts: formatMessageParts(requestMessages),
          output,
        });
      }
      for (const toolCall of getToolCalls(responseMessage)) {
        toolSeq += 1;
        events.push({
          id: `tool-${toolSeq}`,
          type: 'tool',
          order: order++,
          interactionIndex,
          name: getToolName(toolCall),
          input: getToolArguments(toolCall),
          output: getToolOutput(toolCall),
        });
      }
      continue;
    }

    const role = String(item.role || '').toLowerCase();
    if (role === 'tool') {
      toolSeq += 1;
      events.push({
        id: `tool-${toolSeq}`,
        type: 'tool',
        order: order++,
        interactionIndex,
        name: String(item.name || item.tool_call_id || 'tool'),
        input: '',
        output: contentToText(item.content),
      });
    } else if (role === 'assistant' || role === 'subagent' || role === 'agent' || role === 'opencode') {
      llmSeq += 1;
      events.push({
        id: `llm-${llmSeq}`,
        type: 'llm',
        order: order++,
        interactionIndex,
        agent: String(item.agent || item.subagent_name || ''),
        input: '',
        output: contentToText(item.content),
      });
    }

    for (const toolCall of getToolCalls(item)) {
      toolSeq += 1;
      events.push({
        id: `tool-${toolSeq}`,
        type: 'tool',
        order: order++,
        interactionIndex,
        name: getToolName(toolCall),
        input: getToolArguments(toolCall),
        output: getToolOutput(toolCall),
      });
    }
  }

  return events;
}

function toSourceCandidates(events: TraceEvent[]): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  for (const event of events) {
    if (event.input?.trim()) {
      if (event.type === 'llm' && event.inputParts?.length) {
        event.inputParts.forEach((part, index) => {
          candidates.push({
            id: `${event.id}.input.${index + 1}`,
            eventId: event.id,
            kind: 'llm_input',
            text: part.text,
            agent: event.agent,
            name: event.name,
            interactionIndex: event.interactionIndex,
          });
        });
      } else {
        candidates.push({
          id: `${event.id}.input`,
          eventId: event.id,
          kind: event.type === 'llm' ? 'llm_input' : 'tool_input',
          text: event.input,
          agent: event.agent,
          name: event.name,
          interactionIndex: event.interactionIndex,
        });
      }
    }
    if (event.output?.trim()) {
      candidates.push({
        id: `${event.id}.output`,
        eventId: event.id,
        kind: event.type === 'llm' ? 'llm_output' : 'tool_output',
        text: event.output,
        agent: event.agent,
        name: event.name,
        interactionIndex: event.interactionIndex,
      });
    }
  }
  return candidates;
}

function toLlmOutputCandidates(events: TraceEvent[]): SourceCandidate[] {
  return events
    .filter(event => event.type === 'llm' && event.output?.trim())
    .map(event => ({
      id: `${event.id}.output`,
      eventId: event.id,
      kind: 'llm_output' as const,
      text: event.output!.trim(),
      agent: event.agent,
      name: event.name,
      interactionIndex: event.interactionIndex,
    }));
}

export function extractRecentLlmOutputs(interactions: unknown[], maxLlmCalls = DEFAULT_MAX_LLM_CALLS) {
  const events = normalizeTraceEvents(interactions || []);
  const llmEvents = events
    .filter(event => event.type === 'llm' && event.output?.trim())
    .slice(-Math.max(1, maxLlmCalls));
  return llmEvents.map(event => ({
    id: event.id,
    interactionIndex: event.interactionIndex,
    agent: event.agent || '',
    output: event.output!.trim(),
  }));
}

function findSourceText(candidates: SourceCandidate[], sourceId: string | null | undefined): string {
  if (!sourceId) return '';
  return candidates.find(candidate => candidate.id === sourceId)?.text?.trim() || '';
}

function sourceExists(candidates: SourceCandidate[], sourceId: string | null | undefined): boolean {
  if (!sourceId) return false;
  return candidates.some(candidate => candidate.id === sourceId);
}

function foundResult(
  outputForEvaluation: string,
  confidence: number,
  reason: string,
  selectedSourceId: string | null | undefined,
  rawAnalysis: JsonObject,
): ResultArtifactExtractionResult {
  return {
    status: 'found',
    outputForEvaluation,
    confidence,
    reason,
    sourceRefs: selectedSourceId ? [selectedSourceId] : [],
    rawAnalysis,
  };
}

function buildFirstPassPrompt(userTask: string, candidates: SourceCandidate[]): string {
  const sourceCandidates = candidates.map(candidate => ({
    id: candidate.id,
    event_id: candidate.eventId,
    kind: candidate.kind,
    agent: candidate.agent || '',
    name: candidate.name || '',
    interaction_index: candidate.interactionIndex,
    text_preview: truncateMiddle(
      candidate.text,
      candidate.kind === 'llm_input' ? MAX_LLM_INPUT_CHARS : MAX_LLM_OUTPUT_CHARS,
    ),
  }));

  return `你是 agent 评测系统中的“真实任务输出定位器”。

你的任务：
基于用户真实输入和最近的 LLM 调用，从 source_candidates 中选择“一条最像用户任务真实输出的完整原始数据”。

重要规则：
1. 你只能选择已有 source_candidates 的 id，不允许总结、改写、摘抄、合成新的输出。
2. 最终实际输出会由程序按 selected_source_id 回到 trace 中取原始全文，所以你不要返回原文内容。
3. 只判断 source 是否是用户任务的真实输出，不判断输出内容是否正确；正确性由后续评测器判断。
4. “最像”优先看完整性和原始性，不看位置先后；更靠后的总结、收尾、转述、交付说明，不应压过前面更完整的原始报告/诊断结论/分析产物。
5. 如果子 agent 输出了完整报告，而 controller / 主 agent 后面只是摘要、总结、转述或流程结束说明，应优先选择子 agent 的完整原始输出。
6. 优先选择包含结构化正文、关键诊断依据、根因、影响、结论、建议等完整任务产物的 source；不要选择只包含一小段结论或概要的 source。
7. 如果某条 source 是“报告已写到某路径”“正在生成报告”“分析完成”等状态说明，不能选它，除非它本身包含实质性报告/结论/诊断内容。
8. 如果真实结果可能是在某个 LLM 调用之后由工具写文件、读取文件或生成制品产生，但当前候选里看不到完整原始数据，则返回 needs_followup_context=true，并给出最相关的 followup_anchor_llm_call_id。
9. followup_anchor_llm_call_id 必须是 llm-N 这种事件 id，不要带 .input 或 .output。
10. 输出必须是严格 JSON，不要输出 markdown 或解释文字。

输出格式：
{
  "has_task_output": true,
  "confidence": 0.0,
  "selected_source_id": "llm-1.output",
  "needs_followup_context": false,
  "followup_anchor_llm_call_id": null,
  "reason": "一句话说明判断依据"
}

user_task:
${userTask}

source_candidates:
${JSON.stringify(sourceCandidates, null, 2)}`;
}

function buildFollowupCandidates(events: TraceEvent[]): SourceCandidate[] {
  const candidates = toSourceCandidates(events);
  const result: SourceCandidate[] = [];
  let total = 0;

  for (const candidate of candidates) {
    const previewLength = candidate.kind === 'tool_output' ? MAX_TOOL_OUTPUT_CHARS : MAX_TOOL_ARGS_CHARS;
    const preview = truncateMiddle(candidate.text, previewLength);
    if (total + preview.length > MAX_FOLLOWUP_CONTEXT_CHARS) break;
    result.push(candidate);
    total += preview.length;
  }

  return result;
}

function buildSecondPassPrompt(userTask: string, candidates: SourceCandidate[]): string {
  const sourceCandidates = candidates.map(candidate => ({
    id: candidate.id,
    event_id: candidate.eventId,
    kind: candidate.kind,
    agent: candidate.agent || '',
    name: candidate.name || '',
    interaction_index: candidate.interactionIndex,
    text_preview: truncateMiddle(
      candidate.text,
      candidate.kind === 'tool_output' ? MAX_TOOL_OUTPUT_CHARS : MAX_TOOL_ARGS_CHARS,
    ),
  }));

  return `你是 agent 评测系统中的“工具上下文产物定位器”。

你的任务：
从 source_candidates 中选择“一条最像用户任务真实输出的原始数据”。

重要规则：
1. 你只能选择已有 source_candidates 的 id，不允许总结、改写、摘抄、合成新的输出。
2. 最终实际输出会由程序按 selected_source_id 回到 trace 中取原始全文，所以你不要返回原文内容。
3. 工具输出可能包含文件写入内容、读取到的报告、命令结果或制品内容；优先选择能回答 user_task 的完整原始产物，而不是摘要、状态说明或路径提示。
4. 如果同一段上下文里既有完整报告正文，又有后续总结/转述，应选择完整报告正文对应的 source id。
5. 如果只有“写入成功”“路径已生成”但没有产物正文，has_task_output=false。
6. 只判断 source 是否是用户任务的真实输出，不判断输出内容是否正确；正确性由后续评测器判断。
7. 输出必须是严格 JSON，不要输出 markdown 或解释文字。

输出格式：
{
  "has_task_output": true,
  "confidence": 0.0,
  "selected_source_id": "tool-1.output",
  "artifact_paths": ["/path/report.md"],
  "reason": "一句话说明判断依据"
}

user_task:
${userTask}

source_candidates:
${JSON.stringify(sourceCandidates, null, 2)}`;
}

async function invokeJson(client: OpenAI, model: string, prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

function missingResult(reason: string, rawAnalysis: JsonObject = {}): ResultArtifactExtractionResult {
  return {
    status: 'missing',
    outputForEvaluation: null,
    confidence: 0,
    reason,
    sourceRefs: [],
    rawAnalysis,
  };
}

function fallbackResult(
  fallbackOutput: string,
  reason: string,
  rawAnalysis: JsonObject = {},
): ResultArtifactExtractionResult {
  return foundResult(
    fallbackOutput,
    0,
    `未能从 trace 中定位真实任务输出，已回退使用 execution.finalResult。原始原因：${reason}`,
    'execution.finalResult',
    {
      ...rawAnalysis,
      fallback: {
        used: true,
        source: 'execution.finalResult',
        reason,
      },
    },
  );
}

export async function extractTaskResultArtifact(
  input: ResultArtifactExtractionInput,
): Promise<ResultArtifactExtractionResult> {
  const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxLlmCalls = input.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const fallbackOutput = String(input.fallbackOutput || '').trim();
  const missing = (reason: string, rawAnalysis: JsonObject = {}) =>
    fallbackOutput
      ? fallbackResult(fallbackOutput, reason, rawAnalysis)
      : missingResult(reason, rawAnalysis);

  const { client, model } = await getLlmClient(input.user);
  if (!client || !model) {
    return missing('未配置可用评测模型，无法提取真实输出。');
  }

  const events = normalizeTraceEvents(input.interactions || []);
  const llmEvents = events
    .filter(event => event.type === 'llm' && event.output?.trim())
    .slice(-Math.max(1, maxLlmCalls));
  if (llmEvents.length === 0) {
    return missing('链路中没有可用于输出提取的 LLM 调用。', { event_count: events.length });
  }

  try {
    const firstCandidates = toLlmOutputCandidates(llmEvents);
    const firstRaw = await invokeJson(
      client,
      model,
      buildFirstPassPrompt(input.userTask, firstCandidates),
    );
    const firstPayload = parseJsonPayload(firstRaw);
    if (!firstPayload) {
      return missing('第一轮输出提取模型未返回合法 JSON。', {
        pass: 'first',
        raw_response: firstRaw,
        threshold,
      });
    }
    const firstParsed = firstPassSchema.parse(firstPayload);
    const firstOutput = findSourceText(firstCandidates, firstParsed.selected_source_id);
    const firstAnalysis = {
      pass: 'first',
      response: firstParsed,
      raw_response: firstRaw,
      source_candidate_ids: firstCandidates.map(candidate => candidate.id),
      threshold,
    };

    if (firstParsed.has_task_output && firstOutput) {
      return foundResult(
        firstOutput,
        firstParsed.confidence,
        firstParsed.reason,
        firstParsed.selected_source_id,
        {
          ...firstAnalysis,
          accepted_below_threshold: firstParsed.confidence < threshold,
        },
      );
    }

    const anchorId = firstParsed.followup_anchor_llm_call_id || '';
    if (!firstParsed.needs_followup_context || !anchorId) {
      const invalidSourceReason =
        firstParsed.selected_source_id && !sourceExists(firstCandidates, firstParsed.selected_source_id)
          ? `第一轮返回的 selected_source_id=${firstParsed.selected_source_id} 不在候选列表中。`
          : '';
      return missing(
        invalidSourceReason || firstParsed.reason || `输出定位置信度 ${firstParsed.confidence} 低于阈值 ${threshold}，且无需二次上下文。`,
        firstAnalysis,
      );
    }

    const anchor = events.find(event => event.type === 'llm' && event.id === anchorId);
    if (!anchor) {
      return missing(`第一轮返回的 followup_anchor_llm_call_id=${anchorId} 不存在。`, firstAnalysis);
    }

    const nextLlm = events.find(event => event.type === 'llm' && event.order > anchor.order);
    const followupEvents = events.filter(event =>
      event.order >= anchor.order && (!nextLlm || event.order < nextLlm.order)
    );
    const secondCandidates = buildFollowupCandidates(followupEvents);
    const secondRaw = await invokeJson(
      client,
      model,
      buildSecondPassPrompt(input.userTask, secondCandidates),
    );
    const secondPayload = parseJsonPayload(secondRaw);
    if (!secondPayload) {
      return missing('第二轮输出提取模型未返回合法 JSON。', {
        pass: 'second',
        first: firstParsed,
        raw_first_response: firstRaw,
        raw_second_response: secondRaw,
        followup_anchor_llm_call_id: anchorId,
        followup_event_ids: followupEvents.map(event => event.id),
        threshold,
      });
    }
    const secondParsed = secondPassSchema.parse(secondPayload);
    const secondOutput = findSourceText(secondCandidates, secondParsed.selected_source_id);
    const combinedAnalysis = {
      pass: 'second',
      first: firstParsed,
      second: secondParsed,
      raw_first_response: firstRaw,
      raw_second_response: secondRaw,
      followup_anchor_llm_call_id: anchorId,
      followup_event_ids: followupEvents.map(event => event.id),
      source_candidate_ids: secondCandidates.map(candidate => candidate.id),
      threshold,
    };

    if (secondParsed.has_task_output && secondOutput) {
      return foundResult(
        secondOutput,
        secondParsed.confidence,
        secondParsed.reason,
        secondParsed.selected_source_id,
        {
          ...combinedAnalysis,
          accepted_below_threshold: secondParsed.confidence < threshold,
        },
      );
    }

    const invalidSecondSourceReason =
      secondParsed.selected_source_id && !sourceExists(secondCandidates, secondParsed.selected_source_id)
        ? `第二轮返回的 selected_source_id=${secondParsed.selected_source_id} 不在候选列表中。`
        : '';
    return missing(
      invalidSecondSourceReason || secondParsed.reason || `二次输出定位置信度 ${secondParsed.confidence} 低于阈值 ${threshold}。`,
      combinedAnalysis,
    );
  } catch (error) {
    return missing(`真实输出提取 LLM 调用失败：${(error as Error).message || String(error)}`, {
      error: (error as Error).message || String(error),
    });
  }
}
