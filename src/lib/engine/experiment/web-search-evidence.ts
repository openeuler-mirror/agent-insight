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

/**
 * 幻觉检测的联网核实证据：按用户联网搜索配置（Tavily）检索回答中的关键事实断言。
 * 仅当 Settings 启用联网搜索（searchProvider=tavily 且有 apiKey）时生效；
 * 搜索局部失败可降级；整轮超时与用户取消必须向外传播。fake judge 单测自动跳过。
 */
import { experimentSignal } from './cancellation-context';
import { hasEvaluatorExecutionPolicy } from './evaluator-execution-policy';
import { trackEvaluationRequest } from './evaluation-attempt';
import { hasJudgeLlmTestInjection } from './judge-llm';

export interface WebSearchHit {
  query: string;
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchEvidence {
  status?: 'success' | 'partial_failure' | 'degraded';
  queries: string[];
  hits: WebSearchHit[];
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_SEARCHES = 2;
const MAX_RESULTS_PER_SEARCH = 3;
const CLAIM_MAX_CHARS = 120;

let gatherOverride: ((user: string, question: string, answer: string) => Promise<WebSearchEvidence | null>) | null = null;

/** 测试注入点：传 null 恢复默认实现。 */
export function setWebSearchEvidenceForTest(fn: typeof gatherOverride): void {
  gatherOverride = fn;
}

/** 从回答中提取疑似事实断言的句子（含年份/百分比/倍数/引用词/书名号等标记），最多 2 条。 */
export function extractFactClaims(answer: string): string[] {
  const marker = /(\d{4}\s*年|%|％|\d+(?:\.\d+)?\s*倍|根据|据统计|研究表明|报告|发表于|提出|《|》|研究|调查|诺贝尔|奖)/;
  return answer
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && marker.test(s))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2)
    .map((s) => (s.length > CLAIM_MAX_CHARS ? `${s.slice(0, CLAIM_MAX_CHARS)}…` : s));
}

async function tavilySearch(apiKey: string, query: string): Promise<WebSearchHit[]> {
  const ctrl = new AbortController();
  const parent = experimentSignal();
  parent?.throwIfAborted();
  const timeout = REQUEST_TIMEOUT_MS;
  const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal;
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeout}ms`)), timeout);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS_PER_SEARCH, include_answer: false }),
      signal,
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (json.results ?? []).map((r) => ({
      query,
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? '').slice(0, 300),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 联网核实入口：配置启用（tavily + apiKey）时，对回答中的事实断言做联网检索。
 * 无可用证据时走知识路径；配置策略下记录降级状态，历史链路仍返回 null。
 */
export async function gatherWebSearchEvidence(user: string, question: string, answer: string): Promise<WebSearchEvidence | null> {
  experimentSignal()?.throwIfAborted();
  if (gatherOverride) {
    const evidence = await trackEvaluationRequest(() => gatherOverride!(user, question, answer));
    experimentSignal()?.throwIfAborted();
    return evidence;
  }
  if (hasJudgeLlmTestInjection()) return null;
  try {
    const { getUserSettings } = await import('@/lib/storage/server-config');
    const settings = await getUserSettings(user);
    if (settings?.searchProvider !== 'tavily' || !settings.searchApiKey) return null;
    const apiKey = settings.searchApiKey;

    const claims = extractFactClaims(answer);
    const queries = claims.length > 0 ? claims : [`${question} ${answer.slice(0, 60)}`.trim()];
    const hits: WebSearchHit[] = [];
    let failures = 0;
    for (const query of queries.slice(0, MAX_SEARCHES)) {
      try {
        experimentSignal()?.throwIfAborted();
        hits.push(...await trackEvaluationRequest(() => tavilySearch(apiKey, query)));
      } catch (err) {
        experimentSignal()?.throwIfAborted();
        failures++;
        console.warn(`[hallucination-web-search] (queryLength=${query.length}) 搜索失败，跳过:`, (err as Error)?.message);
      }
    }
    if (hits.length === 0 && !hasEvaluatorExecutionPolicy()) return null;
    return { queries, hits, status: !hits.length ? 'degraded' : failures ? 'partial_failure' : 'success' };
  } catch (err) {
    experimentSignal()?.throwIfAborted();
    console.warn('[hallucination-web-search] 联网核实降级（配置读取失败或搜索异常）:', (err as Error)?.message);
    return hasEvaluatorExecutionPolicy() ? { queries: [], hits: [], status: 'degraded' } : null;
  }
}
