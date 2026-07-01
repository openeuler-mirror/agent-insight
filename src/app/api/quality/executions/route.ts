import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { readRecords } from '@/lib/storage/data-service';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

interface ResultEvalRow {
    executionId: string;
    metricKey: string;
    status: string;
    score: number | null;
    confidence: number;
    method: string;
    note: string | null;
    evidenceJson: string | null;
    errorMessage: string | null;
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
        const executionIds = slice.map((r) => r.upload_id).filter((id): id is string => Boolean(id));
        const evalRows: ResultEvalRow[] = executionIds.length ? await prisma.traceEvaluation.findMany({
            where: { executionId: { in: executionIds }, evaluatorId: 'result-quality' },
            select: { executionId: true, metricKey: true, status: true, score: true, confidence: true, method: true, note: true, evidenceJson: true, errorMessage: true },
        }) as ResultEvalRow[] : [];
        const evalByExecution = new Map<string, ResultEvalRow[]>();
        for (const row of evalRows) {
            const list = evalByExecution.get(row.executionId) ?? [];
            list.push(row);
            evalByExecution.set(row.executionId, list);
        }

        const rows = slice.map((r) => {
            const metrics = evalByExecution.get(r.upload_id || '') ?? [];
            const scored = metrics.filter((metric) => metric.status === 'done' && metric.score != null);
            const resultScore = scored.length ? Math.round((scored.reduce((sum: number, metric: ResultEvalRow) => sum + (metric.score as number), 0) / scored.length) * 10) / 10 : null;
            const statuses = new Set(metrics.map((metric) => metric.status));
            const resultEvalStatus = statuses.has('running') || statuses.has('pending') ? 'running'
                : statuses.has('failed') ? 'failed'
                    : metrics.length ? 'done' : 'missing';
            return {
                id: r.upload_id || r.task_id || '',          // 下钻 /fault?executionId 用
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
                result_score: resultScore,
                result_eval_status: resultEvalStatus,
                result_metrics: Object.fromEntries(metrics.map((metric) => {
                    let evidence = null; try { evidence = metric.evidenceJson ? JSON.parse(metric.evidenceJson) : null; } catch { /* ignore */ }
                    return [metric.metricKey, { score: metric.score, status: metric.status, confidence: metric.confidence, method: metric.method, note: metric.note, evidence, error: metric.errorMessage }];
                })),
            };
        });

        return NextResponse.json({ records: rows, total });
    } catch (error) {
        console.error('[Quality Executions Error]', error);
        return NextResponse.json({ error: 'Failed to list executions' }, { status: 500 });
    }
}
