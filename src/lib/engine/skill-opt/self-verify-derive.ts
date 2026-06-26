/**
 * 脚本真值门的【断言推导】——用 LLM **离线分析数据集标准答案**，挑出「哪些数据值得用确定性断言看护」，
 * 产出 ScriptAssertion[]。LLM 只在 derive 时跑一次（缓存）；验证时由引擎确定性执行，**热路径无 LLM**。
 *
 * 为什么 LLM 放这层、且安全：
 *   · 「该看护哪些事实」是判断活，LLM 读标准答案比写死 `year` 强、且通用（年份/计数/…按 skill 自动出）。
 *   · 护栏让它的产出可信（不是避开 LLM）：它给的期望值必须在数据集 expectedOutput 里**逐字对得上**
 *     （防幻觉，人工策展数据集仍是真值源）；离线跑、缓存、可人工过目，错了也不污染热路径。
 *
 * 故意**不 import opencode SDK**（只 openai + config + 结构模块），便于离线单测/验证。
 */
import { OpenAI } from 'openai';
import { getActiveConfig } from '@/lib/storage/server-config';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import type { DatasetCase } from '@/server/agent_datasets_storage';
import { makeYearAssertion, makeNumericAssertion, type ScriptAssertion } from './self-verify-structural';

export interface FactSpec { description?: string; kind?: string; expectedValue?: string | number }

const PROMPT = `你在为一个 skill 的【脚本质量门】挑选**要用确定性断言看护**的数据点。下面是该 skill 评测数据集里
多个用例的**标准答案**。请挑出应被看护的数据点——只挑**同时满足**：
1. **确定性、脚本从输入算得出**的硬数据（年份/计数/总数/时长/IP 等）；不是解读、建议、或「未记录/需进一步定位」这类判断；
2. 标准答案里有**明确的期望值**；
3. 脚本输出本就该体现它。

每条给：description（一句话）、kind（"year"|"count"|"identifier"|"other"）、expectedValue（确切值字符串，如 "2005"/"1815"）。
排除解读/建议/编造警告类。只输出 JSON：{"facts":[{"description","kind","expectedValue"}, ...]}。

## 数据集标准答案
%EXPECTED%`;

function parseLoose(t: string): Record<string, unknown> {
  try { return JSON.parse(t); } catch { /* */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* */ } }
  return {};
}

function newClient(config: { apiKey?: string; baseUrl?: string }) {
  const { customFetch } = getProxyConfig();
  return new OpenAI({ apiKey: config.apiKey || 'x', baseURL: config.baseUrl || 'https://api.deepseek.com', fetch: customFetch });
}

/** LLM 从标准答案里抽出「该看护的事实」（未经护栏过滤的原始提议）。 */
export async function extractGuardableFacts(cases: DatasetCase[], user: string): Promise<FactSpec[]> {
  const config = await getActiveConfig(user);
  if (!config?.apiKey) return [];
  const expected = cases.map((c, i) => `【用例${i + 1}】${(c.expectedOutput || '').slice(0, 700)}`).join('\n').slice(0, 7000);
  try {
    const r = await newClient(config).chat.completions.create({
      model: config.model || 'deepseek-chat', temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: PROMPT.replace('%EXPECTED%', expected) }],
    });
    const j = parseLoose(r.choices?.[0]?.message?.content || '') as { facts?: FactSpec[] };
    return Array.isArray(j.facts) ? j.facts : [];
  } catch (e) {
    console.warn('[self-verify] LLM fact extraction failed:', (e as Error)?.message);
    return [];
  }
}

const REVIEW_PROMPT = `你在审核「skill 脚本质量门」的候选断言，删掉**不该用确定性断言看护**的。
判据 = 「这是不是一个**全日志的全局不变量、且脚本本就该算的量**」：
- **保留**：全日志全局量（总行数、全日志命中数、某类事件全日志总数、日志年份、某全局 Top 项等）
  ——**哪怕脚本当前算错/没算，那正是要抓的 bug，必须留**。
- **删除**：某个用例问题的**子范围/条件子集**的数（不是全日志全局）；或口径跟脚本全局字段对不上的错配
  （把某用例的子量当成脚本的全局总数）。
⚠️ 判断依据是「按 scope 是不是全局不变量」，**不是**「当前脚本输出里有没有这个值」——脚本可能漏算本该算的
全局量，那种要保留。真·拿不准就删（宁可漏看护，不可误拦）。

## 候选事实（带编号）
%FACTS%
## 用例问题（看每条数据的 scope 是全局还是某道题的子范围）
%INPUTS%
## 脚本对真实输入的实际输出样本（看脚本算了哪些全局字段）
%SAMPLE%

只输出 JSON：{"keep":[要保留的编号, ...]}`;

/** 独立 reviewer（第二次 LLM 调用，逆向高精度）：删掉 per-case 子范围/口径错配的假阳（如「200」）。 */
async function reviewFacts(facts: FactSpec[], scriptSample: string, cases: DatasetCase[], user: string): Promise<FactSpec[]> {
  if (!facts.length) return [];
  const config = await getActiveConfig(user);
  if (!config?.apiKey) return facts;
  const factsText = facts.map((f, i) => `${i}. [${f.kind}] ${f.description ?? ''}（期望 ${f.expectedValue}）`).join('\n');
  const inputs = cases.map((c, i) => `【用例${i + 1}】${(c.input || '').slice(0, 200)}`).join('\n').slice(0, 3000);
  const prompt = REVIEW_PROMPT.replace('%FACTS%', factsText).replace('%INPUTS%', inputs).replace('%SAMPLE%', scriptSample.slice(0, 4000));
  try {
    const r = await newClient(config).chat.completions.create({
      model: config.model || 'deepseek-chat', temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    const j = parseLoose(r.choices?.[0]?.message?.content || '') as { keep?: number[] };
    if (!Array.isArray(j.keep)) return [];
    const keep = new Set(j.keep.map(Number));
    return facts.filter((_, i) => keep.has(i));
  } catch (e) {
    // reviewer 失败 → 不带未审的断言进门（避免假阳让主动修追幽灵）；脚本真值门本轮 no-op。
    console.warn('[self-verify] reviewer failed → drop script-truth assertions this round:', (e as Error)?.message);
    return [];
  }
}

/** 护栏：期望值必须在数据集标准答案里逐字出现（防 LLM 幻觉出一个不存在的真值）。 */
function appearsInDataset(value: string, cases: DatasetCase[]): boolean {
  if (!value) return false;
  return cases.map((c) => c.expectedOutput || '').join('\n').includes(value);
}

/** 一条 fact → 可执行断言。只给**能确定性校验**的 kind 建断言；identifier/other 回显歧义大，留给行为门②。 */
function specToAssertion(spec: FactSpec): ScriptAssertion | null {
  const v = String(spec.expectedValue ?? '').trim();
  if (!v) return null;
  if (spec.kind === 'year' && /^\d{4}$/.test(v)) return makeYearAssertion(v);
  if ((spec.kind === 'count' || spec.kind === 'number') && /^\d+(?:\.\d+)?$/.test(v)) return makeNumericAssertion((spec.description || 'count').slice(0, 24), v);
  return null;
}

const cache = new Map<string, ScriptAssertion[]>();

/**
 * 数据集 → 该看护的事实 → 可执行断言。两段 LLM + 数据集护栏 + 缓存：
 *   extractor(LLM#1, 高召回) → 逐字反查数据集护栏(防幻觉) → reviewer(LLM#2, 独立逆向, 删 per-case
 *   子范围/口径错配如「200」) → specToAssertion。
 * @param scriptSample 脚本对真实输入的输出样本（给 reviewer 看「脚本算了哪些全局字段」；缺省也能跑，reviewer 靠 scope 判）
 * 无 LLM 配置 / 抽不出 / 全被删 → 空数组 → 脚本真值门 no-op（诚实降级，交行为门②）。
 */
export async function deriveScriptAssertions(cases: DatasetCase[], user: string, scriptSample = ''): Promise<ScriptAssertion[]> {
  if (!cases.length) return [];
  const key = `${user}:${cases.length}:${cases.map((c) => c.id).join(',').slice(0, 120)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const proposed = await extractGuardableFacts(cases, user);                                          // LLM#1 高召回
  const guarded = proposed.filter((f) => appearsInDataset(String(f.expectedValue ?? ''), cases));     // 护栏：逐字反查防幻觉
  const reviewed = await reviewFacts(guarded, scriptSample, cases, user);                             // LLM#2 删 per-case 假阳
  const assertions = reviewed.map(specToAssertion).filter((a): a is ScriptAssertion => a != null);
  cache.set(key, assertions);
  return assertions;
}
