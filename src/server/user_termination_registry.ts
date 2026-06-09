/**
 * "用户级终止"标记表(跨 Next 模块重载/HMR 存活)。
 *
 * 用户点「终止」时,terminateAllForUser 给该 user 打一个时间戳。后台 opencode 任务的统一入口
 * withBackgroundOpencodeSlot 在拿到 slot 后会查这张表:**如果这个任务在该用户的终止时刻之前就已入队**
 * (= 属于被终止的那批 in-flight 工作),就直接中止、不再真正去跑 opencode。
 *
 * 为什么用"入队时刻 vs 终止时刻"而不是布尔开关:终止只应作用于"终止那一刻还在飞的工作",
 * 不能误伤用户终止之后又重新发起的新任务(它们入队更晚 → 不受影响)。
 */
const TABLE_KEY = Symbol.for('@witty-insight/user-termination-marks');

function table(): Map<string, number> {
    const g = globalThis as unknown as Record<symbol, Map<string, number>>;
    if (!g[TABLE_KEY]) g[TABLE_KEY] = new Map<string, number>();
    return g[TABLE_KEY];
}

/** 标记某 user 在 `atMs` 触发了一次"终止全部"。 */
export function markUserTerminated(user: string, atMs: number = Date.now()): void {
    if (!user) return;
    table().set(user, atMs);
}

/** 返回该 user 最近一次终止的时间戳(ms),没有则 undefined。 */
export function getUserTerminatedAt(user: string | null | undefined): number | undefined {
    if (!user) return undefined;
    return table().get(user);
}

/**
 * 一个属于 `user`、在 `enqueuedAtMs` 入队的后台任务,是否落在某次"用户终止"的覆盖范围内
 * (即:该用户在它入队之后、或恰好同刻,触发过终止)→ 应被中止。
 */
export function isTaskTerminated(user: string | null | undefined, enqueuedAtMs: number): boolean {
    const t = getUserTerminatedAt(user);
    return t !== undefined && t >= enqueuedAtMs;
}
