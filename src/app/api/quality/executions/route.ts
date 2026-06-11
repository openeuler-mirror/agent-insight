import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { readRecords } from '@/lib/storage/data-service';

export const dynamic = 'force-dynamic';

/** 执行记录评分表 / 桶下钻数据源（FR-016 / S-003）。复用 readRecords + 时间窗内存过滤 + 分页。 */
export async function GET(req: Request) {
    try {
        const { username } = await resolveUser(req);
        const url = new URL(req.url);

        const agent = (url.searchParams.get('agent') || '').trim();
        if (!agent) return NextResponse.json({ error: 'agent is required' }, { status: 400 });

        const fromISO = url.searchParams.get('from');
        const toISO = url.searchParams.get('to');
        const skill = url.searchParams.get('skill') || undefined;
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));

        const from = fromISO ? new Date(fromISO).getTime() : -Infinity;
        const to = toISO ? new Date(toISO).getTime() : Infinity;

        // readRecords：默认只 root（isSubagent=false）、用户作用域；lightweight 避免大字段 OOM。
        const records = await readRecords(
            username ?? undefined,
            { agentName: agent, ...(skill ? { skill } : {}) },
            { lightweight: true },
        );

        const windowed = records
            .filter((r) => {
                const ts = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
                return Number.isFinite(ts) && ts >= from && ts <= to;
            })
            .sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime());

        const total = windowed.length;
        const slice = windowed.slice((page - 1) * pageSize, page * pageSize);

        const rows = slice.map((r) => ({
            id: r.task_id || r.upload_id || '',          // 下钻 /fault?executionId 用
            task_id: r.task_id,
            upload_id: r.upload_id,
            query: r.query,
            agent: r.agent || r.agentName,
            timestamp: r.timestamp,
            answer_score: r.answer_score ?? null,
            is_answer_correct: r.is_answer_correct ?? null,
            tool_call_count: r.tool_call_count ?? 0,
            tool_call_error_count: r.tool_call_error_count ?? 0,
            failures: Array.isArray(r.failures) ? r.failures : [],
            tokens: r.tokens ?? null,
            cost: r.cost ?? null,
            latency: r.latency ?? null,
        }));

        return NextResponse.json({ records: rows, total });
    } catch (error) {
        console.error('[Quality Executions Error]', error);
        return NextResponse.json({ error: 'Failed to list executions' }, { status: 500 });
    }
}
