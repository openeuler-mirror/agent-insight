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

function parseLoose(t: string): { facts?: FactSpec[] } {
  try { return JSON.parse(t); } catch { /* */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* */ } }
  return {};
}

/** LLM 从标准答案里抽出「该看护的事实」（未经护栏过滤的原始提议）。 */
export async function extractGuardableFacts(cases: DatasetCase[], user: string): Promise<FactSpec[]> {
  const config = await getActiveConfig(user);
  if (!config?.apiKey) return [];
  const { customFetch } = getProxyConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl || 'https://api.deepseek.com', fetch: customFetch });
  const expected = cases.map((c, i) => `【用例${i + 1}】${(c.expectedOutput || '').slice(0, 700)}`).join('\n').slice(0, 7000);
  try {
    const r = await client.chat.completions.create({
      model: config.model || 'deepseek-chat', temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: PROMPT.replace('%EXPECTED%', expected) }],
    });
    const j = parseLoose(r.choices?.[0]?.message?.content || '');
    return Array.isArray(j.facts) ? j.facts : [];
  } catch (e) {
    console.warn('[self-verify] LLM fact extraction failed:', (e as Error)?.message);
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
 * 数据集 → 该看护的事实 → 可执行断言（LLM 推导 + 数据集护栏 + 缓存）。
 * 无 LLM 配置 / 抽不出 / 护栏全否 → 空数组 → 脚本真值门 no-op（诚实降级，交行为门②）。
 */
export async function deriveScriptAssertions(cases: DatasetCase[], user: string): Promise<ScriptAssertion[]> {
  if (!cases.length) return [];
  const key = `${user}:${cases.length}:${cases.map((c) => c.id).join(',').slice(0, 120)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const facts = await extractGuardableFacts(cases, user);
  const assertions = facts
    .filter((f) => appearsInDataset(String(f.expectedValue ?? ''), cases))
    .map(specToAssertion)
    .filter((a): a is ScriptAssertion => a != null);
  cache.set(key, assertions);
  return assertions;
}
