import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { readRecords } from '@/lib/storage/data-service';
import { DEFAULT_POLICY } from '@/lib/engine/quality-monitoring/config';

export const dynamic = 'force-dynamic';

const SECURITY = /(inject|越权|未授权|unauthorized|pii|敏感|泄露|leak)/i;

function operationalScore(record: any): number {
    const parts: number[] = [];
    const failures = Array.isArray(record.failures) ? record.failures : [];
    const unsafe = failures.some((failure: any) =>
        SECURITY.test(`${failure?.failure_type ?? ''} ${failure?.description ?? ''}`),
    );
    parts.push(unsafe ? 0 : 100);

    const calls = Number(record.tool_call_count ?? 0);
    if (calls > 0) {
        const errors = Number(record.tool_call_error_count ?? 0);
        parts.push(Math.max(0, Math.min(100, (1 - errors / calls) * 100)));
    }

    const ratios: number[] = [];
    if (record.latency != null) ratios.push(Number(record.latency) / DEFAULT_POLICY.costBudget.latencyMs);
    if (record.tokens != null) ratios.push(Number(record.tokens) / DEFAULT_POLICY.costBudget.tokens);
    const steps = Number(record.tool_call_count ?? 0) + Number(record.llm_call_count ?? 0);
    if (steps > 0) ratios.push(steps / DEFAULT_POLICY.costBudget.steps);
    if (ratios.length) {
        parts.push(Math.max(0, Math.min(100, (1 - Math.max(...ratios)) * 100)));
    }

    return Math.round((parts.reduce((sum, value) => sum + value, 0) / parts.length) * 10) / 10;
}

/** 执行记录评分表 / 桶下钻数据源（FR-016 / S-003）。复用 readRecords + 时间窗内存过滤 + 分页。 */
export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        // 身份由前端 ?user= 携带；不读则 username=null 会越权返回全量执行记录。
        const { username } = await resolveUser(req, url.searchParams.get('user') || undefined);

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

        const rows = slice.map((r) => {
            return {
                id: r.upload_id || r.task_id || '',          // 下钻 /fault?executionId 用
                task_id: r.task_id,
                upload_id: r.upload_id,
                query: r.query,
                agent: r.agent || r.agentName,
                timestamp: r.timestamp,
                tool_call_count: r.tool_call_count ?? 0,
                llm_call_count: r.llm_call_count ?? 0,
                tool_call_error_count: r.tool_call_error_count ?? 0,
                failures: Array.isArray(r.failures) ? r.failures : [],
                tokens: r.tokens ?? null,
                cost: r.cost ?? null,
                latency: r.latency ?? null,
                quality_score: operationalScore(r),
            };
        });

        return NextResponse.json({ records: rows, total });
    } catch (error) {
        console.error('[Quality Executions Error]', error);
        return NextResponse.json({ error: 'Failed to list executions' }, { status: 500 });
    }
}
