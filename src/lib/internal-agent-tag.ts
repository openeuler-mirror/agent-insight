/**
 * 内部 opencode-based agent → 上报 trace 时的字段覆盖表。
 *
 * 背景：用户机器上的 opencode plugin（~/.opencode/plugins/Witty-Skill-Insight.ts）会自动
 * 捕捉本机所有 opencode 会话上报到 /api/ingest/upload，包括我们服务自己 spawn 的内部 opencode。
 * 但 plugin 是通用的，不知道一次 session 是用户自己跑的还是 skill-generator/skill-optimizer/评估器
 * 这种"内部 agent"在跑——它把 system prompt 当 query、agentName 留空。
 *
 * 这里维护一张内存映射：在内部 agent 启动 opencode session 后，登记一条
 *   opencodeSessionId → { agentName, agentId, skill, displayQuery? }
 * upload 路由收到 plugin 的上报时，按 task_id（= opencode sessionId）查表，
 * 命中就用我们记的字段覆盖 plugin 误填的内容。
 *
 * 这样所有内部 agent 都走同一条采集链路（plugin → ingest → Execution），但 Execution 上的
 * agentName/agentId/skill 是我们自己写的，与 RegisteredAgent 表能正确关联。
 *
 * 限制：仅单进程内生效。多实例部署需要把映射搬到 Redis 或 DB（查询频率低，DB 可能更合适）。
 */

export interface InternalAgentTag {
  /** Execution.agentName 应填的值。来自 SYSTEM_AGENTS。 */
  agentName: string;
  /** RegisteredAgent.id；找不到时为 null（upload 路由会保留 null）。 */
  agentId: string | null;
  /** Execution.skill 字段（agent 用的内置 skill 名）。可选。 */
  skill?: string;
  /** 用户可见的 query；plugin 经常把 system prompt 当 query，传这个就覆盖。 */
  displayQuery?: string;
  /** 用户名，用于审计 / 校验。 */
  user?: string;
  /** 创建时间，用于 TTL 清理。 */
  createdAt: number;
}

interface InternalAgentTagInput {
  agentName: string;
  agentId?: string | null;
  skill?: string;
  displayQuery?: string;
  user?: string;
}

/**
 * 把 Map 挂到 globalThis 上，防止 Next.js dev HMR 重载本模块时重置内存——
 * 否则 bridge 写到 map1、upload 路由读 map2，tag override 永远查不到。
 * 生产 build 也安全：globalThis 是单进程内全局唯一。
 */
const GLOBAL_KEY = Symbol.for('@witty-insight/internal-agent-tag-map');
const globalAny = globalThis as unknown as { [GLOBAL_KEY]?: Map<string, InternalAgentTag> };
if (!globalAny[GLOBAL_KEY]) {
  globalAny[GLOBAL_KEY] = new Map<string, InternalAgentTag>();
}
const tags: Map<string, InternalAgentTag> = globalAny[GLOBAL_KEY]!;

/**
 * 默认 TTL 1 小时——plugin uploader 通常 15s 后上报；超过 1h 没消费的就 GC。
 * 可以通过 INTERNAL_AGENT_TAG_TTL_MS env 调整。
 */
const TAG_TTL_MS = Number(process.env.INTERNAL_AGENT_TAG_TTL_MS) || 60 * 60 * 1000;

/** 简单的 lazy cleanup：每次 set 时顺便扫一遍过期的，避免内存泄漏。 */
function gcExpired(): void {
  const cutoff = Date.now() - TAG_TTL_MS;
  for (const [k, v] of tags) {
    if (v.createdAt < cutoff) tags.delete(k);
  }
}

/**
 * 给一个 opencode session 打标签。同一 sessionId 多次调用以最新的为准
 * （多轮对话首次调用即可，后续 turn 即便不再 set 也能命中已存的）。
 */
export function tagOpencodeSession(
  opencodeSessionId: string,
  input: InternalAgentTagInput,
): void {
  if (!opencodeSessionId) return;
  gcExpired();
  tags.set(opencodeSessionId, {
    agentName: input.agentName,
    agentId: input.agentId ?? null,
    skill: input.skill,
    displayQuery: input.displayQuery,
    user: input.user,
    createdAt: Date.now(),
  });
}

/** upload 路由查表用。命中返回 tag；未命中或过期返回 undefined。 */
export function getInternalAgentTag(
  opencodeSessionId: string,
): InternalAgentTag | undefined {
  if (!opencodeSessionId) return undefined;
  const tag = tags.get(opencodeSessionId);
  if (!tag) return undefined;
  if (Date.now() - tag.createdAt > TAG_TTL_MS) {
    tags.delete(opencodeSessionId);
    return undefined;
  }
  return tag;
}

/** 显式清除（一般不用，TTL 自动管）。 */
export function clearInternalAgentTag(opencodeSessionId: string): void {
  tags.delete(opencodeSessionId);
}

/** 调试用：当前注册数量。 */
export function getInternalAgentTagCount(): number {
  return tags.size;
}
