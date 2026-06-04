import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';

/**
 * BatchEvalTask 用例分析的核心状态机 (跟 grayscale 对齐, 单 side):
 *   pending: 还没开始
 *   running: agent 执行中 (跑 runGeneralAgent)
 *   executed: agent 跑完, 等评测 (autoEval=true 会马上接评测)
 *   evaluating: 评测器跑中
 *   pass: 评测完成 (无报错; 不引入"通过/未通过"语义, 跟用户讨论一致)
 *   fail: 执行或评测出错
 */
type BatchCaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

interface BatchCaseState {
    status: BatchCaseStatus;
    /** 选中此 case 时的输入 (来自 dataset.cases[].input), 用作 runGeneralAgent.query */
    input?: string;
    /** runGeneralAgent 返回的 opencode session id, 即评测器要传的 taskId */
    sessionId?: string;
    /** 执行/评测错误信息 */
    error?: string;
    /** 评测器创建的批次 ID (即 evaluatorRunId), append 模式下 = task.config.evaluationBatchId */
    evaluatorRunId?: string;
    /** 综合分 (0-100), 评测完成后回写: trajectoryScore + resultEvaluationScore 平均 */
    score?: number;
    /** 执行耗时 (秒) */
    timeCost?: string;
    /** 启动时间戳, UI 用来显示"运行时长" */
    startedAt?: number;
    /** 完成时间戳 */
    completedAt?: number;
}

interface BatchEvalConfig {
    datasetIds?: string[];
    skillId?: string;
    versionId?: string;
    sourceMode?: 'dataset' | 'trace';
    evaluatorId?: string;
    /** 评估器多选 (AB 式配置): 启动评测时透传给 trajectory/run 的 evaluators 数组, 优先于单选 evaluatorId。 */
    evaluators?: string[];
    agentMaxConcurrency?: number;
    autoEval?: boolean;
    /** 评测任务关联: 用户在配置区「+ 新增评测任务」创建的批次, 启动评测时透传 append 模式。 */
    evaluationBatchId?: string;
    evaluationBatchTitle?: string;
    evaluationBatchEvaluators?: string[];
}

interface BatchEvalTaskRow {
    id: string;
    user: string;
    taskName: string;
    configJson: string;
    caseStatesJson: string;
    traceEvalStatesJson: string;
}

/** 简化版任务级 abort 控制器: 用 module-level Map 缓存, key=taskId。
 *  Step 1.2 会换成跟 grayscale activeRuns 一致的机制 (跨 server 进程信息更全), 当前阶段保最小可用。 */
const batchActiveRuns = new Map<string, { abortController: AbortController; startedAt: number }>();

/** GET /api/debug/batch-tasks/[taskId]?user=... — fetch a single task's latest state */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const user = new URL(req.url).searchParams.get('user');
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        const task = await (prisma as any).batchEvalTask.findFirst({ where: { id: taskId, user } });
        if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        return NextResponse.json({
            ...task,
            configJson: JSON.parse(task.configJson || '{}'),
            caseStatesJson: JSON.parse(task.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson || '{}'),
        });
    } catch (err) {
        console.error('[BATCH_TASKS_GET_ONE] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
    }
}

/**
 * PATCH /api/debug/batch-tasks/[taskId]
 *
 * Persists config and/or case states for a task.
 * Body (all optional): { user, configJson, caseStatesJson, traceEvalStatesJson }
 */
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const body = await req.json();
        const { user, configJson, caseStatesJson, traceEvalStatesJson } = body;

        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }

        const data: Record<string, string> = {};
        if (configJson !== undefined) data.configJson = JSON.stringify(configJson);
        if (caseStatesJson !== undefined) data.caseStatesJson = JSON.stringify(caseStatesJson);
        if (traceEvalStatesJson !== undefined) data.traceEvalStatesJson = JSON.stringify(traceEvalStatesJson);

        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
        }

        const updated = await (prisma as any).batchEvalTask.update({
            where: { id: taskId, user },
            data,
        });

        return NextResponse.json({
            ...updated,
            configJson: JSON.parse(updated.configJson || '{}'),
            caseStatesJson: JSON.parse(updated.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(updated.traceEvalStatesJson || '{}'),
        });
    } catch (err) {
        console.error('[BATCH_TASKS_PATCH] Failed:', err);
        return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
    }
}

/**
 * POST /api/debug/batch-tasks/[taskId]
 *
 * Body: { user, action: 'start' | 'abort' | 'evaluate', caseIds: string[] }
 *
 * 当前 Step 1.1 仅实现 action='start' (用例分析"从数据集"模式 一键启动)。
 * abort / evaluate (Trace 模式) 在 Step 1.2 加。
 *
 * action='start' 行为 (跟 A/B 测试 startBatchTask 对齐, 但单 side):
 *   1. 加载 task + dataset, 找到选中的 case
 *   2. 初始化 caseStatesJson 每条 status='pending'
 *   3. fire-and-forget background loop: runWithConcurrency(agentMaxConcurrency)
 *      每个 case → withBackgroundOpencodeSlot 包 runGeneralAgent → 跑完写 sessionId
 *      → autoEval=true 接着调 trajectory/run (透传 evaluationBatchId 走 append 模式)
 *      → 状态 pending → running → executed → evaluating → pass/fail
 *   4. 立刻返回 { ok: true, startedAt }, 前端轮询 caseStatesJson 看进度
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const body = await req.json();
        const action = String(body.action || '').trim();
        const user = String(body.user || '').trim();
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        // action='evaluate': Trace 模式专用 (跳过执行, 直接对已有 trace 评测)。
        // caseIds 这里实际是 trace 的 task_id 数组 (前端从 traceRecords[].task_id 选)。
        // 状态机: pending → evaluating → pass/fail (没 running/executed 阶段, 因为不执行 agent)。
        // 后端 caseStates 用 trace.task_id 作 key, sessionId 直接 = task_id (因为评测器要的就是它)。
        if (action === 'evaluate') {
            const caseIds = Array.isArray(body.caseIds)
                ? body.caseIds.map((s: unknown) => String(s).trim()).filter(Boolean)
                : [];
            if (caseIds.length === 0) {
                return NextResponse.json({ error: 'caseIds (trace task_ids) is required' }, { status: 400 });
            }
            if (batchActiveRuns.has(taskId)) {
                return NextResponse.json({ error: 'task is already running' }, { status: 409 });
            }
            const origin = new URL(req.url).origin;
            await startTraceEvaluateInBackground(origin, taskId, user, caseIds);
            return NextResponse.json({ ok: true, taskId, mode: 'evaluate', startedAt: Date.now() });
        }
        // action='abort': 任务级终止, 触发 abortController 让 in-flight runOneBatchCase 退出
        if (action === 'abort') {
            const entry = batchActiveRuns.get(taskId);
            if (entry) {
                entry.abortController.abort();
                batchActiveRuns.delete(taskId);
            }
            // 无论内存里是否有在跑的 run, 都把数据库里非终态(running/evaluating/executed)的 case
            // 重置为失败「已终止」: 服务重启后内存登记表(batchActiveRuns)清空, 旧 run 遗留的"执行中"
            // case 没人收尾, 之前 abort 直接 return "no active run" → 看似无效且一直卡着。
            const reset = await resetStuckCases(taskId, user);
            return NextResponse.json({ ok: true, abortedAt: Date.now(), hadActiveRun: !!entry, reset });
        }
        // action='retry-execute' / 'retry-evaluate': 行级重试, 重置单个 case 状态后重跑
        if (action === 'retry-execute' || action === 'retry-evaluate') {
            const caseIds = Array.isArray(body.caseIds)
                ? body.caseIds.map((s: unknown) => String(s).trim()).filter(Boolean)
                : [];
            if (caseIds.length !== 1) {
                return NextResponse.json({ error: 'caseIds must have exactly 1 element for retry' }, { status: 400 });
            }
            const origin = new URL(req.url).origin;
            await retryBatchCase(origin, taskId, user, caseIds[0], action === 'retry-evaluate');
            return NextResponse.json({ ok: true, taskId, retriedAt: Date.now() });
        }
        if (action !== 'start') {
            return NextResponse.json({ error: `action '${action}' not supported` }, { status: 400 });
        }
        const caseIds = Array.isArray(body.caseIds)
            ? body.caseIds.map((s: unknown) => String(s).trim()).filter(Boolean)
            : [];
        if (caseIds.length === 0) {
            return NextResponse.json({ error: 'caseIds is required' }, { status: 400 });
        }
        // 已 in-flight 检查 (简化版)
        if (batchActiveRuns.has(taskId)) {
            return NextResponse.json({ error: 'task is already running' }, { status: 409 });
        }
        const origin = new URL(req.url).origin;
        await startBatchTaskInBackground(origin, taskId, user, caseIds);
        return NextResponse.json({ ok: true, taskId, startedAt: Date.now() });
    } catch (err) {
        console.error('[BATCH_TASKS_POST] Failed:', err);
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
}

/**
 * 在 config.datasetIds 指向的"仍存在"数据集里找出包含指定 caseId 的数据集 id。
 * 多选数据集后不能再假设 case 一定属于 datasetIds[0]——评测需带上 case 真正归属的 datasetId,
 * 否则 /api/eval/trajectory/run 在该数据集里找不到这个 case 会跳过评测。
 */
async function findCaseDatasetId(user: string, datasetIds: string[] | undefined, caseId: string): Promise<string | undefined> {
    const ids = (datasetIds || []).filter(Boolean);
    if (ids.length === 0) return undefined;
    const rows = await (prisma as unknown as { agentEvalDataset: { findMany: (a: unknown) => Promise<Array<{ id: string; casesJson: string }>> } }).agentEvalDataset.findMany({
        where: { id: { in: ids }, user },
    });
    for (const d of rows) {
        const cases = JSON.parse(d.casesJson || '[]') as Array<{ id: string }>;
        if (cases.some(c => c.id === caseId)) return d.id;
    }
    return undefined;
}

async function startBatchTaskInBackground(origin: string, taskId: string, user: string, caseIds: string[]) {
    // 1. 加载 task
    const task = await (prisma as unknown as { batchEvalTask: { findFirst: (a: unknown) => Promise<BatchEvalTaskRow | null> } }).batchEvalTask.findFirst({
        where: { id: taskId, user },
    });
    if (!task) throw new Error('task not found');
    const config: BatchEvalConfig = JSON.parse(task.configJson || '{}');
    const states: Record<string, BatchCaseState> = JSON.parse(task.caseStatesJson || '{}');

    // 2. 解析 skill (用户可能不绑 skill, 即纯模型基线 -- runGeneralAgent 不传 skill 即可)
    let skillName: string | undefined;
    let skillVersion: number | undefined;
    if (config.skillId) {
        const skill = await (prisma as unknown as { skill: { findFirst: (a: unknown) => Promise<{ name: string } | null> } }).skill.findFirst({
            where: { id: config.skillId, user },
        });
        skillName = skill?.name;
        if (config.versionId && skill) {
            // SkillVersion 表没有 user 字段 (user 通过 skillId 间接归属), 用 skillId 验证关联即可
            const sv = await (prisma as unknown as { skillVersion: { findFirst: (a: unknown) => Promise<{ version: number } | null> } }).skillVersion.findFirst({
                where: { id: config.versionId, skillId: config.skillId },
            });
            skillVersion = sv?.version;
        }
    }

    // 3. 加载 dataset(支持多选), 合并所有"仍存在"数据集的 case, 并记录每个 case 归属的 datasetId。
    //    旧实现只取 datasetIds[0] 有两个 bug: ①首位数据集被删 → 整批 "dataset not found" 启动失败;
    //    ②跨数据集勾选 case 时, 非首位数据集的 case 在执行(此处)与评测(autoEval 传 datasetId)两处都被静默丢弃。
    //    case id 为全局唯一 UUID, 跨数据集合并无键冲突; 全部数据集都查不到才报错。
    const datasetIds = (config.datasetIds || []).filter(Boolean);
    if (datasetIds.length === 0) throw new Error('dataset not selected in task config');
    const datasetRows = await (prisma as unknown as { agentEvalDataset: { findMany: (a: unknown) => Promise<Array<{ id: string; casesJson: string }>> } }).agentEvalDataset.findMany({
        where: { id: { in: datasetIds }, user },
    });
    if (datasetRows.length === 0) throw new Error('dataset not found');
    const caseMap = new Map<string, { id: string; input?: string; datasetId: string }>();
    for (const d of datasetRows) {
        for (const c of JSON.parse(d.casesJson || '[]') as Array<{ id: string; input?: string }>) {
            caseMap.set(c.id, { id: c.id, input: c.input, datasetId: d.id });
        }
    }
    const targets = caseIds.map(id => caseMap.get(id)).filter((c): c is { id: string; input?: string; datasetId: string } => !!c);
    if (targets.length === 0) throw new Error('no valid cases selected');

    // 4. 初始化状态 pending, persist
    for (const c of targets) {
        states[c.id] = {
            ...(states[c.id] || {}),
            status: 'pending',
            input: c.input || '',
        };
    }
    await persistStates(taskId, user, states);

    // 5. 任务级 abort controller (供 Step 1.2 abort action 用)
    const abortController = new AbortController();
    batchActiveRuns.set(taskId, { abortController, startedAt: Date.now() });

    // 6. fire-and-forget: 并发执行 + 自动评测
    void runBatchTaskBackground(origin, taskId, user, targets, config, states, skillName, skillVersion, abortController.signal)
        .catch(err => console.error(`[BATCH_TASKS_BG] task=${taskId} crashed:`, err))
        .finally(() => batchActiveRuns.delete(taskId));
}

async function runBatchTaskBackground(
    origin: string,
    taskId: string,
    user: string,
    targets: Array<{ id: string; input?: string; datasetId?: string }>,
    config: BatchEvalConfig,
    states: Record<string, BatchCaseState>,
    skillName: string | undefined,
    skillVersion: number | undefined,
    signal: AbortSignal,
) {
    const concurrency = Math.max(1, Number(config.agentMaxConcurrency || 4));
    let activeCount = 0;
    const queue = [...targets];
    await new Promise<void>((resolve) => {
        const tick = async () => {
            while (activeCount < concurrency && queue.length > 0 && !signal.aborted) {
                const c = queue.shift()!;
                activeCount++;
                void (async () => {
                    await runOneBatchCase(origin, taskId, user, c, config, states, skillName, skillVersion, signal);
                })().finally(() => {
                    activeCount--;
                    if (queue.length > 0 && !signal.aborted) tick();
                    else if (activeCount === 0) resolve();
                });
            }
            if (queue.length === 0 && activeCount === 0) resolve();
        };
        tick();
    });
}

async function runOneBatchCase(
    origin: string,
    taskId: string,
    user: string,
    c: { id: string; input?: string; datasetId?: string },
    config: BatchEvalConfig,
    states: Record<string, BatchCaseState>,
    skillName: string | undefined,
    skillVersion: number | undefined,
    signal: AbortSignal,
) {
    if (signal.aborted) {
        states[c.id] = { ...(states[c.id] || { status: 'pending' }), status: 'fail', error: '用户终止', completedAt: Date.now() };
        await persistStates(taskId, user, states);
        return;
    }
    states[c.id] = { ...states[c.id], status: 'running', startedAt: Date.now() };
    await persistStates(taskId, user, states);
    let sessionId: string | undefined;
    try {
        const result = await withBackgroundOpencodeSlot(
            () => runGeneralAgent({
                user,
                query: c.input || '',
                skill: skillName,
                skillVersion,
                interactionPolicy: 'auto-deny',
                // 用例分析「从数据集」执行器: 记成 skill-debug-executor → classifyTraceSource 归为 'batch'(用例分析)。
                // 旧实现误用 grayscale-* 名, 导致这些 trace 被标成 A/B 测试。skill/baseline 区分靠 skill 字段, 与名字无关。
                systemAgentName: 'skill-debug-executor',
                ephemeralServer: true,
                recordTraceAs: 'skill-debug-executor',
                sessionTitle: `batch ${user} · ${taskId} · ${c.id.slice(0, 8)}`,
                workspaceTag: `batch-${taskId}-${c.id}`,
                tagSkill: skillName,
            }),
            {
                taskType: 'batch-eval',
                user,
                label: `batch-${c.id.slice(0, 8)}`,
                skill: skillName,
                skillVersion: skillVersion ?? null,
                signal,
            },
        );
        sessionId = result.sessionId;
        states[c.id] = {
            ...states[c.id],
            status: 'executed',
            sessionId,
            timeCost: `${((Date.now() - (states[c.id].startedAt || Date.now())) / 1000).toFixed(1)}s`,
        };
        await persistStates(taskId, user, states);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        states[c.id] = {
            ...states[c.id],
            status: 'fail',
            error: signal.aborted ? '用户终止' : msg,
            completedAt: Date.now(),
        };
        await persistStates(taskId, user, states);
        return;
    }

    // autoEval: 接评测 (透传 evaluationBatchId append 模式)
    if (config.autoEval !== false && sessionId && !signal.aborted) {
        states[c.id] = { ...states[c.id], status: 'evaluating' };
        await persistStates(taskId, user, states);
        try {
            const evalBody: Record<string, unknown> = {
                user,
                // 多选数据集时 case 不一定属于 datasetIds[0], 用执行阶段记录的归属 datasetId, 否则评测会找不到 case。
                datasetId: c.datasetId ?? config.datasetIds?.[0],
                pairs: [{ caseId: c.id, taskId: sessionId }],
            };
            if (config.evaluationBatchId) {
                evalBody.evaluatorRunId = config.evaluationBatchId;
            } else if (Array.isArray(config.evaluators) && config.evaluators.length > 0) {
                evalBody.evaluators = config.evaluators;
            } else {
                evalBody.evaluator = config.evaluatorId || 'preset-agent-task-completion';
            }
            const evalRes = await fetch(`${origin}/api/eval/trajectory/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(evalBody),
                signal,
            });
            const data = await evalRes.json().catch(() => ({}));
            if (!evalRes.ok || !data.evaluatorRunId) {
                throw new Error(data.error || 'failed to start evaluation');
            }
            const evaluatorRunId = String(data.evaluatorRunId);
            states[c.id] = {
                ...states[c.id],
                evaluatorRunId,
            };
            await persistStates(taskId, user, states);
            // 等评测异步完成, 回写 pass/fail (跟 grayscale waitAndApplyEvaluation 同思路)
            await waitAndApplyBatchEvaluation(origin, user, taskId, c.id, sessionId, evaluatorRunId, states, signal);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            states[c.id] = {
                ...states[c.id],
                status: 'fail',
                error: signal.aborted ? '用户终止' : `评测启动失败: ${msg}`,
                completedAt: Date.now(),
            };
            await persistStates(taskId, user, states);
        }
    }
}

/**
 * 评测异步完成等待 + 回写: 跟 grayscale waitAndApplyEvaluation 同思路, 简化版 (单 case 单 sessionId)。
 * 启动评测后 batch 这一侧 polling /api/eval/trajectory/results, 找匹配 taskId=sessionId 的 result,
 * 状态 done/failed 后回写 caseStatesJson.status = 'pass'/'fail' + 分数。
 *
 * 超时 = 360s (180 次 × 2s), 超时后 case 标 fail。多评估器场景下当前实现取**第一个 done**, Step 1.3
 * 多评估器 fan out 时换成"所有 evaluator 都 done 再算 pass"。
 */
async function waitAndApplyBatchEvaluation(
    origin: string,
    user: string,
    taskId: string,
    caseId: string,
    sessionId: string,
    evaluatorRunId: string,
    states: Record<string, BatchCaseState>,
    signal: AbortSignal,
) {
    for (let i = 0; i < 180; i++) {
        if (signal.aborted) {
            states[caseId] = { ...states[caseId], status: 'fail', error: '用户终止', completedAt: Date.now() };
            await persistStates(taskId, user, states);
            return;
        }
        const res = await fetch(`${origin}/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}&limit=500`).catch(() => null);
        const data = res ? await res.json().catch(() => ({})) : {};
        const results = Array.isArray((data as { results?: unknown }).results) ? (data as { results: Array<Record<string, unknown>> }).results : [];
        // 找匹配本 case sessionId 的 result (评测里 taskId 字段 = agent sessionId)
        const matched = results.find(r => String(r.taskId || '') === sessionId);
        if (matched) {
            const status = String(matched.status || '');
            if (status === 'done') {
                // 综合分: trajectoryScore + resultEvaluationScore 平均 (跟 grayscale compositeScore 简化版)
                const traj = typeof matched.trajectoryScore === 'number' ? matched.trajectoryScore : null;
                const ra = matched.rawAnalysis as Record<string, unknown> | undefined;
                const resultEval = ra && typeof ra.resultEvaluation === 'object' && ra.resultEvaluation
                    ? Number((ra.resultEvaluation as { score?: unknown }).score)
                    : NaN;
                const combined = traj != null && Number.isFinite(resultEval)
                    ? Math.round(((traj + resultEval) / 2) * 100)
                    : traj != null ? Math.round(traj * 100)
                    : Number.isFinite(resultEval) ? Math.round(resultEval * 100)
                    : null;
                states[caseId] = {
                    ...states[caseId],
                    status: 'pass',
                    completedAt: Date.now(),
                    ...(combined != null ? { score: combined } as Partial<BatchCaseState> : {}),
                };
                await persistStates(taskId, user, states);
                return;
            } else if (status === 'failed') {
                states[caseId] = {
                    ...states[caseId],
                    status: 'fail',
                    error: String(matched.errorMessage || '评测失败'),
                    completedAt: Date.now(),
                };
                await persistStates(taskId, user, states);
                return;
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    // 超时
    states[caseId] = {
        ...states[caseId],
        status: 'fail',
        error: '评测超时 (>360s)',
        completedAt: Date.now(),
    };
    await persistStates(taskId, user, states);
}

async function persistStates(taskId: string, user: string, states: Record<string, BatchCaseState>) {
    await (prisma as unknown as { batchEvalTask: { update: (a: unknown) => Promise<unknown> } }).batchEvalTask.update({
        where: { id: taskId, user },
        data: { caseStatesJson: JSON.stringify(states) },
    });
}

/**
 * 把任务里非终态(running/evaluating/executed)的 case 重置为失败「已终止」。
 * 用于「终止」: 服务重启后内存 batchActiveRuns 已清空, 这些 case 实际并没有在跑(僵死状态),
 * 需要在数据库里收尾, 否则 UI 永远显示"执行中"且挡住后续启动。pending(未启动)不动。
 * 返回被重置的条数。
 */
async function resetStuckCases(taskId: string, user: string): Promise<number> {
    const task = await (prisma as unknown as { batchEvalTask: { findFirst: (a: unknown) => Promise<BatchEvalTaskRow | null> } }).batchEvalTask.findFirst({
        where: { id: taskId, user },
    });
    if (!task) return 0;
    let states: Record<string, BatchCaseState>;
    try { states = JSON.parse(task.caseStatesJson || '{}'); } catch { return 0; }
    let n = 0;
    for (const key of Object.keys(states)) {
        const s = states[key];
        if (s && (s.status === 'running' || s.status === 'evaluating' || s.status === 'executed')) {
            states[key] = { ...s, status: 'fail', error: '已手动终止', completedAt: Date.now() };
            n += 1;
        }
    }
    if (n > 0) await persistStates(taskId, user, states);
    return n;
}

/**
 * Trace 模式 action='evaluate': 已有 trace, 跳过执行, 仅评测。
 * caseIds 实际是 trace 的 task_id 列表 (前端从 traceRecords[].task_id 选)。
 * 写到 caseStatesJson 用 task_id 作 caseId, sessionId 字段也存 task_id (评测器用)。
 * 状态: pending → evaluating → pass/fail
 */
async function startTraceEvaluateInBackground(origin: string, taskId: string, user: string, traceTaskIds: string[]) {
    const task = await (prisma as unknown as { batchEvalTask: { findFirst: (a: unknown) => Promise<BatchEvalTaskRow | null> } }).batchEvalTask.findFirst({
        where: { id: taskId, user },
    });
    if (!task) throw new Error('task not found');
    const config: BatchEvalConfig = JSON.parse(task.configJson || '{}');
    const states: Record<string, BatchCaseState> = JSON.parse(task.caseStatesJson || '{}');

    // 初始化每条 trace 状态 pending
    for (const traceTaskId of traceTaskIds) {
        states[traceTaskId] = {
            ...(states[traceTaskId] || {}),
            status: 'pending',
            sessionId: traceTaskId, // sessionId = task_id (Trace 模式 trace 已有, 评测器用这个去查)
            startedAt: Date.now(),
        };
    }
    await persistStates(taskId, user, states);

    const abortController = new AbortController();
    batchActiveRuns.set(taskId, { abortController, startedAt: Date.now() });

    void runTraceEvalBackground(origin, taskId, user, traceTaskIds, config, states, abortController.signal)
        .catch(err => console.error(`[BATCH_TASKS_TRACE_EVAL] task=${taskId} crashed:`, err))
        .finally(() => batchActiveRuns.delete(taskId));
}

async function runTraceEvalBackground(
    origin: string,
    taskId: string,
    user: string,
    traceTaskIds: string[],
    config: BatchEvalConfig,
    states: Record<string, BatchCaseState>,
    signal: AbortSignal,
) {
    const concurrency = Math.max(1, Number(config.agentMaxConcurrency || 4));
    let activeCount = 0;
    const queue = [...traceTaskIds];
    await new Promise<void>((resolve) => {
        const tick = async () => {
            while (activeCount < concurrency && queue.length > 0 && !signal.aborted) {
                const traceId = queue.shift()!;
                activeCount++;
                void (async () => {
                    await evaluateOneTrace(origin, taskId, user, traceId, config, states, signal);
                })().finally(() => {
                    activeCount--;
                    if (queue.length > 0 && !signal.aborted) tick();
                    else if (activeCount === 0) resolve();
                });
            }
            if (queue.length === 0 && activeCount === 0) resolve();
        };
        tick();
    });
}

async function evaluateOneTrace(
    origin: string,
    taskId: string,
    user: string,
    traceTaskId: string,
    config: BatchEvalConfig,
    states: Record<string, BatchCaseState>,
    signal: AbortSignal,
) {
    if (signal.aborted) {
        states[traceTaskId] = { ...states[traceTaskId], status: 'fail', error: '用户终止', completedAt: Date.now() };
        await persistStates(taskId, user, states);
        return;
    }
    states[traceTaskId] = { ...states[traceTaskId], status: 'evaluating' };
    await persistStates(taskId, user, states);
    try {
        const evalBody: Record<string, unknown> = {
            user,
            taskIds: [traceTaskId], // trace 模式用 taskIds 而不是 pairs
        };
        if (config.evaluationBatchId) {
            evalBody.evaluatorRunId = config.evaluationBatchId;
        } else {
            evalBody.evaluator = config.evaluatorId || 'preset-agent-task-completion';
        }
        const evalRes = await fetch(`${origin}/api/eval/trajectory/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(evalBody),
            signal,
        });
        const data = await evalRes.json().catch(() => ({}));
        if (!evalRes.ok || !data.evaluatorRunId) {
            throw new Error(data.error || 'failed to start trace evaluation');
        }
        const evaluatorRunId = String(data.evaluatorRunId);
        states[traceTaskId] = { ...states[traceTaskId], evaluatorRunId };
        await persistStates(taskId, user, states);
        await waitAndApplyBatchEvaluation(origin, user, taskId, traceTaskId, traceTaskId, evaluatorRunId, states, signal);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        states[traceTaskId] = {
            ...states[traceTaskId],
            status: 'fail',
            error: signal.aborted ? '用户终止' : `评测失败: ${msg}`,
            completedAt: Date.now(),
        };
        await persistStates(taskId, user, states);
    }
}

/**
 * 行级重试: 复用 startBatchTaskInBackground 的核心逻辑跑单个 case。
 * - evaluateOnly=false (retry-execute): 重置 case 状态, 重跑 agent + 评测 (跟 start 走同路径)
 * - evaluateOnly=true (retry-evaluate): 已有 sessionId 时跳过执行, 只重跑评测; 没 sessionId 报错
 *
 * 不开 task-level abortController (跟主 start 区分), 单 case retry 用一次性 controller。
 */
async function retryBatchCase(origin: string, taskId: string, user: string, caseId: string, evaluateOnly: boolean) {
    const task = await (prisma as unknown as { batchEvalTask: { findFirst: (a: unknown) => Promise<BatchEvalTaskRow | null> } }).batchEvalTask.findFirst({
        where: { id: taskId, user },
    });
    if (!task) throw new Error('task not found');
    const config: BatchEvalConfig = JSON.parse(task.configJson || '{}');
    const states: Record<string, BatchCaseState> = JSON.parse(task.caseStatesJson || '{}');
    const existing = states[caseId];
    if (!existing) throw new Error('case not in current task state');

    // 重置: retry-evaluate 保留 sessionId; retry-execute 全部清掉
    const baseInput = existing.input || '';
    if (evaluateOnly) {
        if (!existing.sessionId) throw new Error('retry-evaluate requires existing sessionId');
        states[caseId] = {
            status: 'evaluating',
            input: baseInput,
            sessionId: existing.sessionId,
            startedAt: Date.now(),
        };
    } else {
        states[caseId] = {
            status: 'pending',
            input: baseInput,
            startedAt: Date.now(),
        };
    }
    await persistStates(taskId, user, states);

    // 解析 skill (跟 startBatchTaskInBackground 一样)
    let skillName: string | undefined;
    let skillVersion: number | undefined;
    if (config.skillId) {
        const skill = await (prisma as unknown as { skill: { findFirst: (a: unknown) => Promise<{ name: string } | null> } }).skill.findFirst({
            where: { id: config.skillId, user },
        });
        skillName = skill?.name;
        if (config.versionId && skill) {
            const sv = await (prisma as unknown as { skillVersion: { findFirst: (a: unknown) => Promise<{ version: number } | null> } }).skillVersion.findFirst({
                where: { id: config.versionId, skillId: config.skillId },
            });
            skillVersion = sv?.version;
        }
    }

    // 一次性 controller, 不进 batchActiveRuns (避免跟主任务 abort 冲突)
    const abortController = new AbortController();
    void (async () => {
        if (evaluateOnly) {
            // 跳过 runGeneralAgent, 直接调评测路径 (用 existing.sessionId)
            const sessionId = existing.sessionId!;
            try {
                const evalBody: Record<string, unknown> = {
                    user,
                    // 多选数据集时按 caseId 反查真正归属的 datasetId, 写死 datasetIds[0] 会导致评测找不到 case。
                    datasetId: (await findCaseDatasetId(user, config.datasetIds, caseId)) ?? config.datasetIds?.[0],
                    pairs: [{ caseId, taskId: sessionId }],
                };
                if (config.evaluationBatchId) {
                    evalBody.evaluatorRunId = config.evaluationBatchId;
                } else {
                    evalBody.evaluator = config.evaluatorId || 'preset-agent-task-completion';
                }
                const evalRes = await fetch(`${origin}/api/eval/trajectory/run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(evalBody),
                });
                const data = await evalRes.json().catch(() => ({}));
                if (!evalRes.ok || !data.evaluatorRunId) {
                    throw new Error(data.error || 'failed to start retry evaluation');
                }
                const evaluatorRunId = String(data.evaluatorRunId);
                states[caseId] = { ...states[caseId], evaluatorRunId };
                await persistStates(taskId, user, states);
                await waitAndApplyBatchEvaluation(origin, user, taskId, caseId, sessionId, evaluatorRunId, states, abortController.signal);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                states[caseId] = { ...states[caseId], status: 'fail', error: `重试评测失败: ${msg}`, completedAt: Date.now() };
                await persistStates(taskId, user, states);
            }
        } else {
            // 走完整 runOneBatchCase 路径
            await runOneBatchCase(origin, taskId, user, { id: caseId, input: baseInput }, config, states, skillName, skillVersion, abortController.signal);
        }
    })().catch(err => console.error(`[BATCH_TASKS_RETRY] case=${caseId} crashed:`, err));
}
