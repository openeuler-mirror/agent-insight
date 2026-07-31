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
import { isModelConnectionReady } from '@/lib/shared/model-connection';
import type { DatasetCase } from '@/server/agent_datasets_storage';
import { makeYearAssertion, makeNumericAssertion, type ScriptAssertion } from './self-verify-structural';

export interface FactSpec { description?: string; kind?: string; expectedValue?: string | number; jsonPath?: string }

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

function newClient(config: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> }) {
  const { customFetch } = getProxyConfig();
  return new OpenAI({
    apiKey: config.apiKey || 'no-api-key-required',
    baseURL: config.baseUrl || 'https://api.deepseek.com',
    defaultHeaders: config.headers,
    fetch: customFetch,
  });
}

/** LLM 从标准答案里抽出「该看护的事实」（未经护栏过滤的原始提议）。 */
export async function extractGuardableFacts(cases: DatasetCase[], user: string): Promise<FactSpec[]> {
  const config = await getActiveConfig(user);
  if (!config || !isModelConnectionReady(config)) return [];
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
判据 = 「这是不是一个**全日志的全局不变量、且脚本本就该算的量**」。**最关键的判断方法：看每条事实的「来源用例问的是什么」**：
- **保留**：来源用例问的是**全日志/整体**的量（总行数、全日志命中数、某类事件全日志总数、日志年份、某全局 Top 项等）
  ——**哪怕脚本当前算错/没算，那正是要抓的 bug，必须留**。
- **删除**：来源用例问的是**某时间窗 / 某子集 / 某条记录 / 某条件下**的量 → 这是 per-case 子范围，**即使描述里写「总数」也只是那个子集的总数**（典型：「高危认证失败总数=200」若来自只问某时间段的用例 → 删）。
⚠️ 不要用「当前脚本输出里有没有这个值」当依据——脚本可能漏算本该算的全局量（那种要保留）。判 scope 只看**来源用例的问题**。
真·拿不准就删（宁可漏看护，不可误拦）。

## 候选事实（每条带：期望值、在几条用例出现、来源用例的问题）
%FACTS%
## 脚本对真实输入的实际输出样本（仅供参考「脚本算了哪些字段」，**不作为保留/删除依据**）
%SAMPLE%

另外（可选，提升精度）：对每条**保留**的事实，若它的值在【脚本实际输出样本】里对应一个清晰的 JSON 字段，
给它的点路径（如 file_info.first_event_time）——门会优先精确查该字段；取不到/不确定**就别给**（会自动回退扫描）。

只输出 JSON：{"keep":[要保留的编号, ...], "paths":{"<编号>":"<点路径>"}}`;

const REVIEW_K = Number(process.env.SKILL_OPT_REVIEW_K) || 3; // reviewer 跑几遍取交集（治非确定性）

/** 独立 reviewer（多遍 LLM 取交集，逆向高精度）：删掉 per-case 子范围/口径错配的假阳（如「200」）。 */
async function reviewFacts(facts: FactSpec[], scriptSample: string, cases: DatasetCase[], user: string): Promise<FactSpec[]> {
  if (!facts.length) return [];
  const config = await getActiveConfig(user);
  if (!config || !isModelConnectionReady(config)) return facts;
  // 给每条事实**溯源**：它的值来自哪条用例的标准答案 + 那条用例问的是什么 + 在几条用例出现。
  // 这是判 scope 的关键信号——「总数=200」听着全局，但若来源用例问的是某时间窗/子集，它就是 per-case 子范围。
  const factsText = facts.map((f, i) => {
    const val = String(f.expectedValue ?? '');
    const src = cases.find((c) => (c.expectedOutput || '').includes(val));
    const nHits = val ? cases.filter((c) => (c.expectedOutput || '').includes(val)).length : 0;
    return `${i}. [${f.kind}] ${f.description ?? ''}（期望 ${val}；在 ${nHits}/${cases.length} 条用例出现；来源用例问的是：${(src?.input || '').replace(/\s+/g, ' ').slice(0, 160)}）`;
  }).join('\n');
  const prompt = REVIEW_PROMPT.replace('%FACTS%', factsText).replace('%SAMPLE%', scriptSample.slice(0, 4000));
  // 跑 k 遍取**交集**治判官非确定性（单次 deepseek temp0 实测会忽删忽留「200」这类边界假阳）。
  // drop-biased：只有**每一轮都保留**才保留（任一轮删→删）——偏精度、与「主动修」配套：
  // 漏看护一个遗留 bug 只是少道门(下次以它为目标会被抓)，留一个假阳却会让主动修去追永远修不掉的幽灵。
  const votes: Set<number>[] = [];
  const pathVotes: Record<string, string> = {};
  for (let round = 0; round < REVIEW_K; round++) {
    try {
      const r = await newClient(config).chat.completions.create({
        model: config.model || 'deepseek-chat', temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      });
      const j = parseLoose(r.choices?.[0]?.message?.content || '') as { keep?: number[]; paths?: Record<string, string> };
      if (!Array.isArray(j.keep)) continue;
      votes.push(new Set(j.keep.map(Number)));
      for (const [k, v] of Object.entries(j.paths ?? {})) if (v && !pathVotes[k]) pathVotes[k] = v;
    } catch (e) {
      console.warn('[self-verify] reviewer round failed (skip):', (e as Error)?.message);
    }
  }
  if (!votes.length) return []; // 全失败 → 不带未审断言进门（脚本真值门本轮 no-op）
  return facts
    .map((f, i): FactSpec | null => (votes.every((s) => s.has(i)) ? { ...f, jsonPath: pathVotes[String(i)] } : null))
    .filter((x): x is FactSpec => x != null);
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
  if (spec.kind === 'year' && /^\d{4}$/.test(v)) return makeYearAssertion(v, spec.jsonPath);
  if ((spec.kind === 'count' || spec.kind === 'number') && /^\d+(?:\.\d+)?$/.test(v)) return makeNumericAssertion((spec.description || 'count').slice(0, 24), v, spec.jsonPath);
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
