import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';

/** GET /api/debug/batch-tasks/[taskId]?user=... — fetch a single task's latest state */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const user = new URL(req.url).searchParams.get('user');
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        const task = await (prisma as any).batchEvalTask.findFirst({ where: { id: taskId, user } });
        if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        return NextResponse.json({
            ...task,
            configJson: JSON.parse(task.configJson || '{}'),
            caseStatesJson: JSON.parse(task.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson || '{}'),
        });
    } catch (err) {
        console.error('[BATCH_TASKS_GET_ONE] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
    }
}

/**
 * PATCH /api/debug/batch-tasks/[taskId]
 *
 * Persists config and/or case states for a task.
 * Body (all optional): { user, configJson, caseStatesJson, traceEvalStatesJson }
 */
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const body = await req.json();
        const { user, configJson, caseStatesJson, traceEvalStatesJson } = body;

        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }

        const data: Record<string, string> = {};
        if (configJson !== undefined) data.configJson = JSON.stringify(configJson);
        if (caseStatesJson !== undefined) data.caseStatesJson = JSON.stringify(caseStatesJson);
        if (traceEvalStatesJson !== undefined) data.traceEvalStatesJson = JSON.stringify(traceEvalStatesJson);

        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
        }

        const updated = await (prisma as any).batchEvalTask.update({
            where: { id: taskId, user },
            data,
        });

        return NextResponse.json({
            ...updated,
            configJson: JSON.parse(updated.configJson || '{}'),
            caseStatesJson: JSON.parse(updated.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(updated.traceEvalStatesJson || '{}'),
        });
    } catch (err) {
        console.error('[BATCH_TASKS_PATCH] Failed:', err);
        return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
    }
}
