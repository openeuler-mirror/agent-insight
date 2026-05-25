/**
 * 把 DB 里持久化的 messages 还原成前端可渲染的形态。
 *
 * skill-generator 与 skill-opt 都用同款 `Message.blocks` JSON 字段，但前端的状态形态不同：
 *   - skill-generator 用 Message[]（{role, content, blocks?}），Block 流派开
 *   - skill-opt  用 ChatTurn[]（{kind, ...}），blocks 嵌在 agent turn 里
 *
 * 共享一个底层 `parseStoredBlocks`（pure JSON parser），上层 hydrate 函数各自做形态转换。
 */

/** DB 里 message 的最小子集形态（message 表查出来都长这样） */
export interface RawStoredMessage {
  role: string;
  content: string;
  blocks?: string;
}

/**
 * 把 DB stored blocks JSON 解出来。空串 / 无效 JSON 一律返回 null（上层 fallback 到
 * 把 content 当纯文本展示）。
 */
export function parseStoredBlocks(blocksJson: string | undefined | null): any[] | null {
  if (typeof blocksJson !== 'string' || blocksJson.length <= 2) return null;
  try {
    const parsed = JSON.parse(blocksJson);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    /* legacy fallback engages on render */
  }
  return null;
}

/**
 * skill-opt 专用：把 stored messages 还原成 ChatTurn[]。
 *
 * 用户消息 → `{kind: 'user', id, text}`
 * agent 消息 → `{kind: 'agent', id, blocks: [...]}`，blocks 直接复用 DB 里持久化的数组
 *               （Block 协议两边对齐）；blocks 解不出时退化为单个 text block 用 content 兜底
 */
export function hydrateSkillOptChat(messages: RawStoredMessage[]): Array<
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; blocks: any[]; streaming?: boolean }
> {
  return (messages || []).map((m, idx) => {
    if (m.role === 'user') {
      return { kind: 'user' as const, id: `u_${idx}`, text: m.content || '' };
    }
    // agent
    const stored = parseStoredBlocks(m.blocks);
    const blocks = stored ?? (
      m.content
        ? [{ kind: 'text', id: `t_${idx}_0`, text: m.content }]
        : []
    );
    return { kind: 'agent' as const, id: `a_${idx}`, blocks };
  });
}
