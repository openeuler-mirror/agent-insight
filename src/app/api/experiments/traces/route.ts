// 实验向导 ② 步：按 Agent 分页列 root trace，供圈选 case。
// ok = 简单判定（toolCallErrorCount===0 且 failures 为空/null），仅作列表状态展示。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { ensureTraceTagTables } from '@/lib/trace-tags';
import {
  buildExperimentTraceWhere,
  parseExperimentTraceFilters,
} from '@/lib/engine/experiment/trace-filters';

export const dynamic = 'force-dynamic';

interface ExperimentTraceRow {
  id: string;
  taskId: string | null;
  query: string | null;
  finalResult: string | null;
  latency: number | null;
  tokens: number | null;
  timestamp: Date;
  toolCallErrorCount: number | null;
  failures: string | null;
}

function isOk(row: { toolCallErrorCount: number | null; failures: string | null }): boolean {
  if ((row.toolCallErrorCount ?? 0) > 0) return false;
  const f = (row.failures || '').trim();
  if (!f || f === 'null' || f === '[]') return true;
  try {
    const parsed = JSON.parse(f);
    return Array.isArray(parsed) ? parsed.length === 0 : !parsed;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    const agent = (url.searchParams.get('agent') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));
    const filters = parseExperimentTraceFilters(url.searchParams);
    if (filters.tagIds.length > 0) await ensureTraceTagTables();
    const where = buildExperimentTraceWhere(username, agent, filters);

    const [total, rows] = await Promise.all([
      prisma.execution.count({ where }),
      prisma.execution.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, taskId: true, query: true, finalResult: true,
          latency: true, tokens: true, timestamp: true,
          toolCallErrorCount: true, failures: true,
        },
      }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      items: rows.map((r: ExperimentTraceRow) => ({
        id: r.id,
        taskId: r.taskId,
        query: r.query,
        // ③ 步"实际输出"预填来源，勾选时随行带走，免二次请求。
        finalResult: r.finalResult,
        latency: r.latency,
        tokens: r.tokens,
        timestamp: r.timestamp,
        ok: isOk(r),
      })),
    });
  } catch (error) {
    console.error('[Experiment Traces Error]', error);
    return NextResponse.json({ error: 'Failed to load traces' }, { status: 500 });
  }
}
