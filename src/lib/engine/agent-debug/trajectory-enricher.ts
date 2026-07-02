/**
 * 轨迹诊断器的 LLM 富化（enrichment）。
 *
 * 确定性检测器只产出"结构化事实"（区间、重复次数、重复占比、代表性证据节点）和一套
 * 兜底模板文案。本模块把**所有**检测到的 trajectory finding 连同其代表性证据**一次性**交给
 * LLM，让它基于真实重复内容写出：到底在反复做什么、为什么不收敛（故障机制 / 故障链）、以及
 * 针对性的修复建议——替换掉看不出具体意义的模板文字。
 *
 * 关键约束：只喂"检测器已定位区间内的少量代表性证据"，不喂整条 trace；一次调用处理所有
 * finding。LLM 不可用 / 出错 / 解析失败时，原样返回确定性结果（优雅降级）。
 */
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

import { getActiveConfig } from '@/lib/storage/server-config';
import { parseJsonObject } from './json';
import type { AgentDebugTrajectoryFinding, DebugTurn } from './types';

const MAX_SAMPLES_PER_FINDING = 4;
const SAMPLE_CHARS = 600;

interface EnrichmentItem {
  summary?: string;
  mechanism?: string;
  faultChain?: string[];
  correctionGuidance?: string;
}

export async function enrichTrajectoryFindings(
  findings: AgentDebugTrajectoryFinding[],
  turns: DebugTurn[],
  user?: string | null,
): Promise<AgentDebugTrajectoryFinding[]> {
  if (!Array.isArray(findings) || findings.length === 0) return findings;

  const model = await makeModel(user);
  if (!model) return findings; // 未配置评测模型 → 保留确定性兜底文案

  try {
    const byInteraction = new Map<number, DebugTurn>();
    for (const t of turns) {
      if (typeof t.sourceInteractionIndex === 'number') byInteraction.set(t.sourceInteractionIndex, t);
    }
    const prompt = buildPrompt(findings, byInteraction);
    const response = await model.invoke([new HumanMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const enriched = parseEnrichment(content);
    if (enriched.size === 0) return findings;

    return findings.map((f) => {
      const e = enriched.get(f.id);
      if (!e) return f;
      return {
        ...f,
        summary: clean(e.summary) || f.summary,
        mechanism: clean(e.mechanism) || f.mechanism,
        faultChain: Array.isArray(e.faultChain) && e.faultChain.length > 0
          ? e.faultChain.map((s) => clean(s)).filter(Boolean)
          : f.faultChain,
        correctionGuidance: clean(e.correctionGuidance) || f.correctionGuidance,
        llmEnriched: true,
      };
    });
  } catch {
    return findings; // LLM 调用 / 解析失败 → 优雅降级回确定性结果
  }
}

async function makeModel(user?: string | null) {
  const config = await getActiveConfig(user);
  if (!config) return null;
  return new ChatOpenAI({
    apiKey: config.apiKey || 'no-api-key',
    model: config.model || 'deepseek-chat',
    configuration: { baseURL: config.baseUrl || 'https://api.deepseek.com' },
    temperature: 0,
    topP: 1,
    modelKwargs: { seed: 42 },
  });
}

function buildPrompt(findings: AgentDebugTrajectoryFinding[], byInteraction: Map<number, DebugTurn>): string {
  const blocks = findings.map((f) => {
    const samples = collectSamples(f, byInteraction);
    return [
      `### finding ${f.id}`,
      `- 区间：trace 节点 ${f.span.fromStep ?? '?'}–${f.span.toStep ?? '?'}（约 ${f.span.turnCount} 个 turn）`,
      `- 主导重复动作次数：${f.cycleCount}`,
      `- 确定性证据：${f.noProgressEvidence}`,
      '- 区间内反复出现的代表性内容样本：',
      ...samples.map((s, i) => `  [样本${i + 1}] ${s}`),
    ].join('\n');
  });

  return [
    '你是一名 Agent 轨迹故障分析专家。下面是一个确定性检测器在某条 agent 执行 trace 上发现的若干"疑似循环 / 无进展"区段。',
    '检测器只给出结构化事实和代表性内容样本；请你**基于样本的真实内容**判断每一段到底在反复做什么、为什么不收敛，并给出针对性的修复建议。',
    '',
    '要求：',
    '- 只依据给到的样本和事实作答，不要编造样本里没有的细节。',
    '- summary：1 句话结论，点明"在哪、反复做什么、为何卡住"。',
    '- mechanism：故障机制详解，2-4 句，说明这个循环为什么不终止（例如：需要的内容被压缩/截断、前置任务未完成、缺少终止条件等，以样本为准）。',
    '- faultChain：3-5 个有序短语，描述一轮循环里依次发生了什么。',
    '- correctionGuidance：针对**该具体循环**的修复建议，要具体、可执行，不要套话。',
    '- 全部用中文。',
    '',
    '只输出如下 JSON（不要 markdown 代码块、不要多余文字）：',
    '{"items":[{"id":"<finding id>","summary":"...","mechanism":"...","faultChain":["...","..."],"correctionGuidance":"..."}]}',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function collectSamples(finding: AgentDebugTrajectoryFinding, byInteraction: Map<number, DebugTurn>): string[] {
  const samples: string[] = [];
  const seen = new Set<number>();
  for (const anchor of finding.anchors) {
    if (samples.length >= MAX_SAMPLES_PER_FINDING) break;
    const idx = anchor.sourceInteractionIndex;
    if (typeof idx !== 'number' || seen.has(idx)) continue;
    seen.add(idx);
    const turn = byInteraction.get(idx);
    if (turn) samples.push(turnContent(turn));
  }
  return samples;
}

function turnContent(turn: DebugTurn): string {
  const parts: string[] = [];
  if (turn.text) parts.push(turn.text);
  else if (turn.reasoningText) parts.push(turn.reasoningText);
  for (const tc of turn.toolCalls || []) {
    const args = truncate(stringify(tc.args), 240);
    const out = tc.output != null ? ` -> ${truncate(stringify(tc.output), 240)}` : '';
    parts.push(`[工具 ${tc.name}] ${args}${out}`);
  }
  return truncate(parts.join(' | ').replace(/\s+/g, ' ').trim(), SAMPLE_CHARS) || '(空)';
}

function parseEnrichment(content: string): Map<string, EnrichmentItem> {
  const out = new Map<string, EnrichmentItem>();
  const obj = parseJsonObject(content);
  const items = obj && Array.isArray((obj as { items?: unknown }).items)
    ? (obj as { items: unknown[] }).items
    : [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) continue;
    out.set(id, {
      summary: typeof item.summary === 'string' ? item.summary : undefined,
      mechanism: typeof item.mechanism === 'string' ? item.mechanism : undefined,
      faultChain: Array.isArray(item.faultChain) ? item.faultChain.filter((s): s is string => typeof s === 'string') : undefined,
      correctionGuidance: typeof item.correctionGuidance === 'string' ? item.correctionGuidance : undefined,
    });
  }
  return out;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
