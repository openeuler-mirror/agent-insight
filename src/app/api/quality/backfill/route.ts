import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { sampleAndBackfill } from '@/lib/engine/quality-monitoring/sampling';
import type { WindowKind } from '@/lib/engine/quality-monitoring/types';

export const dynamic = 'force-dynamic';

const WINDOWS: WindowKind[] = ['1d', '1w', '1m', 'custom'];

/**
 * 采样异步回填触发入口（NFR-001）。后台跑、立即返回受理；绝不在 GET /report 内触发。
 * MVP：等待回填编排返回受理结果（选样/限流/写回已内部失败隔离）；不阻塞至全部评测完成。
 */
export async function POST(req: Request) {
    try {
        const { username } = await resolveUser(req);
        const url = new URL(req.url);
        const agent = (url.searchParams.get('agent') || '').trim();
        if (!agent) return NextResponse.json({ error: 'agent is required' }, { status: 400 });

        const windowParam = (url.searchParams.get('window') || '1w') as WindowKind;
        const window: WindowKind = WINDOWS.includes(windowParam) ? windowParam : '1w';
        const budget = url.searchParams.get('budget') ? parseInt(url.searchParams.get('budget') as string, 10) : undefined;

        const result = await sampleAndBackfill({
            user: username,
            agent,
            window,
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            budget,
        });

        return NextResponse.json(result, { status: 202 });
    } catch (error) {
        console.error('[Quality Backfill Error]', error);
        return NextResponse.json({ error: 'Failed to trigger backfill' }, { status: 500 });
    }
}
