// 队列上限、flush 间隔、批次与清理批次是经过压测的保护常量，不暴露为部署配置（Phase2 §10）。
export const QUEUE_CAPACITY = 5000;
// 入队后多久落库。设计文档写的是 1000ms，但那会留出一个"刚点完操作就重启 → 事件丢失"
// 的窗口（信号处理函数不能 await，兜底 drain 抢不过进程退出）。
// 压到 50ms：仍然能把突发点击合并成一批，用户感知上却是"点完就已入库"。
export const FLUSH_INTERVAL_MS = 50;
export const FLUSH_BATCH_SIZE = 200;
export const CLEANUP_BATCH_SIZE = 1000;
export const CLEANUP_MAX_BATCHES = 5;

export const MAX_CLIENT_BATCH = 50;
export const MAX_ROUTE_LENGTH = 200;
export const MAX_KEY_LENGTH = 64;
export const MAX_USER_LENGTH = 128;
export const MAX_EVENT_ID_LENGTH = 64;

export const DEFAULT_RAW_RETENTION_DAYS = 365;

export function isUsageEnabled(): boolean {
    return process.env.AGENT_INSIGHT_USAGE_ENABLED === '1';
}

export function getRawRetentionDays(): number {
    const raw = process.env.AGENT_INSIGHT_USAGE_RAW_RETENTION_DAYS;
    if (!raw) return DEFAULT_RAW_RETENTION_DAYS;
    const n = Number(raw);
    // 小于 1 按配置错误处理，回落默认值，绝不用来控制永久日聚合。
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RAW_RETENTION_DAYS;
    return Math.floor(n);
}
