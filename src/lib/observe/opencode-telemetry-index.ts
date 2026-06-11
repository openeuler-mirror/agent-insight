/**
 * 构建 opencode 遥测索引:sessionId → { 是否 shutdown, pids },用于"自动评测就绪"判断
 * (推断某条 opencode trace 的 CLI 是否已退出 → 执行结束 → 可评测)。
 *
 * 为什么要严格限内存:opencode 遥测 spool 是"插件写、上传器读上传"的缓冲区,长期不清会堆到
 * GB 级(实测 3.1GB,单日 2.1GB)。旧实现把"近 7 天所有 jsonl 全 readFileSync 进内存 + split",
 * 在 spool 大 + 前端高频轮询时把 Node 堆撑爆(实测 6GB FATAL heap OOM,服务崩溃)。
 *
 * 这里把扫描做成"有界"的:
 *   1) 只看"最近活动"的文件(按 mtime,默认 12h)—— 就绪判断只关心刚跑完/在跑的 session,
 *      它们的遥测一定在最近文件里;早就结束的 session 有 endTime,调用方走 explicitCompleted 分支,
 *      根本不会触发本扫描。
 *   2) 总读取量封顶(默认 256MB)+ 单文件封顶(默认 64MB,异常大文件直接跳过),保证内存有界。
 *   3) 新文件优先扫,预算用尽即停。
 *
 * 逻辑是纯函数(只依赖传入的 spoolDir + 注入的 now),便于单测。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface OpencodeSessionTelemetry {
    hasShutdown: boolean;
    pids: Set<number>;
}

export interface BuildTelemetryIndexOptions {
    /** 只扫 mtime 在最近这么多毫秒内的文件(默认 12h)。 */
    maxAgeMs?: number;
    /** 总读取字节上限(默认 256MB)。 */
    maxTotalBytes?: number;
    /** 单文件字节上限(默认 64MB),超过直接跳过。 */
    maxFileBytes?: number;
    /** 最多看几个 day 目录(默认 3,配合 mtime 过滤)。 */
    maxDayDirs?: number;
    /** 注入 now(测试用)。 */
    nowMs?: number;
}

export interface TelemetryIndexResult {
    sessions: Map<string, OpencodeSessionTelemetry>;
    /** 因超龄/超预算/超大被跳过的文件数(可观测性)。 */
    skippedFiles: number;
    scannedFiles: number;
    scannedBytes: number;
}

export const TELEMETRY_INDEX_DEFAULTS = {
    maxAgeMs: 12 * 3600 * 1000,
    maxTotalBytes: 256 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    maxDayDirs: 3,
};

export function buildOpencodeTelemetryIndex(
    spoolDir: string,
    options: BuildTelemetryIndexOptions = {},
): TelemetryIndexResult {
    const maxAgeMs = options.maxAgeMs ?? TELEMETRY_INDEX_DEFAULTS.maxAgeMs;
    const maxTotalBytes = options.maxTotalBytes ?? TELEMETRY_INDEX_DEFAULTS.maxTotalBytes;
    const maxFileBytes = options.maxFileBytes ?? TELEMETRY_INDEX_DEFAULTS.maxFileBytes;
    const maxDayDirs = options.maxDayDirs ?? TELEMETRY_INDEX_DEFAULTS.maxDayDirs;
    const now = options.nowMs ?? Date.now();

    const sessions = new Map<string, OpencodeSessionTelemetry>();
    let skippedFiles = 0;
    let scannedFiles = 0;
    let scannedBytes = 0;

    const upsert = (sessionId: string, patch: { hasShutdown?: boolean; pid?: number }) => {
        if (!sessionId) return;
        const cur = sessions.get(sessionId) || { hasShutdown: false, pids: new Set<number>() };
        if (patch.hasShutdown) cur.hasShutdown = true;
        if (patch.pid && Number.isFinite(patch.pid) && patch.pid > 0) cur.pids.add(patch.pid);
        sessions.set(sessionId, cur);
    };

    if (!fs.existsSync(spoolDir)) return { sessions, skippedFiles, scannedFiles, scannedBytes };

    const cutoffMs = now - maxAgeMs;
    let budget = maxTotalBytes;

    let dayDirs: string[] = [];
    try {
        dayDirs = fs.readdirSync(spoolDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => path.join(spoolDir, e.name))
            .sort()
            .reverse()
            .slice(0, maxDayDirs);
    } catch {
        return { sessions, skippedFiles, scannedFiles, scannedBytes };
    }

    // 先收集候选文件(最近活动的),按 mtime 倒序——就绪判断关心的是最近跑完/在跑的 session。
    const candidates: Array<{ file: string; mtimeMs: number; size: number }> = [];
    for (const dayDir of dayDirs) {
        let names: string[];
        try {
            names = fs.readdirSync(dayDir).filter(name => name.endsWith('.jsonl'));
        } catch {
            continue;
        }
        for (const name of names) {
            const file = path.join(dayDir, name);
            let st: fs.Stats;
            try {
                st = fs.statSync(file);
            } catch {
                continue;
            }
            if (st.mtimeMs < cutoffMs) {
                skippedFiles++; // 太老:对应早结束的 session(有 endTime,调用方不会扫到这)
                continue;
            }
            candidates.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const c of candidates) {
        if (c.size > maxFileBytes || c.size > budget) {
            skippedFiles++;
            continue;
        }
        budget -= c.size;
        let text = '';
        try {
            text = fs.readFileSync(c.file, 'utf8');
        } catch {
            skippedFiles++;
            continue;
        }
        scannedFiles++;
        scannedBytes += c.size;

        let pluginPid: number | null = null;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (line.includes('"kind":"plugin.start"')) {
                const m = line.match(/"pid":\s*(\d+)/);
                const pid = m ? Number(m[1]) : 0;
                if (Number.isFinite(pid) && pid > 0) pluginPid = pid;
                continue;
            }
            if (!line.includes('"sessionID"')) continue;
            const hasShutdown = line.includes('"kind":"plugin.shutdown"');
            for (const match of line.matchAll(/"sessionID":"([^"]+)"/g)) {
                upsert(match[1], { hasShutdown, pid: pluginPid || undefined });
            }
        }
    }

    return { sessions, skippedFiles, scannedFiles, scannedBytes };
}
