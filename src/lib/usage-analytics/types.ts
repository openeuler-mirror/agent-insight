export type UsageEventSource = 'client' | 'server';

export type UsageRange = '7' | '30' | '90' | 'all';

export interface EffectiveUseDefinition {
    key: string;
    label: string;
    source: UsageEventSource;
    countWhen: string;
}

export interface UsageFeatureDefinition {
    /** 对外统计 key，与 AppSidebar 叶子菜单 key 对齐（skillsmgr 显式映射为 skill）。 */
    key: string;
    /** 侧边栏 locale key，用于展示名回填；不入库。 */
    labelKey: string;
    label: string;
    uses: EffectiveUseDefinition[];
}

/** 入队前的规范化事件。user 一律由服务端认证结果注入，客户端不可指定。 */
export interface UsageEvent {
    eventId: string;
    occurredAt: Date;
    dateKey: string;
    user: string;
    featureKey: string;
    eventKey: string;
    source: UsageEventSource;
    route?: string | null;
}

/** 客户端上报体：不含 user，不含 source。 */
export interface UsageEventInput {
    eventId: string;
    occurredAt: string;
    featureKey: string;
    eventKey: string;
    route?: string;
}

export interface UsageDailyDelta {
    dateKey: string;
    user: string;
    featureKey: string;
    eventKey: string;
    count: number;
    firstOccurredAt: Date;
    lastOccurredAt: Date;
}

export interface UsageDailyRow {
    dateKey: string;
    user: string;
    featureKey: string;
    eventKey: string;
    count: number;
}

export interface UsageStorage {
    /** 幂等写入原始事件 + 按实际新增事件增量更新日聚合，返回实际新增条数。 */
    persistBatch(events: UsageEvent[]): Promise<number>;
    /** 读取日聚合明细；from 为 null 表示"全部"。 */
    queryDaily(from: string | null, to: string, featureKey?: string): Promise<UsageDailyRow[]>;
    /** 最早的聚合日期，用于"全部"范围回填 from。 */
    earliestDateKey(): Promise<string | null>;
    /** 删除截止日之前的原始事件（不动日聚合），返回删除行数。 */
    cleanupRawBefore(dateKey: string, maxBatches?: number): Promise<number>;
}

export interface UsageSummaryResponse {
    range: UsageRange;
    from: string | null;
    to: string;
    kpis: { users: number; uses: number };
    trend: Array<{ date: string; uses: number }>;
    features: Array<{ featureKey: string; label: string; uses: number; users: number }>;
}

export interface UsageFeatureResponse {
    featureKey: string;
    label: string;
    range: UsageRange;
    kpis: { users: number; uses: number };
    trend: Array<{ date: string; uses: number }>;
    behaviorBreakdown: Array<{ eventKey: string; label: string; count: number }>;
}

export interface UsageAccessResponse {
    enabled: boolean;
    isAdmin: boolean;
}
