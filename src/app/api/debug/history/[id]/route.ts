import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    console.log(`[DELETE] Attempting to delete record ${id} for user ${user}`);

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        // We include user check for security
        const deleted = await (prisma as any).debugHistory.deleteMany({
            where: { id, user }
        });

        if (deleted.count === 0) {
            console.warn(`[DELETE] Record ${id} not found in database for user ${user}`);
            return NextResponse.json({ error: 'Record not found' }, { status: 404 });
        }

        console.log(`[DELETE] Record ${id} deleted successfully from database`);
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error('Failed to delete history from DB:', err);
        return NextResponse.json({ error: 'Failed to delete record' }, { status: 500 });
    }
}
