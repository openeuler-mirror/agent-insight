import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { exportTraceBundle } from '@/lib/trace-transfer-service';

export const dynamic = 'force-dynamic';

function safeFileSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'trace';
}
export async function GET(request: Request) {
    const url = new URL(request.url);
    const executionId = (url.searchParams.get('executionId') || '').trim();
    const { username } = await resolveUser(request, url.searchParams.get('user') || undefined);
    if (!username) return NextResponse.json({ error: 'Missing user identity' }, { status: 401 });
    if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

    try {
        const bundle = await exportTraceBundle(executionId, username);
        return NextResponse.json(bundle, {
            headers: {
                'Content-Disposition': `attachment; filename="trace-${safeFileSegment(bundle.rootExecutionId)}.json"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export trace';
        const status = message.includes('not found') ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
