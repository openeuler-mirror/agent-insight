/**
 * 进程内"待用户应答"的交互请求注册表。
 *
 * 用法：runner 的 onPermission / onQuestion handler 收到事件后，把请求登记进来并 await
 * 一个 Promise；前端通过单独的 HTTP 端点拿到请求详情后回传应答，应答路径调用
 * resolveInteraction() 把 Promise resolve 掉，handler 拿到返回值再回给 opencode。
 *
 * 限制：仅单进程内生效。多实例部署需要换成 Redis pub/sub 或 sticky session。
 */

export type InteractionKind = 'permission' | 'question';

interface PendingEntry {
  requestId: string;
  kind: InteractionKind;
  user: string;
  /** 用于按"流"批量取消（如客户端断连时）。 */
  streamId: string;
  resolve: (reply: any) => void;
  reject: (err: Error) => void;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

// 钉到 globalThis 抗 HMR / 多 bundle：dev 模式下 Next.js 重载源文件 OR 不同 route handler
// 各自加载这个模块时，会出现"bridge 在 Map A 里 awaitInteraction，respond route 在 Map B
// 里 resolveInteraction"——后者永远找不到，POST /api/agent/respond 返回 404，前端转圈。
// 同样的模式参考 internal-agent-tag 那边的处理。
const G = globalThis as unknown as { __wittyPendingMap?: Map<string, PendingEntry> };
const pending: Map<string, PendingEntry> = G.__wittyPendingMap ?? (G.__wittyPendingMap = new Map());

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface AwaitInteractionOptions {
  requestId: string;
  kind: InteractionKind;
  user: string;
  streamId: string;
  ttlMs?: number;
}

/**
 * 登记一个待应答的请求并 await 其应答。
 * 如果 ttlMs 内无人应答，promise 以 timeout 错误 reject，调用方自行决定降级（如默认拒绝）。
 */
export function awaitInteraction(opts: AwaitInteractionOptions): Promise<any> {
  if (pending.has(opts.requestId)) {
    return Promise.reject(new Error(`duplicate requestId: ${opts.requestId}`));
  }
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(opts.requestId);
      if (!entry) return;
      pending.delete(opts.requestId);
      entry.reject(new Error(`interaction ${opts.kind}/${opts.requestId} timed out after ${ttl}ms`));
    }, ttl);
    pending.set(opts.requestId, {
      requestId: opts.requestId,
      kind: opts.kind,
      user: opts.user,
      streamId: opts.streamId,
      resolve,
      reject,
      expiresAt: Date.now() + ttl,
      timer,
    });
  });
}

/**
 * 用户回传应答。
 * 返回 true 表示找到并 resolve 成功；false 表示请求不存在或已超时/被取消。
 * 抛错表示 user 不匹配（防止越权应答别人的请求）。
 */
export function resolveInteraction(requestId: string, user: string, reply: any): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  if (entry.user !== user) {
    throw new Error('user mismatch on interaction reply');
  }
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(reply);
  return true;
}

/** 按 streamId 批量取消（客户端断连/请求结束时调用）。 */
export function cancelStream(streamId: string, reason = 'stream closed'): number {
  let cancelled = 0;
  for (const [reqId, entry] of pending) {
    if (entry.streamId === streamId) {
      pending.delete(reqId);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      cancelled++;
    }
  }
  return cancelled;
}

/** 调试/审计用：当前 pending 数量。 */
export function getPendingCount(): number {
  return pending.size;
}

/** 调试/审计用：按 user 列出 pending（不暴露 resolve/reject 句柄）。 */
export function listPendingForUser(user: string): Array<{
  requestId: string;
  kind: InteractionKind;
  expiresAt: number;
}> {
  const list: Array<{ requestId: string; kind: InteractionKind; expiresAt: number }> = [];
  for (const entry of pending.values()) {
    if (entry.user === user) {
      list.push({ requestId: entry.requestId, kind: entry.kind, expiresAt: entry.expiresAt });
    }
  }
  return list;
}
