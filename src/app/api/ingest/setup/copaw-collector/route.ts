import { NextResponse } from 'next/server';
import { copawCollectorArchive } from './archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    try {
        return new NextResponse(new Uint8Array(copawCollectorArchive()), {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="agent-insight-copaw.zip"',
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (error) {
        console.error('Unable to create bundled CoPaw collector archive:', error);
        return new NextResponse('Bundled CoPaw collector is unavailable', { status: 500 });
    }
}
