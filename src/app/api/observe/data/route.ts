import { listObservedAgentNames, listObservedFieldValues, listObservedSkills, listObservedTraceIds, readRecordPage, readRecords, saveExecutionRecord } from '@/lib/storage/data-service';
import type { FilterClause } from '@/lib/filters/types';
import { db, prismaRaw as prisma } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { isActive } from '@/lib/evaluation-task-manager';
import { triggerTrajectoryAutoWatchForTask } from '@/lib/engine/evaluation/trajectory-auto-watch';
import { buildOpencodeTelemetryIndex } from '@/lib/observe/opencode-telemetry-index';
import { listTraceTags } from '@/lib/trace-tags';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';

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

type TraceLifecycleStatus = 'running' | 'success' | 'failed';

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

function toIsoTimestamp(value: unknown): string | null {
    const ms = toMsTimestamp(value);
    return ms != null && ms > 0 ? new Date(ms).toISOString() : null;
}

function getTraceLifecycle(completedAt: unknown): {
    traceStatus: TraceLifecycleStatus;
    traceCompletedAt: string | null;
    traceStatusReason: string;
} {
    const completedIso = toIsoTimestamp(completedAt);
    if (completedIso) {
        return {
            traceStatus: 'success',
            traceCompletedAt: completedIso,
            traceStatusReason: 'session-ended',
        };
    }

    return {
        traceStatus: 'running',
        traceCompletedAt: null,
        traceStatusReason: 'missing-completion-signal',
    };
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

// 缺少可靠结束信号时的读侧兜底:轨迹已产出 assistant 输出后,静默超过稳定窗口即视为结束。
// Claude Code / jiuwenswarm single-agent 没有 root span;Hermes/OpenCode 有显式完成信号,
// 但旧接入或异常退出可能漏写 Session.endTime,需要 quiet-window 防止已完成 trace 长期停在"执行中"。
export const QUIET_WINDOW_INFERRED_FRAMEWORKS = new Set(['claudecode', 'jiuwenswarm', 'opencode', 'hermes']);

export function hasAssistantOutput(interactions: TimestampCarrier[]): boolean {
    return interactions.some((interaction: any) => {
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

async function getAutoEvalReadiness(record: Record<string, unknown>, baseUrl?: string | null) {
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
    if (framework === 'opencode' && !explicitCompleted && opencodeCliExited === true && taskId) {
        try {
            await db.updateSession(taskId, { endTime: new Date() });
            void triggerTrajectoryAutoWatchForTask(String(record.user || ''), taskId, baseUrl);
        } catch (error) {
            console.warn(`[Data-API] Failed to persist inferred opencode completion for ${taskId}`, error);
        }
    }
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
    const agentName = searchParams.get('agentName') || undefined;
    const summary = searchParams.get('summary') || undefined;
    const paginated = searchParams.get('paginated') === '1' || searchParams.get('paginated') === 'true';
    // 轻量返回:只给 denormalized 元数据,不读 finalResult/不解析 session,根治非分页路径堆 OOM。
    const lightweight = searchParams.get('fields') === 'light' || searchParams.get('lightweight') === '1';
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = Math.min(parsePositiveInt(searchParams.get('pageSize'), 20), 100);
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
    const includeTags = searchParams.get('includeTags') === '1' || searchParams.get('includeTags') === 'true';
    const bizTagParam = searchParams.get('bizTag') || '';
    const businessTagIds = bizTagParam
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 50);

    // facet=skills：返回该 user 可见的全部 skill(name + 版本)给前端下拉用。来自 ExecutionSkill(agent 作用域,
    // 含 sub-agent 用到的 skill),与"按 skill 服务端筛选"同源,避免下拉项随筛选结果塌缩。
    const facet = searchParams.get('facet') || undefined;
    if (facet === 'skills') {
        return NextResponse.json(await listObservedSkills(user));
    }
    // facet=tags&kind=business|version：返回用户标签 + 使用次数，给业务标签筛选/打标控件使用。
    if (facet === 'tags') {
        return NextResponse.json(await listTraceTags(user || '', searchParams.get('kind')));
    }
    // facet=values&column=<col>：某分类列的观测值 + 件数,给过滤器值下拉(对标 langfuse SUGGESTIONS)。
    if (facet === 'values') {
        const column = searchParams.get('column') || '';
        return NextResponse.json(await listObservedFieldValues(column, user));
    }

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
            // 单条查询带上 final_result:供 fault 详情在列表走 fields=light(不带 final_result)后按需回填。
            // 单条记录,无 OOM 风险。
            final_result: single.finalResult ?? null,
            is_subagent: single.isSubagent ?? false,
            parent_execution_id: single.parentExecutionId ?? null,
            root_execution_id: single.rootExecutionId ?? null,
            agent_session_id: single.agentSessionId ?? null,
            subagent_type: single.subagentType ?? null,
            subagent_name: single.subagentName ?? null,
        }]);
    }

    if (summary === 'agents') {
        const agents = await listObservedAgentNames(user);
        return NextResponse.json({ agents });
    }
    if (summary === 'traceIds') {
        const traceIds = await listObservedTraceIds(user, agentName);
        return NextResponse.json({ traceIds });
    }

    // filters=<JSON FilterClause[]>：统一过滤器模型(operator 模型)的子句,下推到 Prisma where。
    const filtersParam = searchParams.get('filters');
    let clauses: FilterClause[] | undefined;
    if (filtersParam) {
        try {
            const parsed = JSON.parse(filtersParam);
            if (Array.isArray(parsed)) clauses = parsed as FilterClause[];
        } catch {
            // 容忍 malformed:忽略,不影响其它过滤
        }
    }

    const recordFilters = {
        query,
        taskId,
        taskIds: taskIds.length > 0 ? taskIds : undefined,
        agentName,
        framework,
        skill,
        skillVersion,
        includeSubagents,
        onlySubagents,
        parentExecutionId,
        clauses,
        businessTagIds: businessTagIds.length > 0 ? businessTagIds : undefined,
    };
    const pageResult = paginated
        ? await readRecordPage(user, recordFilters, { attachEvaluations, page, pageSize, lightweight, includeTags })
        : null;
    const data = pageResult
        ? pageResult.records
        : await readRecords(user, recordFilters, { attachEvaluations, lightweight, includeTags });
    
    // 批量查每条 trace 的最近一次 TrajectoryEvalResult.status, 让前端 trace 行能反映"上次评测
    // 跑成功 / 失败"。之前 trace 行 status 只看 resultScore/trajScore + 前端内存 failedTaskIds
    // (刷新就丢),导致评测失败 + 老分数还在的 trace 会被错误显示成"已评测"。
    // findMany 按 createdAt desc 排序,第一条命中就是该 taskId 的最新一次评测。
    const recordTaskIdsForEvalLookup = Array.from(new Set(
        data.map(r => r.task_id || r.upload_id || '').filter(Boolean)
    ));
    const sessionEndByTaskId = new Map<string, Date | null>();
    if (recordTaskIdsForEvalLookup.length > 0) {
        try {
            const sessionRows = await prisma.session.findMany({
                where: { taskId: { in: recordTaskIdsForEvalLookup } },
                select: { taskId: true, endTime: true },
            });
            for (const row of sessionRows) {
                sessionEndByTaskId.set(row.taskId, row.endTime);
            }
        } catch (e) {
            console.warn('[Data-API] failed to fetch session lifecycle status:', (e as Error)?.message);
        }
    }
    const lastEvalByTaskId = new Map<string, { status: string; errorMessage: string | null; trajectoryScore: number | null }>();
    if (user && recordTaskIdsForEvalLookup.length > 0) {
        try {
            const recentEvalRows = await prisma.trajectoryEvalResult.findMany({
                where: { user, taskId: { in: recordTaskIdsForEvalLookup } },
                orderBy: { createdAt: 'desc' },
                // 方案A: 带上 trajectoryScore（已是代码侧聚合层算出的统一轨迹分），让 trace 行/列表/概览
                // 直接显示统一口径，而不是只读 matchJson.overallScore(对齐覆盖率 = completeness 单维)。
                select: { taskId: true, status: true, errorMessage: true, trajectoryScore: true },
            });
            for (const row of recentEvalRows) {
                if (row.taskId && !lastEvalByTaskId.has(row.taskId)) {
                    lastEvalByTaskId.set(row.taskId, {
                        status: row.status,
                        errorMessage: row.errorMessage,
                        trajectoryScore: typeof row.trajectoryScore === 'number' ? row.trajectoryScore : null,
                    });
                }
            }
        } catch (e) {
            console.warn('[Data-API] failed to fetch last eval status:', (e as Error)?.message);
        }
    }

    const enrichedData = await Promise.all(data.map(async record => {
        const recordTaskId = record.task_id || record.upload_id || '';
        const is_evaluating = user && recordTaskId ? isActive(user, recordTaskId) : false;
        const lastEval = recordTaskId ? lastEvalByTaskId.get(recordTaskId) : null;
        const last_eval_status = lastEval?.status ?? null;
        const last_eval_error = lastEval?.errorMessage ?? null;
        const baseTraceLifecycle = getTraceLifecycle(recordTaskId ? sessionEndByTaskId.get(recordTaskId) : null);
        // 方案A: 统一轨迹分（聚合层产出）。前端 getTraceFlowScore/ScoredTrace 优先读它，
        // 没有(未评测/纯对齐)再回退 matchJson.overallScore。
        const trajectory_score = lastEval?.trajectoryScore ?? null;
        if (skipAutoEvalReady) {
            const traceLifecycle = baseTraceLifecycle.traceStatus === 'success'
                ? baseTraceLifecycle
                : QUIET_WINDOW_INFERRED_FRAMEWORKS.has(String(record.framework ?? '').toLowerCase())
                    ? getTraceLifecycle((await getAutoEvalReadiness(record, new URL(request.url).origin)).traceCompletedAt)
                    : baseTraceLifecycle;
            return {
                ...record,
                is_evaluating,
                last_eval_status,
                last_eval_error,
                trajectory_score,
                trajectoryScore: trajectory_score,
                trace_status: traceLifecycle.traceStatus,
                traceStatus: traceLifecycle.traceStatus,
                trace_completed_at: traceLifecycle.traceCompletedAt,
                traceCompletedAt: traceLifecycle.traceCompletedAt,
                trace_status_reason: traceLifecycle.traceStatusReason,
                traceStatusReason: traceLifecycle.traceStatusReason,
            };
        }
        const readiness = await getAutoEvalReadiness(record, new URL(request.url).origin);
        const traceLifecycle = baseTraceLifecycle.traceStatus === 'success'
            ? baseTraceLifecycle
            : getTraceLifecycle(readiness.traceCompletedAt);
        return {
            ...record,
            is_evaluating,
            last_eval_status,
            last_eval_error,
            trajectory_score,
            trajectoryScore: trajectory_score,
            trace_status: traceLifecycle.traceStatus,
            traceStatus: traceLifecycle.traceStatus,
            trace_completed_at: traceLifecycle.traceCompletedAt,
            traceCompletedAt: traceLifecycle.traceCompletedAt,
            trace_status_reason: traceLifecycle.traceStatusReason,
            traceStatusReason: traceLifecycle.traceStatusReason,
            auto_eval_ready: readiness.autoEvalReady,
            autoEvalReady: readiness.autoEvalReady,
            auto_eval_wait_reason: readiness.autoEvalWaitReason,
            trace_last_activity_at: readiness.traceLastActivityAt,
        };
    }));
    
    if (enrichedData.length > 0) {
        console.log(`[Data-API] 📤 Sending ${enrichedData.length} records. Top record skills: ${JSON.stringify(enrichedData[0].skills)}, is_evaluating: ${enrichedData[0].is_evaluating}`);
    }
    if (pageResult) {
        return NextResponse.json({
            records: enrichedData,
            total: pageResult.total,
            page,
            pageSize,
        });
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
