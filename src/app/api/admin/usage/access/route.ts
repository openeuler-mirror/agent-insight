import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { isUsageAdmin } from '@/lib/usage-analytics/auth';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const enabled = isUsageEnabled();
    if (!enabled) {
        return NextResponse.json({ enabled: false, isAdmin: false });
    }
    // 只解析 API Key，绝不接受 explicitUser。
    const { username } = await resolveUser(request);
    return NextResponse.json({ enabled: true, isAdmin: isUsageAdmin(username) });
}
