import { NextResponse } from 'next/server';
import { qwenpawCollectorArchive } from './archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    try {
        return new NextResponse(new Uint8Array(qwenpawCollectorArchive()), {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="agent-insight-qwenpaw.zip"',
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (error) {
        console.error('Unable to create bundled QwenPaw collector archive:', error);
        return new NextResponse('Bundled QwenPaw collector is unavailable', { status: 500 });
    }
}
