import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { handleCompatibleObserveData } from '@/lib/storage-core/compat';
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getTraceLifecycle } from '@/lib/observe/trace-lifecycle';
import { collaborationTraceProjection } from '@/lib/collaboration/runtime';
import { listObservedAgentNames, listObservedFieldValues, listObservedSkills, listObservedTraceIds, readRecordPage, readRecords, saveExecutionRecord } from '@/lib/storage/data-service';
import type { FilterClause } from '@/lib/filters/types';
import { db, prismaRaw as prisma } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { resolveTraceReadScope } from '@/lib/auth/admin';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';
import { isActive } from '@/lib/evaluation-task-manager';
import { buildOpencodeTelemetryIndex } from '@/lib/observe/opencode-telemetry-index';
import { listTraceTags } from '@/lib/trace-tags';
import { parseObserveTraceTagFilters } from '@/lib/trace-tag-filters';
import { deriveAnomalyStatus, normalizeAnomalyFilter } from '@/lib/reliability/anomaly-status';
import path from 'path';
import { getAgentInsightHome } from '@/lib/env';
import {
    hasAssistantOutput,
    inferQuietWindowTraceCompletedAt,
    QUIET_WINDOW_INFERRED_FRAMEWORKS,
    type TimestampCarrier,
} from '@/lib/trace/lifecycle';

export const dynamic = 'force-dynamic';

const DEFAULT_AUTO_EVAL_TRACE_STABLE_MS = 60_000;

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

function parsePositiveInt(value: string | null, fallback: number): number {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
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
        || path.join(getAgentInsightHome(), 'otel_data', 'opencode');
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

// 旧静默窗口仅决定评测就绪，不参与 Trace 执行状态或写入结束时间。
async function getAutoEvalReadiness(record: Record<string, unknown>) {
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

export async function GET(request: Request) {
  return handleCompatibleObserveData(request);
}

export async function DELETE(request: Request) {
  return handleCompatibleObserveData(request);
}

export async function PATCH(request: Request) {
  return handleCompatibleObserveData(request);
}
