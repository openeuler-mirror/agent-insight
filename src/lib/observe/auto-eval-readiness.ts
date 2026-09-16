import { db } from '@/lib/storage/prisma';
import { buildOpencodeTelemetryIndex } from '@/lib/observe/opencode-telemetry-index';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_AUTO_EVAL_TRACE_STABLE_MS = 60_000;

type TimestampCarrier = {
    // hasAssistantOutput() reads role/content to detect a produced answer; the rest
    // are the activity-timestamp fields getLatestTraceActivityMs() scans.
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    createdAt?: unknown;
    completedAt?: unknown;
    completed_at?: unknown;
    timeInfo?: {
        created?: unknown;
        completed?: unknown;
    };
    timing?: {
        started_at?: unknown;
        completed_at?: unknown;
    };
};

type SessionForReadiness = {
    interactions?: unknown;
    endTime?: unknown;
};


const opencodeCliExitCache = new Map<string, { value: boolean | null; expiresAt: number }>();
let opencodeTelemetryIndexCache: {
    expiresAt: number;
    sessions: Map<string, { hasShutdown: boolean; pids: Set<number> }>;
} | null = null;

function toMsTimestamp(value: unknown): number | null {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) {
            const n = Number(trimmed);
            return Number.isFinite(n) ? n : null;
        }
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function getAutoEvalStableMs(): number {
    const configured = Number(process.env.AUTO_EVAL_TRACE_STABLE_MS);
    return Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_AUTO_EVAL_TRACE_STABLE_MS;
}

function parseInteractionList(raw: unknown): TimestampCarrier[] {
    if (Array.isArray(raw)) return raw as TimestampCarrier[];
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function getInteractionActivityMs(interaction: TimestampCarrier): number {
    return Math.max(
        toMsTimestamp(interaction.timeInfo?.completed) || 0,
        toMsTimestamp(interaction.timeInfo?.created) || 0,
        toMsTimestamp(interaction.timing?.completed_at) || 0,
        toMsTimestamp(interaction.timing?.started_at) || 0,
        toMsTimestamp(interaction.completedAt) || 0,
        toMsTimestamp(interaction.completed_at) || 0,
        toMsTimestamp(interaction.timestamp) || 0,
        toMsTimestamp(interaction.createdAt) || 0,
    );
}

function getLatestTraceActivityMs(interactions: TimestampCarrier[], fallbackTimestamp: unknown): number {
    const fromInteractions = interactions.reduce((latest, item) => Math.max(latest, getInteractionActivityMs(item)), 0);
    return Math.max(fromInteractions, toMsTimestamp(fallbackTimestamp) || 0);
}

function isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function getOpencodeSpoolDir(): string {
    return process.env.AGENT_INSIGHT_OPENCODE_SPOOL_DIR
        || path.join(os.homedir(), fs.existsSync(path.join(os.homedir(), '.agent-insight')) ? '.agent-insight' : '.skill-insight', 'otel_data', 'opencode');
}

function getOpencodeTelemetryIndex(): Map<string, { hasShutdown: boolean; pids: Set<number> }> {
    if (opencodeTelemetryIndexCache && opencodeTelemetryIndexCache.expiresAt > Date.now()) {
        return opencodeTelemetryIndexCache.sessions;
    }
    // 防 OOM:有界扫描(只看最近活动文件 + 总量/单文件封顶),不再把整个 spool 读进内存。
    // 详见 src/lib/observe/opencode-telemetry-index.ts 的注释(spool 堆到 GB 级会把堆撑爆)。
    const { sessions, skippedFiles, scannedBytes } = buildOpencodeTelemetryIndex(getOpencodeSpoolDir());
    if (skippedFiles > 0) {
        console.warn(
            `[Data-API] opencode 遥测索引:跳过 ${skippedFiles} 个超龄/超预算/超大文件(已扫 ${Math.round(scannedBytes / 1024 / 1024)}MB,防 OOM)`,
        );
    }
    opencodeTelemetryIndexCache = { expiresAt: Date.now() + 30_000, sessions };
    return sessions;
}

function inferOpencodeCliExitedFromExistingTelemetry(taskId: string): boolean | null {
    const cached = opencodeCliExitCache.get(taskId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const setCache = (value: boolean | null) => {
        opencodeCliExitCache.set(taskId, { value, expiresAt: Date.now() + 10_000 });
        return value;
    };

    if (!taskId) return setCache(null);
    const entry = getOpencodeTelemetryIndex().get(taskId);
    if (!entry) return setCache(null);
    if (entry.hasShutdown) return setCache(true);
    if (entry.pids.size === 0) return setCache(null);
    const hasAliveProcess = Array.from(entry.pids).some(isPidAlive);
    if (hasAliveProcess) return setCache(false);
    return setCache(true);
}

// 旧评测就绪兼容逻辑，不参与 Trace 执行状态判定。执行状态统一使用十分钟采集静默窗口。
export const QUIET_WINDOW_INFERRED_FRAMEWORKS = new Set(['claudecode', 'jiuwenswarm', 'opencode', 'hermes', 'openclaw']);

export function hasAssistantOutput(interactions: TimestampCarrier[]): boolean {
    return interactions.some((interaction) => {
        const role = String(interaction?.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'subagent') return false;
        return Boolean(String(interaction?.content || '').trim());
    });
}

export function inferQuietWindowTraceCompletedAt(args: {
    framework?: unknown;
    explicitCompleted?: boolean;
    latestActivityMs?: number;
    quietLongEnough?: boolean;
}): string | null {
    const framework = String(args.framework ?? '').toLowerCase();
    if (!QUIET_WINDOW_INFERRED_FRAMEWORKS.has(framework)) return null;
    if (args.explicitCompleted) return null;
    const latestActivityMs = args.latestActivityMs || 0;
    if (!args.quietLongEnough || latestActivityMs <= 0) return null;
    return new Date(latestActivityMs).toISOString();
}

export async function getAutoEvalReadiness(record: Record<string, unknown>) {
    const framework = String(record.framework ?? '').toLowerCase();
    const hasFinalResult = Boolean(String(record.final_result ?? record.finalResult ?? '').trim());
    if (!hasFinalResult && !QUIET_WINDOW_INFERRED_FRAMEWORKS.has(framework)) {
        return {
            autoEvalReady: false,
            autoEvalWaitReason: 'missing-final-result',
            traceLastActivityAt: null,
            traceCompletedAt: null,
        };
    }

    const taskId = String(record.task_id || record.taskId || record.upload_id || record.id || '').trim();
    let session: SessionForReadiness | null = null;
    if (taskId) {
        try {
            session = await db.findSessionByTaskId(taskId) as SessionForReadiness | null;
        } catch (error) {
            console.warn(`[Data-API] Failed to load session for auto-eval readiness: ${taskId}`, error);
        }
    }

    const interactions = parseInteractionList(session?.interactions);
    if (!hasFinalResult && !hasAssistantOutput(interactions)) {
        return {
            autoEvalReady: false,
            autoEvalWaitReason: 'missing-final-result',
            traceLastActivityAt: null,
            traceCompletedAt: null,
        };
    }

    const latestActivityMs = getLatestTraceActivityMs(interactions, record.timestamp);
    const completedAtMs = toMsTimestamp(session?.endTime);
    const stableMs = getAutoEvalStableMs();
    const quietLongEnough = latestActivityMs > 0 && Date.now() - latestActivityMs >= stableMs;
    const explicitCompleted = completedAtMs != null && completedAtMs > 0;
    // 已有明确结束时间(endTime)的 session 就别再扫遥测了——它已经判完。这让"服务端自己跑完、已落
    // endTime"的 trace(灰度/评测/已完成的)完全绕开遥测扫描:大多数 trace 走这条,是防 OOM 的关键。
    const opencodeCliExited = (framework === 'opencode' && !explicitCompleted)
        ? inferOpencodeCliExitedFromExistingTelemetry(taskId)
        : null;
    const quietWindowCompleted = QUIET_WINDOW_INFERRED_FRAMEWORKS.has(framework) && quietLongEnough;
    const autoEvalReady = explicitCompleted || opencodeCliExited === true || quietWindowCompleted;

    return {
        autoEvalReady,
        autoEvalWaitReason: autoEvalReady
            ? null
            : latestActivityMs > 0
                ? 'trace-still-active'
                : 'missing-trace-activity',
        traceLastActivityAt: latestActivityMs > 0 ? new Date(latestActivityMs).toISOString() : null,
        traceCompletedAt: completedAtMs != null && completedAtMs > 0
            ? new Date(completedAtMs).toISOString()
            : opencodeCliExited === true
                ? new Date().toISOString()
                : inferQuietWindowTraceCompletedAt({
                    framework,
                    explicitCompleted,
                    latestActivityMs,
                    quietLongEnough,
                }),
    };
}

