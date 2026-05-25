import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        const tasks = await (prisma as any).batchEvalTask.findMany({
            where: { user },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        const parsed = tasks.map((t: any) => ({
            ...t,
            configJson: JSON.parse(t.configJson || '{}'),
            caseStatesJson: JSON.parse(t.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(t.traceEvalStatesJson || '{}'),
        }));
        return NextResponse.json(parsed);
    } catch (err) {
        console.error('[BATCH_TASKS_GET] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { user, taskName } = body;

        if (!user || !taskName?.trim()) {
            return NextResponse.json({ error: 'user and taskName are required' }, { status: 400 });
        }

        const task = await (prisma as any).batchEvalTask.create({
            data: { user, taskName: taskName.trim() },
        });
        return NextResponse.json(task);
    } catch (err) {
        console.error('[BATCH_TASKS_POST] Failed:', err);
        return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
}
