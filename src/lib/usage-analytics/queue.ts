import {
    FLUSH_BATCH_SIZE,
    FLUSH_INTERVAL_MS,
    QUEUE_CAPACITY,
    getRawRetentionDays,
    isUsageEnabled,
} from './config';
import { todayDateKey } from './date';
import { getUsageStorage } from './storage';
import type { UsageEvent, UsageStorage } from './types';

const LOG_THROTTLE_MS = 60_000;
let lastLogAt = 0;

function throttledWarn(msg: string, extra?: unknown) {
    const now = Date.now();
    if (now - lastLogAt < LOG_THROTTLE_MS) return;
    lastLogAt = now;
    console.warn(`[usage] ${msg}`, extra ?? '');
}

export interface QueueStats {
    depth: number;
    dropped: number;
    flushed: number;
    failures: number;
}

export class UsageQueue {
    private buf: UsageEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private flushing = false;
    private retried = new WeakSet<UsageEvent>();

    dropped = 0;
    flushed = 0;
    failures = 0;
    lastCleanupDateKey: string | null = null;

    constructor(
        private storage: UsageStorage,
        private capacity = QUEUE_CAPACITY
    ) {}

    get depth() {
        return this.buf.length;
    }

    stats(): QueueStats {
        return { depth: this.buf.length, dropped: this.dropped, flushed: this.flushed, failures: this.failures };
    }

    /** 同步入队。队列满立即丢弃统计事件 —— 绝不反压业务。 */
    enqueue(e: UsageEvent): boolean {
        if (this.buf.length >= this.capacity) {
            this.dropped++;
            throttledWarn('usage.queue.dropped: queue full', { depth: this.buf.length, dropped: this.dropped });
            return false;
        }
        this.buf.push(e);
        if (this.buf.length >= FLUSH_BATCH_SIZE) {
            void this.flush();
        } else {
            this.ensureTimer();
        }
        return true;
    }

    private ensureTimer() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, FLUSH_INTERVAL_MS);
        // 定时器不应拖住进程退出。
        this.timer.unref?.();
    }

    async flush(): Promise<void> {
        if (this.flushing) return;
        if (!this.buf.length) return;
        this.flushing = true;

        const batch = this.buf.splice(0, FLUSH_BATCH_SIZE);
        const startedAt = Date.now();
        try {
            const n = await this.storage.persistBatch(batch);
            this.flushed += n;
            const ms = Date.now() - startedAt;
            if (ms > 1000) throttledWarn('usage.flush.duration_ms high', { ms, events: batch.length });
            await this.maybeCleanup();
        } catch (err) {
            this.failures++;
            // 失败最多重入队一次；第二次失败或队列已满即丢弃。
            for (const e of batch) {
                if (this.retried.has(e)) {
                    this.dropped++;
                    continue;
                }
                this.retried.add(e);
                if (this.buf.length >= this.capacity) {
                    this.dropped++;
                    continue;
                }
                this.buf.push(e);
            }
            throttledWarn('usage.flush.failures', err instanceof Error ? err.message : String(err));
        } finally {
            this.flushing = false;
            if (this.buf.length) this.ensureTimer();
        }
    }

    /** 每天最多跑一次有限批次清理，跟在 flush 之后，不占用业务请求连接。 */
    private async maybeCleanup() {
        const today = todayDateKey();
        if (this.lastCleanupDateKey === today) return;
        this.lastCleanupDateKey = today;
        try {
            const cutoff = new Date(Date.now() - getRawRetentionDays() * 24 * 60 * 60 * 1000);
            const n = await this.storage.cleanupRawBefore(todayDateKey(cutoff));
            if (n > 0) console.log(`[usage] usage.cleanup.deleted=${n}`);
        } catch (err) {
            throttledWarn('usage.cleanup failed', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 尽力清空队列，不保证强一致。
     *
     * 必须等在途 flush 结束再判断进度：flush() 遇到 flushing=true 会直接 return，
     * 若不等就轮询 buf.length，调用方会陷入不推进的忙等。
     */
    async drain(): Promise<void> {
        while (this.buf.length) {
            const before = this.buf.length;
            await this.settle();
            await this.flush();
            if (this.buf.length >= before) break;
        }
    }

    /** 等待当前在途 flush 结束（若有）。 */
    async settle(): Promise<void> {
        while (this.flushing) {
            await new Promise((r) => setTimeout(r, 1));
        }
    }
}

let queue: UsageQueue | null = null;
let shutdownHooked = false;

/**
 * 进程退出前尽力把队列里的事件写完。
 *
 * 注意这只是"尽力"：信号处理函数不能 await，Node 可能在异步写完成前就退出。
 * 真正保证"刚点的操作不丢"的是 enqueue 里的即时 flush（见 FLUSH_DELAY_MS），
 * 这个钩子只是多一层兜底。
 */
function installShutdownDrain() {
    if (shutdownHooked || typeof process === 'undefined') return;
    shutdownHooked = true;

    const drain = () => {
        const q = queue;
        if (!q || q.depth === 0) return;
        void q.drain().catch(() => {});
    };

    process.on('beforeExit', drain);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, drain);
    }
}

export function getUsageQueue(): UsageQueue | null {
    // 关闭时绝不创建队列，也就不会有定时器和 storage 调用。
    if (!isUsageEnabled()) return null;
    if (!queue) {
        queue = new UsageQueue(getUsageStorage());
        installShutdownDrain();
    }
    return queue;
}

export function __setUsageQueueForTest(q: UsageQueue | null) {
    queue = q;
}
