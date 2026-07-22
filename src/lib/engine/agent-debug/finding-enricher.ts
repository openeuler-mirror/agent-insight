import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

import { getActiveConfig } from '@/lib/storage/server-config';
import { parseJsonObject } from './json';
import type { AgentDebugDetectorFinding, DebugTurn } from './types';

interface EnrichmentItem { summary?: string; mechanism?: string; faultChain?: string[]; correctionGuidance?: string; }

export async function enrichDetectorFindings(findings: AgentDebugDetectorFinding[], turns: DebugTurn[], user?: string | null): Promise<AgentDebugDetectorFinding[]> {
  if (!findings.length) return findings;
  const config = await getActiveConfig(user);
  if (!config) return findings;
  try {
    const model = new ChatOpenAI({
      apiKey: config.apiKey || 'no-api-key',
      model: config.model || 'deepseek-chat',
      configuration: { baseURL: config.baseUrl || 'https://api.deepseek.com' },
      temperature: 0,
      topP: 1,
      modelKwargs: { seed: 42 },
    });
    const byInteraction = new Map(turns.map(turn => [turn.sourceInteractionIndex, turn]));
    const response = await model.invoke([new HumanMessage(buildPrompt(findings, byInteraction))]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const enriched = parseEnrichment(content);
    return findings.map(finding => {
      const item = enriched.get(finding.id);
      if (!item) return finding;
      return {
        ...finding,
        summary: clean(item.summary) || finding.summary,
        mechanism: clean(item.mechanism) || finding.mechanism,
        faultChain: item.faultChain?.map(clean).filter(Boolean) || finding.faultChain,
        correctionGuidance: clean(item.correctionGuidance) || finding.correctionGuidance,
        llmEnriched: true,
      };
    });
  } catch {
    return findings;
  }
}

function buildPrompt(findings: AgentDebugDetectorFinding[], turns: Map<number, DebugTurn>): string {
  const blocks = findings.map(finding => {
    const samples = finding.anchors.slice(0, 4).map(anchor => {
      const turn = typeof anchor.sourceInteractionIndex === 'number' ? turns.get(anchor.sourceInteractionIndex) : undefined;
      return turn ? turnSample(turn) : '';
    }).filter(Boolean);
    return [`### ${finding.id} (${finding.kind})`, ...finding.facts.map(fact => `- 确定性事实：${fact}`), ...samples.map((sample, index) => `- 样本 ${index + 1}：${sample}`)].join('\n');
  });
  return [
    '你是通用专项诊断结果富化器。请只根据诊断器给出的确定性事实和证据样本，改善说明文字。',
    '不得改变计数、区间、比例、锚点和其他结构化事实，不得新增未被证据支持的原因。',
    '全部用中文。只输出 JSON：{"items":[{"id":"...","summary":"...","mechanism":"...","faultChain":["..."],"correctionGuidance":"..."}]}',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function turnSample(turn: DebugTurn): string {
  const tools = turn.toolCalls.map(call => `[工具 ${call.name}] ${stringify(call.args)}${call.output == null ? '' : ` -> ${stringify(call.output)}`}`);
  return truncate([turn.text || turn.reasoningText, ...tools].filter(Boolean).join(' | ').replace(/\s+/g, ' '), 600);
}

function parseEnrichment(content: string): Map<string, EnrichmentItem> {
  const result = new Map<string, EnrichmentItem>();
  const payload = parseJsonObject(content);
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = clean(typeof item.id === 'string' ? item.id : undefined);
    if (!id) continue;
    result.set(id, {
      summary: typeof item.summary === 'string' ? item.summary : undefined,
      mechanism: typeof item.mechanism === 'string' ? item.mechanism : undefined,
      faultChain: Array.isArray(item.faultChain) ? item.faultChain.filter((value): value is string => typeof value === 'string') : undefined,
      correctionGuidance: typeof item.correctionGuidance === 'string' ? item.correctionGuidance : undefined,
    });
  }
  return result;
}

function stringify(value: unknown): string { if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value ?? ''); } }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}…` : value; }
function clean(value: string | undefined): string { return (value || '').trim(); }
