import { readRecords, saveExecutionRecord } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { isActive } from '@/lib/evaluation-task-manager';
import { triggerTrajectoryAutoWatchForTask } from '@/lib/engine/evaluation/trajectory-auto-watch';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';

const DEFAULT_AUTO_EVAL_TRACE_STABLE_MS = 60_000;

type TimestampCarrier = {
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
    return process.env.SKILL_INSIGHT_OPENCODE_SPOOL_DIR
        || path.join(os.homedir(), '.skill-insight', 'otel_data', 'opencode');
}

function getOpencodeTelemetryIndex(): Map<string, { hasShutdown: boolean; pids: Set<number> }> {
    if (opencodeTelemetryIndexCache && opencodeTelemetryIndexCache.expiresAt > Date.now()) {
        return opencodeTelemetryIndexCache.sessions;
    }

    const sessions = new Map<string, { hasShutdown: boolean; pids: Set<number> }>();
    const upsert = (sessionId: string, patch: { hasShutdown?: boolean; pid?: number }) => {
        if (!sessionId) return;
        const current = sessions.get(sessionId) || { hasShutdown: false, pids: new Set<number>() };
        if (patch.hasShutdown) current.hasShutdown = true;
        if (patch.pid && Number.isFinite(patch.pid) && patch.pid > 0) current.pids.add(patch.pid);
        sessions.set(sessionId, current);
    };

    const spoolDir = getOpencodeSpoolDir();
    if (!fs.existsSync(spoolDir)) {
        opencodeTelemetryIndexCache = { expiresAt: Date.now() + 30_000, sessions };
        return sessions;
    }

    try {
        const dayDirs = fs.readdirSync(spoolDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(spoolDir, entry.name))
            .sort()
            .reverse()
            .slice(0, 7);

        for (const dayDir of dayDirs) {
            const files = fs.readdirSync(dayDir)
                .filter(name => name.endsWith('.jsonl'))
                .map(name => path.join(dayDir, name));

            for (const file of files) {
                let text = '';
                try {
                    text = fs.readFileSync(file, 'utf8');
                } catch {
                    continue;
                }

                let pluginPid: number | null = null;
                for (const line of text.split('\n')) {
                    if (!line.trim()) continue;

                    if (line.includes('"kind":"plugin.start"')) {
                        const pidMatch = line.match(/"pid":\s*(\d+)/);
                        const pid = pidMatch ? Number(pidMatch[1]) : 0;
                        if (Number.isFinite(pid) && pid > 0) pluginPid = pid;
                        continue;
                    }

                    if (!line.includes('"sessionID"')) continue;
                    const hasShutdown = line.includes('"kind":"plugin.shutdown"');
                    for (const match of line.matchAll(/"sessionID":"([^"]+)"/g)) {
                        const sessionId = match[1];
                        if (!sessionId) continue;
                        upsert(sessionId, {
                            hasShutdown,
                            pid: pluginPid || undefined,
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.warn('[Data-API] Failed to build opencode telemetry index', error);
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

async function getAutoEvalReadiness(record: Record<string, unknown>, baseUrl?: string | null) {
    const hasFinalResult = Boolean(String(record.final_result ?? record.finalResult ?? '').trim());
    if (!hasFinalResult) {
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
    const latestActivityMs = getLatestTraceActivityMs(interactions, record.timestamp);
    const completedAtMs = toMsTimestamp(session?.endTime);
    const stableMs = getAutoEvalStableMs();
    const framework = String(record.framework ?? '').toLowerCase();
    const quietLongEnough = latestActivityMs > 0 && Date.now() - latestActivityMs >= stableMs;
    const explicitCompleted = completedAtMs != null && completedAtMs > 0;
    const opencodeCliExited = framework === 'opencode'
        ? inferOpencodeCliExitedFromExistingTelemetry(taskId)
        : null;
    if (framework === 'opencode' && !explicitCompleted && opencodeCliExited === true && taskId) {
        try {
            await db.updateSession(taskId, { endTime: new Date() });
            void triggerTrajectoryAutoWatchForTask(String(record.user || ''), taskId, baseUrl);
        } catch (error) {
            console.warn(`[Data-API] Failed to persist inferred opencode completion for ${taskId}`, error);
        }
    }
    const autoEvalReady = framework === 'opencode'
        ? explicitCompleted || opencodeCliExited === true
        : explicitCompleted || quietLongEnough;

    return {
        autoEvalReady,
        autoEvalWaitReason: autoEvalReady
            ? null
            : framework === 'opencode'
                ? 'opencode-cli-not-exited'
                : latestActivityMs > 0
                ? 'trace-still-active'
                : 'missing-trace-activity',
        traceLastActivityAt: latestActivityMs > 0 ? new Date(latestActivityMs).toISOString() : null,
        traceCompletedAt: completedAtMs != null && completedAtMs > 0
            ? new Date(completedAtMs).toISOString()
            : opencodeCliExited === true
                ? new Date().toISOString()
                : null,
    };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user') || undefined;
    const query = searchParams.get('query') || undefined;
    const taskId = searchParams.get('taskId') || undefined;
    const executionId = searchParams.get('executionId') || undefined;
    const parentExecutionId = searchParams.get('parentExecutionId') || undefined;
    const taskIdsParam = searchParams.get('taskIds') || '';
    const taskIds = taskIdsParam
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 200);
    const framework = searchParams.get('framework') || undefined;
    const skill = searchParams.get('skill') || undefined;
    const includeEvaluationsParam = searchParams.get('includeEvaluations');
    const skipAutoEvalReady = searchParams.get('skipAutoEvalReady') === '1'
        || searchParams.get('skipAutoEvalReady') === 'true';
    const includeSubagents = searchParams.get('includeSubagents') === '1'
        || searchParams.get('includeSubagents') === 'true';
    const onlySubagents = searchParams.get('onlySubagents') === '1'
        || searchParams.get('onlySubagents') === 'true';
    const skillVersionStr = searchParams.get('skillVersion');
    const skillVersion = skillVersionStr ? parseInt(skillVersionStr, 10) : undefined;
    const attachEvaluations = includeEvaluationsParam === '1' || includeEvaluationsParam === 'true';

    // 直查单条 Execution（用于"返回父执行 / 派生子 Agent 跳转"等仅需 task_id + 元数据的场景）。
    // 跳过 readRecords 的 ownership / pricing / session merge / evaluation snapshots enrichment——
    // 那一坨为列表服务，单条查询走它会非常慢。这里直接返回轻量字段，调用方仅用于路由跳转和标签展示。
    if (executionId) {
        const single = await db.findExecutionById(executionId);
        if (!single) return NextResponse.json([]);
        return NextResponse.json([{
            upload_id: single.id,
            task_id: single.taskId,
            framework: single.framework,
            agentName: single.agentName,
            timestamp: single.timestamp,
            is_subagent: single.isSubagent ?? false,
            parent_execution_id: single.parentExecutionId ?? null,
            root_execution_id: single.rootExecutionId ?? null,
            agent_session_id: single.agentSessionId ?? null,
            subagent_type: single.subagentType ?? null,
            subagent_name: single.subagentName ?? null,
        }]);
    }

    const data = await readRecords(
      user,
      {
        query,
        taskId,
        taskIds: taskIds.length > 0 ? taskIds : undefined,
        framework,
        skill,
        skillVersion,
        includeSubagents,
        onlySubagents,
        parentExecutionId,
      },
      { attachEvaluations }
    );
    
    const enrichedData = await Promise.all(data.map(async record => {
        const recordTaskId = record.task_id || record.upload_id || '';
        const is_evaluating = user && recordTaskId ? isActive(user, recordTaskId) : false;
        if (skipAutoEvalReady) {
            return {
                ...record,
                is_evaluating,
            };
        }
        const readiness = await getAutoEvalReadiness(record, new URL(request.url).origin);
        return {
            ...record,
            is_evaluating,
            auto_eval_ready: readiness.autoEvalReady,
            autoEvalReady: readiness.autoEvalReady,
            auto_eval_wait_reason: readiness.autoEvalWaitReason,
            trace_last_activity_at: readiness.traceLastActivityAt,
            trace_completed_at: readiness.traceCompletedAt,
        };
    }));
    
    if (enrichedData.length > 0) {
        console.log(`[Data-API] 📤 Sending ${enrichedData.length} records. Top record skills: ${JSON.stringify(enrichedData[0].skills)}, is_evaluating: ${enrichedData[0].is_evaluating}`);
    }
    return NextResponse.json(enrichedData);
  } catch (error) {
    console.error('Read Data Error:', error);
    return NextResponse.json({ error: 'Failed to read data' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
    try {
        const target = await request.json();
        
        console.log('[Data-API] 🗑️  Delete request:', {
            upload_id: target.upload_id,
            task_id: target.task_id,
            timestamp: target.timestamp,
            framework: target.framework,
            query: target.query?.substring(0, 50)
        });
        
        let deleteCount = 0;

        if (target.upload_id) {
            console.warn(`[Data-API] delete requested: upload_id=${target.upload_id}`);
            const success = await db.deleteExecution(target.upload_id);
            deleteCount = success ? 1 : 0;
            console.log(`[Data-API] 🗑️  Deleted by upload_id: ${target.upload_id}, success: ${success}`);
        } else if (target.task_id) {
             console.warn(`[Data-API] delete requested: task_id=${target.task_id}`);
             deleteCount = await db.deleteExecutions({ taskId: target.task_id });
             console.log(`[Data-API] 🗑️  Deleted by task_id: ${target.task_id}, count: ${deleteCount}`);
        } else {
             if (target.timestamp && target.framework && target.query) {
                 console.warn(`[Data-API] delete requested: timestamp=${target.timestamp} framework=${target.framework} query_len=${String(target.query).length}`);
                 deleteCount = await db.deleteExecutions({
                     timestamp: new Date(target.timestamp),
                     framework: target.framework,
                     query: target.query
                 });
                 console.log(`[Data-API] 🗑️  Deleted by composite key, count: ${deleteCount}`);
             } else {
                 console.log('[Data-API] ⚠️  No valid delete criteria provided');
             }
        }
        
        console.log(`[Data-API] ✅ Delete completed, total deleted: ${deleteCount}`);
        return NextResponse.json({ success: true, count: deleteCount });

    } catch (error) {
        console.error('[Data-API] ❌ Delete Error:', error);
        return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { task_id, upload_id, query: newQuery, user_feedback, label: newLabel, final_result: newFinalResult } = body;

        if (!task_id && !upload_id) {
            return NextResponse.json({ error: 'task_id or upload_id is required' }, { status: 400 });
        }

        if (user_feedback !== undefined) {
            const result = await saveExecutionRecord({
                task_id: task_id || undefined,
                upload_id: upload_id || undefined,
                user_feedback,
                force_judgment: false
            });
             return NextResponse.json({
                success: result.success,
                record: result.record,
                message: '用户反馈已更新'
            });
        }

        if (newLabel !== undefined) {
            const result = await saveExecutionRecord({
                task_id: task_id || undefined,
                upload_id: upload_id || undefined,
                label: newLabel,
                force_judgment: false
            });
             return NextResponse.json({
                success: result.success,
                record: result.record,
                message: 'Label 已更新'
            });
        }

        if (typeof newQuery === 'string') {
            if (!newQuery.trim()) {
                return NextResponse.json({ error: 'query must be a non-empty string' }, { status: 400 });
            }
            
            const result = await saveExecutionRecord({
                task_id: task_id || undefined,
                upload_id: upload_id || undefined,
                query: newQuery.trim(),
                skip_evaluation: true,
                force_query_update: true
            });

            return NextResponse.json({
                success: result.success,
                record: result.record,
                message: 'Query 已更新'
            });
        }

        if (typeof newFinalResult === 'string') {
            const id = upload_id || task_id;
            if (!id) {
                return NextResponse.json({ error: 'upload_id or task_id is required' }, { status: 400 });
            }

            try {
                await db.upsertExecution({
                    where: { id },
                    create: {
                        id,
                        taskId: task_id,
                        finalResult: newFinalResult.trim(),
                        judgmentReason: '结果评估中...',
                    },
                    update: {
                        finalResult: newFinalResult.trim(),
                        judgmentReason: '结果评估中...',
                    }
                });

                saveExecutionRecord({
                    task_id: task_id || undefined,
                    upload_id: upload_id || undefined,
                    final_result: newFinalResult.trim(),
                    force_judgment: true
                }).catch(err => {
                    console.error('[Background Re-judgment Error]', err);
                });

                return NextResponse.json({
                    success: true,
                    message: 'Final Result 已保存，正在后台重新评估'
                });
            } catch (error) {
                console.error('Update Final Result Error:', error);
                return NextResponse.json({ error: 'Failed to update final result' }, { status: 500 });
            }
        }

        return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });

    } catch (error) {
        console.error('Patch/Update Data Error:', error);
        return NextResponse.json({ error: 'Failed to update data' }, { status: 500 });
    }
}
