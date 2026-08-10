/**
 * jiuwen 摄入的按组节流（coalesce）。
 *
 * 为什么存在：ingestJiuwenOtlp 对「每个 OTLP 批次」都全量重读该组全部 span 并重聚合
 * （durable spool 设计，保重启不丢），单批成本 = O(session 大小) → 整个 run 累积 O(N²)。
 * 12M-token 级的 team run 后期单批要秒级，几十批串行排队时 exporter 的完成信号
 * （team root span）被压到几十分钟后才落库（实验记录见
 * docs/design/…（spike jiuwen-exporter-latency）/ IDEAS.md [B12]）。
 *
 * 策略：span 照旧每批增量落盘（appendJiuwenSpans 不受影响，掉电不丢）；「重读+重聚合+
 * 落库」按组节流——
 *   - 组内首个批次：立即聚合（UI 尽快出现「执行中」行）；
 *   - 带完成信号（已收尾的 team.* root span）的批次：立即聚合（完成状态绝不延迟）；
 *   - 其余批次：距上次聚合 < intervalMs 时只登记，挂 trailing 定时器到期合并聚合一次。
 * 极端情况下（定时器未触发即进程退出）最后一段数据要等下一个批次/重放才落库——但 span
 * 本体已在盘上，且完成信号批次总是立即冲洗，不影响状态正确性。
 */

export type CoalesceFlushFn = (repKey: string, user?: string) => Promise<void>;

interface GroupState {
  hasFlushed: boolean;
  lastFlushMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  pendingUser?: string;
  /** flush 时传给 FlushFn 的桶键（组键是 session 时两者不同——flush 需要一个真实
   *  bucket key 作组解析入口，见 ingest.ts flushGroupByKey）。 */
  repKey?: string;
}

export type OfferOutcome = 'flushed' | 'scheduled' | 'coalesced';

export class JiuwenBatchCoalescer {
  private groups = new Map<string, GroupState>();

  constructor(
    private flush: CoalesceFlushFn,
    private opts: { intervalMs: number; now?: () => number },
  ) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** 一个批次触到了 groupKey 组。urgent=批次含完成信号，绕过节流。
   *  repKey=冲洗时传给 FlushFn 的桶键（缺省用 groupKey）。 */
  async offer(
    groupKey: string,
    opts: { urgent?: boolean; user?: string; repKey?: string } = {},
  ): Promise<OfferOutcome> {
    const interval = this.opts.intervalMs;
    const now = this.nowMs();
    let st = this.groups.get(groupKey);
    if (!st) {
      st = { hasFlushed: false, lastFlushMs: 0, timer: null };
      this.groups.set(groupKey, st);
    }
    if (opts.user) st.pendingUser = opts.user;
    st.repKey = opts.repKey ?? groupKey;

    const due = interval <= 0 || opts.urgent || !st.hasFlushed || now - st.lastFlushMs >= interval;
    if (due) {
      await this.flushNow(groupKey);
      return 'flushed';
    }
    if (st.timer) return 'coalesced'; // 已有 trailing 定时器，本批并入
    const delay = Math.max(1, st.lastFlushMs + interval - now);
    st.timer = setTimeout(() => {
      st!.timer = null;
      void this.flushNow(groupKey).catch(() => { /* flushNow 内部已记账,避免未处理拒绝 */ });
    }, delay);
    // 不阻止进程退出;进程退出时的残余由下一个批次/重放兜底,完成信号批次总是立即冲洗。
    if (typeof st.timer.unref === 'function') st.timer.unref();
    return 'scheduled';
  }

  /** 立即冲洗一个组（清掉挂着的定时器）。flush 抛错也推进 lastFlushMs，防热循环。 */
  async flushNow(groupKey: string): Promise<void> {
    const st = this.groups.get(groupKey);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    const user = st?.pendingUser;
    if (st) {
      st.hasFlushed = true;
      st.lastFlushMs = this.nowMs();
    }
    try {
      await this.flush(st?.repKey ?? groupKey, user);
    } finally {
      if (st) st.lastFlushMs = this.nowMs();
    }
  }

  /** 测试用：有挂起定时器的组数。 */
  pendingCount(): number {
    let n = 0;
    for (const st of this.groups.values()) if (st.timer) n += 1;
    return n;
  }
}

/** 该批次里、属于 bucket key 的 span 中是否有已收尾的 team.* root（完成信号）。
 *  与 aggregate.ts 的 endedTeamRootSpan 同判据：span 名以 team. 开头且 endNs>0。 */
export function batchHasEndedTeamRoot(
  spans: Array<{ traceId?: string; name: string; endNs: number }>,
  bucketKey: string,
): boolean {
  return spans.some(
    (s) => (s.traceId || '') === bucketKey && s.name.startsWith('team.') && s.endNs > 0,
  );
}
