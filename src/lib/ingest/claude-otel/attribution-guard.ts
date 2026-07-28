/**
 * attribution-guard —— 后台消费者侧归属防线
 *
 * 职责：在聚合产出 ExecutionRecord 后、落库前校验 user 归属。
 * 无法解析 user 的会话不落库（丢弃 + 结构化日志），
 * 不复制聚合器 `traces-aggregator.ts:145` 的 anonymous 兜底。
 *
 * 判定口径（W-2）：聚合器已将空 user 兜底为 'anonymous'，
 * 故 record.user 永不为空——guard 必须判 user 是否为空
 * 或 isServiceTraceOwner(user)，命中则丢弃。
 *
 * 对所有 OTLP 框架生效（框架无关防线）。
 */

import { isServiceTraceOwner } from '@/lib/storage/data-service';

export interface GuardInput {
  /** 聚合产物的 user 字段 */
  user: string | null | undefined;
  /** 会话归并键 */
  taskId?: string | null;
  /** 框架标识 */
  framework?: string | null;
  /** 本批聚合的事件数 */
  eventCount?: number;
}

export interface GuardPass {
  pass: true;
}

export interface GuardDrop {
  pass: false;
  reason: 'unattributed';
  /** 会话归并键（仅用于日志） */
  taskId?: string;
  /** 框架标识（仅用于日志） */
  framework?: string;
  /** 事件数（仅用于日志） */
  eventCount?: number;
}

export type GuardResult = GuardPass | GuardDrop;

/**
 * 归属判定谓词。
 *
 * 判定逻辑：user 为空 或 属于服务账号集合（admin/anonymous/空）→ drop
 * 否则 pass。
 *
 * 这是一个纯函数，无 I/O 副作用。
 */
export function guardAttribution(input: GuardInput): GuardResult {
  const user = (input.user || '').trim();

  // user 为空 → 无法归属
  if (!user) {
    return {
      pass: false,
      reason: 'unattributed',
      taskId: input.taskId || undefined,
      framework: input.framework || undefined,
      eventCount: input.eventCount,
    };
  }

  // user 属于服务账号（如 anonymous, admin 等）→ 无法归属到真实用户
  if (isServiceTraceOwner(user)) {
    return {
      pass: false,
      reason: 'unattributed',
      taskId: input.taskId || undefined,
      framework: input.framework || undefined,
      eventCount: input.eventCount,
    };
  }

  return { pass: true };
}
