import { NextResponse } from 'next/server';

import { isTrackedFeature } from '@/lib/usage-analytics/catalog';
import { gateUsageAdmin } from '@/lib/usage-analytics/auth';
import { getUsageFeatureDetail, isValidRange } from '@/lib/usage-analytics/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ featureKey: string }> }) {
    const gate = await gateUsageAdmin(request);
    if (!gate.ok) {
        const status = gate.reason === 'unauthenticated' ? 401 : 403;
        return NextResponse.json({ error: gate.reason }, { status });
    }

    const { featureKey } = await params;
    if (!isTrackedFeature(featureKey)) {
        return NextResponse.json({ error: 'unknown feature' }, { status: 400 });
    }

    const range = new URL(request.url).searchParams.get('range') ?? '7';
    if (!isValidRange(range)) {
        return NextResponse.json({ error: 'invalid range' }, { status: 400 });
    }

    try {
        return NextResponse.json(await getUsageFeatureDetail(featureKey, range));
    } catch (error) {
        console.error('[usage] feature query failed:', error);
        return NextResponse.json({ error: 'query failed' }, { status: 500 });
    }
}
