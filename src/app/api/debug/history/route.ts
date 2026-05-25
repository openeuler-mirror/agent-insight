import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        const history = await (prisma as any).debugHistory.findMany({
            where: { user },
            orderBy: { createdAt: 'desc' }
        });

        // Parse resultsJson back to object
        const formattedHistory = history.map((h: any) => ({
            ...h,
            results: JSON.parse(h.resultsJson)
        }));

        return NextResponse.json(formattedHistory);
    } catch (err) {
        console.error('Failed to fetch history:', err);
        return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { user, skillId, skillName, versionA, versionB, query, temperature, results } = body;

        console.log('[DEBUG_HISTORY_POST] Received body:', body);

        if (!user) {
            console.error('[DEBUG_HISTORY_POST] Missing user');
            return NextResponse.json({ error: 'User is required' }, { status: 400 });
        }

        console.log('[DEBUG_HISTORY_POST] Creating record in DB...');
        const newRecord = await (prisma as any).debugHistory.create({
            data: {
                user,
                skillId,
                skillName,
                versionA,
                versionB,
                query,
                temperature,
                resultsJson: JSON.stringify(results)
            }
        });

        return NextResponse.json({
            ...newRecord,
            results: JSON.parse(newRecord.resultsJson)
        });
    } catch (err) {
        console.error('Failed to save history:', err);
        return NextResponse.json({ error: 'Failed to save history' }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    // Note: Next.js 13+ dynamic routes handle params differently. 
    // But since this is a simple implementation, I'll extract it from the URL if needed 
    // or use a segment if I name it [id]/route.ts.
    // I'll use the URL path for simplicity here if I name it differently, 
    // but the standard is [id]/route.ts.
    return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
