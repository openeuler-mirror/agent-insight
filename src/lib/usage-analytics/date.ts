const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 事件时间以 UTC 保存，日期键按 Asia/Shanghai 自然日生成（Phase1 §3）。 */
export function toDateKey(d: Date): string {
    return new Date(d.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** range=7 表示含今天在内的 7 个自然日，因此回退 days-1 天。 */
export function dateKeyDaysAgo(days: number, now: Date = new Date()): string {
    const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS - (days - 1) * 24 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
}

export function todayDateKey(now: Date = new Date()): string {
    return toDateKey(now);
}

export function enumerateDateKeys(from: string, to: string): string[] {
    const out: string[] = [];
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out;
    for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}
