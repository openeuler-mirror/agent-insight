/**
 * 从一轮 agent 的多条 assistant 文本消息里提取**核心输出**给评测/打分用。
 *
 * 为什么需要：
 *  - 只取最后一条 → 多轮 agent 最后常是空消息或"分析完毕，见上"，真分析在前几轮 → 丢内容、评 0。
 *  - 简单拼接所有 → 把"让我读下日志""现在跑脚本"之类过程旁白也喂给 judge，污染覆盖判定。
 *
 * 启发式：分析报告通常是最长的那条 assistant 消息。以它为主，按时序带上同等量级
 * （≥ 最长的 ratio，默认 50%）的兄弟消息（覆盖"分多段写报告"），短旁白/指针自然被滤掉。
 */
export function extractCoreOutput(
  messages: Array<string | null | undefined>,
  opts: { siblingRatio?: number; fallback?: string } = {},
): string {
  const ratio = opts.siblingRatio ?? 0.5;
  const fallback = opts.fallback ?? '';
  const msgs = messages.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
  if (msgs.length === 0) return fallback.trim();
  if (msgs.length === 1) return msgs[0].trim();

  const maxLen = Math.max(...msgs.map((m) => m.length));
  const core = msgs.filter((m) => m.length >= maxLen * ratio);
  const out = (core.length > 0 ? core : msgs).join('\n\n').trim();
  return out || fallback.trim();
}
