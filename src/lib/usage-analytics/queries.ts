import { USAGE_FEATURES, getEventLabel, getFeatureLabel } from './catalog';
import { dateKeyDaysAgo, enumerateDateKeys, todayDateKey } from './date';
import { getUsageStorage } from './storage';
import type {
    UsageDailyRow,
    UsageFeatureResponse,
    UsageRange,
    UsageStorage,
    UsageSummaryResponse,
} from './types';

export const VALID_RANGES: UsageRange[] = ['7', '30', '90', 'all'];

export function isValidRange(v: unknown): v is UsageRange {
    return typeof v === 'string' && (VALID_RANGES as string[]).includes(v);
}

function windowFor(range: UsageRange, now = new Date()): { from: string | null; to: string } {
    const to = todayDateKey(now);
    if (range === 'all') return { from: null, to };
    return { from: dateKeyDaysAgo(Number(range), now), to };
}

/** 使用用户必须按去重用户名计数 —— 绝不能把每日人数直接相加。 */
function distinctUsers(rows: UsageDailyRow[]): number {
    return new Set(rows.map((r) => r.user)).size;
}

function totalUses(rows: UsageDailyRow[]): number {
    return rows.reduce((a, r) => a + r.count, 0);
}

function buildTrend(rows: UsageDailyRow[], from: string, to: string) {
    const byDate = new Map<string, number>();
    for (const r of rows) byDate.set(r.dateKey, (byDate.get(r.dateKey) ?? 0) + r.count);
    // 逐日补零，返回点数只与自然日数量有关，不与原始事件量成比例。
    return enumerateDateKeys(from, to).map((date) => ({ date, uses: byDate.get(date) ?? 0 }));
}

export async function getUsageSummary(
    range: UsageRange,
    now = new Date(),
    storage: UsageStorage = getUsageStorage()
): Promise<UsageSummaryResponse> {
    const { from, to } = windowFor(range, now);
    const rows = await storage.queryDaily(from, to);

    const effectiveFrom = from ?? (await storage.earliestDateKey()) ?? to;

    const byFeature = new Map<string, UsageDailyRow[]>();
    for (const r of rows) {
        const list = byFeature.get(r.featureKey);
        if (list) list.push(r);
        else byFeature.set(r.featureKey, [r]);
    }

    // 只列注册表中的功能：库里若残留下线功能的历史数据，不应出现在排行里。
    const features = USAGE_FEATURES.map((f) => {
        const fr = byFeature.get(f.key) ?? [];
        return {
            featureKey: f.key,
            label: f.label,
            uses: totalUses(fr),
            users: distinctUsers(fr),
        };
    });

    const trackedKeys = new Set(USAGE_FEATURES.map((f) => f.key));
    const trackedRows = rows.filter((r) => trackedKeys.has(r.featureKey));

    return {
        range,
        from: effectiveFrom,
        to,
        kpis: { users: distinctUsers(trackedRows), uses: totalUses(trackedRows) },
        trend: buildTrend(trackedRows, effectiveFrom, to),
        features,
    };
}

export async function getUsageFeatureDetail(
    featureKey: string,
    range: UsageRange,
    now = new Date(),
    storage: UsageStorage = getUsageStorage()
): Promise<UsageFeatureResponse> {
    const { from, to } = windowFor(range, now);
    const rows = await storage.queryDaily(from, to, featureKey);
    const effectiveFrom = from ?? (await storage.earliestDateKey()) ?? to;

    const byEvent = new Map<string, number>();
    for (const r of rows) byEvent.set(r.eventKey, (byEvent.get(r.eventKey) ?? 0) + r.count);

    return {
        featureKey,
        label: getFeatureLabel(featureKey),
        range,
        kpis: { users: distinctUsers(rows), uses: totalUses(rows) },
        trend: buildTrend(rows, effectiveFrom, to),
        behaviorBreakdown: [...byEvent.entries()]
            .map(([eventKey, count]) => ({ eventKey, label: getEventLabel(eventKey), count }))
            .sort((a, b) => b.count - a.count),
    };
}
