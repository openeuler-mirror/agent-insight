type CacheOptions = {
    maxBytes?: number;
    maxEntries?: number;
    idleMs?: number;
    now?: () => number;
};

export function createSessionBodyCache<T>(
    build: (interactions: string, nodes: string, framework: string) => T,
    { maxBytes = 256 * 1024 * 1024, maxEntries = 8, idleMs = 45_000, now = Date.now }: CacheOptions = {},
) {
    const entries = new Map<string, {
        interactions: string; nodes: string; framework: string;
        value: T; bytes: number; touchedAt: number;
    }>();
    let bytes = 0;
    const remove = (key: string) => {
        const entry = entries.get(key);
        if (entry) bytes -= entry.bytes;
        entries.delete(key);
    };
    return {
        get(taskId: string, interactions: string, nodes: string, framework: string): T {
            const time = now();
            for (const [key, entry] of entries) {
                if (time - entry.touchedAt >= idleMs) remove(key);
            }
            const cached = entries.get(taskId);
            if (cached && cached.interactions === interactions && cached.nodes === nodes && cached.framework === framework) {
                cached.touchedAt = time;
                entries.delete(taskId);
                entries.set(taskId, cached);
                return cached.value;
            }
            const value = build(interactions, nodes, framework);
            remove(taskId);
            // Estimate both retained source text and parsed strings; this is a retention budget, not a heap limit.
            const estimatedBytes = (interactions.length + nodes.length) * 4;
            if (estimatedBytes > maxBytes || maxEntries < 1) return value;
            entries.set(taskId, { interactions, nodes, framework, value, bytes: estimatedBytes, touchedAt: time });
            bytes += estimatedBytes;
            while (bytes > maxBytes || entries.size > maxEntries) {
                const oldest = entries.keys().next();
                if (oldest.done) break;
                remove(oldest.value);
            }
            return value;
        },
    };
}

export function memoizeSessionReads<T>(read: (taskId: string) => Promise<T>) {
    const pending = new Map<string, Promise<T>>();
    return (taskId: string): Promise<T> => {
        const existing = pending.get(taskId);
        if (existing) return existing;
        const result = read(taskId);
        pending.set(taskId, result);
        void result.catch(() => { pending.delete(taskId); });
        return result;
    };
}
