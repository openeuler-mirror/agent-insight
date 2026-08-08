import { NextResponse } from 'next/server';

import { gateUsageAdmin } from '@/lib/usage-analytics/auth';
import { getUsageSummary, isValidRange } from '@/lib/usage-analytics/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const gate = await gateUsageAdmin(request);
    if (!gate.ok) {
        const status = gate.reason === 'unauthenticated' ? 401 : 403;
        return NextResponse.json({ error: gate.reason }, { status });
    }

    const range = new URL(request.url).searchParams.get('range') ?? '7';
    if (!isValidRange(range)) {
        return NextResponse.json({ error: 'invalid range' }, { status: 400 });
    }

    try {
        return NextResponse.json(await getUsageSummary(range));
    } catch (error) {
        console.error('[usage] summary query failed:', error);
        return NextResponse.json({ error: 'query failed' }, { status: 500 });
    }
}
