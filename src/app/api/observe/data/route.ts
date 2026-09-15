import { getAutoEvalReadiness } from '@/lib/observe/auto-eval-readiness';
import { getTraceLifecycle } from '@/lib/observe/trace-lifecycle';
import { listObservedAgentNames, listObservedFieldValues, listObservedSkills, listObservedTraceIds, readRecordPage, readRecords, saveExecutionRecord } from '@/lib/storage/data-service';
import type { FilterClause } from '@/lib/filters/types';
import { db, prismaRaw as prisma } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { isActive } from '@/lib/evaluation-task-manager';
import { listTraceTags } from '@/lib/trace-tags';

export const dynamic = 'force-dynamic';

function parsePositiveInt(value: string | null, fallback: number): number {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
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
    const ownershipParam = searchParams.get('ownership') || '';
    const ownership: 'user' | 'system' | undefined = ownershipParam === 'user' || ownershipParam === 'system'
        ? ownershipParam
        : undefined;
    const statusParam = searchParams.get('status') || 'all';
    const sortParam = searchParams.get('sort') || 'timestamp';
    const sortDirParam = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
    const sortKey = sortParam === 'agent'
        ? 'agentName'
        : (sortParam === 'latency' || sortParam === 'tokens' || sortParam === 'cost')
            ? sortParam
            : 'timestamp';
    const timeParam = searchParams.get('time') || 'all';
    const timeWindowMs: Record<string, number> = {
        '30m': 30 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '3h': 3 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const timestampFrom = timeWindowMs[timeParam]
        ? new Date(Date.now() - timeWindowMs[timeParam])
        : undefined;
    const summary = searchParams.get('summary') || undefined;
    const paginated = searchParams.get('paginated') === '1' || searchParams.get('paginated') === 'true';
    const databasePagination = searchParams.get('databasePagination') === '1'
        || searchParams.get('databasePagination') === 'true';
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
        const agents = await listObservedAgentNames(user, databasePagination);
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
        timestampFrom,
        ownership,
        observedAgentFallback: databasePagination,
    };
    // status 是读时生命周期字段，cost 是按模型价格计算的展示字段，二者无法保证与 Execution
    // 原始列直接等价；只有用户主动使用这些过滤/排序时保留兼容全量路径。默认列表及其它过滤
    // 走真正数据库分页。
    const requiresComputedPass = paginated && databasePagination && (
        statusParam !== 'all'
        || sortParam === 'status'
        || sortParam === 'cost'
    );
    const pageResult = paginated && !requiresComputedPass
        ? await readRecordPage(user, recordFilters, {
            attachEvaluations,
            page,
            pageSize,
            lightweight,
            includeTags,
            sortKey,
            sortDir: sortDirParam,
            databasePagination,
        })
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
    const lastEvalByTaskId = new Map<string, { status: string; errorMessage: string | null; trajectoryScore: number | null; at: number }>();
    if (user && recordTaskIdsForEvalLookup.length > 0) {
        try {
            const recentEvalRows = await prisma.trajectoryEvalResult.findMany({
                where: { user, taskId: { in: recordTaskIdsForEvalLookup } },
                orderBy: { createdAt: 'desc' },
                // 方案A: 带上 trajectoryScore（已是代码侧聚合层算出的统一轨迹分），让 trace 行/列表/概览
                // 直接显示统一口径，而不是只读 matchJson.overallScore(对齐覆盖率 = completeness 单维)。
                select: { taskId: true, status: true, errorMessage: true, trajectoryScore: true, createdAt: true },
            });
            for (const row of recentEvalRows) {
                if (row.taskId && !lastEvalByTaskId.has(row.taskId)) {
                    lastEvalByTaskId.set(row.taskId, {
                        status: row.status,
                        errorMessage: row.errorMessage,
                        trajectoryScore: typeof row.trajectoryScore === 'number' ? row.trajectoryScore : null,
                        at: row.createdAt instanceof Date ? row.createdAt.getTime() : 0,
                    });
                }
            }
            // 评测走实验后，评测结果落 ExperimentEvalResult：也按 taskId 取每个 case 最近一次，
            // 与上面的 TrajectoryEvalResult 取「更新的」那条（无感兼容历史 + 新数据）。
            const expCases = await prisma.experimentCase.findMany({
                where: { taskId: { in: recordTaskIdsForEvalLookup }, experiment: { user } },
                orderBy: { createdAt: 'desc' },
                select: { taskId: true, createdAt: true, results: { select: { evaluatorId: true, status: true, score: true, errorMessage: true } } },
            });
            const seenExpTask = new Set<string>();
            for (const c of expCases) {
                if (!c.taskId || seenExpTask.has(c.taskId)) continue;
                seenExpTask.add(c.taskId);
                const rs = c.results;
                if (!rs.length) continue;
                const traj = rs.find((r: { evaluatorId: string }) => r.evaluatorId === 'preset-agent-trace-quality');
                const anyRunning = rs.some((r: { status: string }) => r.status === 'pending' || r.status === 'running');
                const anyFailed = rs.some((r: { status: string }) => r.status === 'failed');
                const allDone = rs.every((r: { status: string }) => r.status === 'done');
                const status = anyRunning ? 'running' : allDone ? 'done' : anyFailed ? 'failed' : 'pending';
                const at = c.createdAt instanceof Date ? c.createdAt.getTime() : 0;
                const prev = lastEvalByTaskId.get(c.taskId);
                if (!prev || at >= prev.at) {
                    lastEvalByTaskId.set(c.taskId, {
                        status,
                        errorMessage: rs.find((r: { errorMessage: string | null }) => r.errorMessage)?.errorMessage ?? null,
                        // 实验分 0-100 → 0-1，与 TrajectoryEvalResult.trajectoryScore 同刻度
                        trajectoryScore: typeof traj?.score === 'number' ? Math.round((traj.score / 100) * 1000) / 1000 : (prev?.trajectoryScore ?? null),
                        at,
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
        const baseTraceLifecycle = getTraceLifecycle(recordTaskId ? sessionEndByTaskId.get(recordTaskId) : null, record);
        // 方案A: 统一轨迹分（聚合层产出）。前端 getTraceFlowScore/ScoredTrace 优先读它，
        // 没有(未评测/纯对齐)再回退 matchJson.overallScore。
        const trajectory_score = lastEval?.trajectoryScore ?? null;
        if (skipAutoEvalReady) {
            const traceLifecycle = baseTraceLifecycle;
            return {
                ...record,
                is_evaluating,
                last_eval_status,
                last_eval_error,
                trajectory_score,
                trajectoryScore: trajectory_score,
                trace_last_received_at: traceLifecycle.traceLastReceivedAt,
                trace_status: traceLifecycle.traceStatus,
                traceStatus: traceLifecycle.traceStatus,
                trace_completed_at: traceLifecycle.traceCompletedAt,
                traceCompletedAt: traceLifecycle.traceCompletedAt,
                trace_status_reason: traceLifecycle.traceStatusReason,
                traceStatusReason: traceLifecycle.traceStatusReason,
            };
        }
        const readiness = await getAutoEvalReadiness(record);
        const traceLifecycle = baseTraceLifecycle;
        return {
            ...record,
            is_evaluating,
            last_eval_status,
            last_eval_error,
            trajectory_score,
            trajectoryScore: trajectory_score,
            trace_last_received_at: traceLifecycle.traceLastReceivedAt,
            trace_status: traceLifecycle.traceStatus,
            traceStatus: traceLifecycle.traceStatus,
            trace_completed_at: traceLifecycle.traceCompletedAt,
            traceCompletedAt: traceLifecycle.traceCompletedAt,
            trace_status_reason: traceLifecycle.traceStatusReason,
            traceStatusReason: traceLifecycle.traceStatusReason,
            auto_eval_ready: traceLifecycle.traceStatus === 'timed_out' ? false : readiness.autoEvalReady,
            autoEvalReady: traceLifecycle.traceStatus === 'timed_out' ? false : readiness.autoEvalReady,
            auto_eval_wait_reason: traceLifecycle.traceStatus === 'timed_out' ? 'inactivity-timeout' : readiness.autoEvalWaitReason,
            trace_last_activity_at: readiness.traceLastActivityAt,
        };
    }));
    
    let responseRecords = enrichedData;
    let responseTotal = pageResult?.total ?? enrichedData.length;
    let responseStats = pageResult?.stats ?? null;
    if (requiresComputedPass) {
        const statusFiltered = statusParam === 'all'
            ? enrichedData
            : enrichedData.filter((record) => String(record.trace_status ?? record.traceStatus ?? '') === statusParam);
        const statusOrder: Record<string, number> = { running: 0, timed_out: 1, failed: 2, success: 3 };
        statusFiltered.sort((a, b) => {
            let cmp = 0;
            if (sortParam === 'status') {
                cmp = (statusOrder[String(a.trace_status ?? a.traceStatus ?? 'running')] ?? 0)
                    - (statusOrder[String(b.trace_status ?? b.traceStatus ?? 'running')] ?? 0);
            } else if (sortParam === 'agent') {
                cmp = String(a.agentName ?? a.agent ?? '').localeCompare(String(b.agentName ?? b.agent ?? ''));
            } else if (sortParam === 'latency' || sortParam === 'tokens' || sortParam === 'cost') {
                const field = sortParam as 'latency' | 'tokens' | 'cost';
                cmp = Number(a[field] ?? 0) - Number(b[field] ?? 0);
            } else {
                cmp = new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime();
            }
            return sortDirParam === 'asc' ? cmp : -cmp;
        });
        responseTotal = statusFiltered.length;
        responseRecords = statusFiltered.slice((page - 1) * pageSize, page * pageSize);
        const totalTools = statusFiltered.reduce((sum, item) => sum + (item.tool_call_count ?? 0), 0);
        const totalToolErrors = statusFiltered.reduce((sum, item) => sum + (item.tool_call_error_count ?? 0), 0);
        responseStats = {
            total: responseTotal,
            failedCount: statusFiltered.filter(item => String(item.trace_status ?? item.traceStatus) === 'failed').length,
            avgLatencyMs: responseTotal > 0
                ? statusFiltered.reduce((sum, item) => sum + ((item.latency ?? 0) * 1000), 0) / responseTotal
                : 0,
            toolErrorRate: totalTools > 0
                ? Math.round((totalToolErrors / totalTools) * 1000) / 10
                : 0,
        };
    }

    if (responseRecords.length > 0) {
        console.log(`[Data-API] 📤 Sending ${responseRecords.length} records. Top record skills: ${JSON.stringify(responseRecords[0].skills)}, is_evaluating: ${responseRecords[0].is_evaluating}`);
    }
    if (paginated) {
        return NextResponse.json({
            records: responseRecords,
            total: responseTotal,
            page,
            pageSize,
            stats: responseStats,
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
            }, { receivedAt: null });
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
            }, { receivedAt: null });
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
            }, { receivedAt: null });

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
                }, { receivedAt: null }).catch(err => {
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
