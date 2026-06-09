/**
 * 一次性回填:把"平台服务端替用户跑出来、却记在服务账号(admin)名下"的执行 trace 归还给真正的发起人。
 *
 * 背景:AB 测试 / 评测是平台在服务端替用户跑 agent + 评测器,这些 agent 的遥测由 server 的上传器带
 * server 自己的 witty key 上传 → 全部归到服务账号(admin)名下,导致用户在「链路追踪」列表里看不到
 * 自己跑的执行 trace。写侧已加 hook(评测创建时把被执行 trace 归还发起人);本脚本回填历史数据。
 *
 * 链路(都带 user):
 *   - TrajectoryEvalResult(user + executionId/taskId)   —— 覆盖 AB + 用例分析的被执行 trace
 *   - GrayscaleTask(user + caseStatesJson 里的 sessionId)—— 覆盖灰度执行 trace(含未评测的)
 * 安全:只动当前 owner 是服务账号(admin/anonymous/空/debug-user)的 trace,绝不动真实用户已拥有的。
 *
 * 用法:
 *   node --import tsx scripts/backfill_trace_ownership.ts           # dry-run,只统计会改多少、从谁移给谁
 *   node --import tsx scripts/backfill_trace_ownership.ts --apply   # 实际写入
 */

export {}; // 让本文件成为模块(独立作用域),避免与其它脚本的顶层 main/常量在全局作用域里重名

const APPLY = process.argv.includes('--apply');

async function main() {
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const { reattributeServiceTraceOwner, isServiceTraceOwner } = await import('@/lib/storage/data-service');

    // ref(sessionId/executionId/taskId) -> intendedUser(首个非空、非服务账号者胜出)
    const want = new Map<string, string>();
    const addPair = (ref: string | null | undefined, user: string | null | undefined) => {
        const r = (ref || '').trim();
        const u = (user || '').trim();
        if (!r || !u || isServiceTraceOwner(u)) return;
        if (!want.has(r)) want.set(r, u);
    };

    // 1) TrajectoryEvalResult(分批游标)
    let cursor: string | undefined;
    let evalScanned = 0;
    for (;;) {
        const rows: Array<{ id: string; user: string | null; executionId: string | null; taskId: string | null }> =
            await prismaRaw.trajectoryEvalResult.findMany({
                select: { id: true, user: true, executionId: true, taskId: true },
                orderBy: { id: 'asc' },
                take: 500,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;
        for (const r of rows) { addPair(r.taskId || r.executionId, r.user); evalScanned++; }
    }
    console.log(`TrajectoryEvalResult scanned=${evalScanned}`);

    // 2) GrayscaleTask.caseStatesJson 里的 sessionId / traceIds
    const tasks: Array<{ id: string; user: string | null; caseStatesJson: string }> =
        await prismaRaw.grayscaleTask.findMany({ select: { id: true, user: true, caseStatesJson: true } });
    for (const t of tasks) {
        let states: Record<string, Record<string, { sessionId?: string; runs?: Array<{ sessionId?: string; traceIds?: string[] }> }>>;
        try { states = JSON.parse(t.caseStatesJson || '{}'); } catch { continue; }
        for (const caseId of Object.keys(states || {})) {
            for (const side of ['a', 'b'] as const) {
                const st = states[caseId]?.[side];
                if (!st) continue;
                if (st.sessionId) addPair(st.sessionId, t.user);
                for (const run of (st.runs || [])) {
                    if (run.sessionId) addPair(run.sessionId, t.user);
                    for (const tid of (run.traceIds || [])) addPair(tid, t.user);
                }
            }
        }
    }
    console.log(`GrayscaleTask scanned=${tasks.length}, distinct refs=${want.size}`);

    // 3) 查每个 ref 当前 owner → 算候选
    const refs = [...want.keys()];
    const ownerOf = new Map<string, string>();
    for (let i = 0; i < refs.length; i += 400) {
        const batch = refs.slice(i, i + 400);
        const byId: Array<{ id: string; user: string | null }> =
            await prismaRaw.execution.findMany({ where: { id: { in: batch } }, select: { id: true, user: true } });
        for (const e of byId) ownerOf.set(e.id, (e.user || '').trim());
        const missing = batch.filter(r => !ownerOf.has(r));
        if (missing.length) {
            const byTask: Array<{ taskId: string | null; user: string | null }> =
                await prismaRaw.execution.findMany({ where: { taskId: { in: missing } }, select: { taskId: true, user: true } });
            for (const e of byTask) if (e.taskId) ownerOf.set(e.taskId, (e.user || '').trim());
        }
    }

    const candidates: Array<{ ref: string; from: string; to: string }> = [];
    const fromBreakdown = new Map<string, number>();
    const toBreakdown = new Map<string, number>();
    let notFound = 0;
    for (const [ref, to] of want) {
        if (!ownerOf.has(ref)) { notFound++; continue; }
        const from = ownerOf.get(ref) || '';
        if (from === to) continue;
        if (!isServiceTraceOwner(from)) continue; // 真实用户的 trace 不动
        candidates.push({ ref, from, to });
        fromBreakdown.set(from, (fromBreakdown.get(from) || 0) + 1);
        toBreakdown.set(to, (toBreakdown.get(to) || 0) + 1);
    }

    console.log(`\n=== 候选(会被重新归属)= ${candidates.length}    refs 不在 Execution 表 = ${notFound} ===`);
    console.log('从(服务账号)移走:', [...fromBreakdown.entries()].map(([k, v]) => `${k || '<空>'}:${v}`).join('  ') || '(无)');
    console.log('归还给:', [...toBreakdown.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || '(无)');

    if (!APPLY) {
        console.log('\n(dry-run。确认无误后加 --apply 实际写入。)');
        await prismaRaw.$disconnect();
        return;
    }

    let applied = 0;
    for (const c of candidates) {
        if (await reattributeServiceTraceOwner(c.ref, c.to)) applied++;
    }
    console.log(`\n✅ 已重新归属 ${applied} 条(含 sub-agent / ExecutionSkill / Session 同步)。`);
    await prismaRaw.$disconnect();
}

main().catch(async (e) => {
    console.error('❌ 回填失败:', e);
    try { const { prismaRaw } = await import('@/lib/storage/prisma'); await prismaRaw.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
