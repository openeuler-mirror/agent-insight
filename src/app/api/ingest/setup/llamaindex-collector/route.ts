import { NextResponse } from 'next/server';
import { collectorArchive } from './archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    try {
        return new NextResponse(new Uint8Array(collectorArchive()), {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="agent-insight-llamaindex.zip"',
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (error) {
        console.error('Unable to create bundled LlamaIndex collector archive:', error);
        return new NextResponse('Bundled LlamaIndex collector is unavailable', { status: 500 });
    }
}
