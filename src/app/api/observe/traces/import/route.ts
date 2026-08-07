import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { importTraceBundle } from '@/lib/trace-transfer-service';
import { TRACE_BUNDLE_MAX_BYTES, TraceBundleValidationError } from '@/lib/trace-transfer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > TRACE_BUNDLE_MAX_BYTES) {
        return NextResponse.json({ error: 'Trace bundle exceeds the 50 MB limit' }, { status: 413 });
    }

    let body: any;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (JSON.stringify(body?.bundle ?? null).length > TRACE_BUNDLE_MAX_BYTES) {
        return NextResponse.json({ error: 'Trace bundle exceeds the 50 MB limit' }, { status: 413 });
    }

    const { username } = await resolveUser(request, typeof body?.user === 'string' ? body.user : undefined);
    if (!username) return NextResponse.json({ error: 'Missing user identity' }, { status: 401 });

    try {
        const result = await importTraceBundle(body?.bundle, username);

        recordUsageEvent({ user: username, featureKey: 'trace', eventKey: 'trace.import' });

        return NextResponse.json({
            success: true,
            fileName: typeof body?.fileName === 'string' ? body.fileName : null,
            ...result,
        });
    } catch (error) {
        if (error instanceof TraceBundleValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('[Trace Import] failed:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to import trace' }, { status: 500 });
    }
}
