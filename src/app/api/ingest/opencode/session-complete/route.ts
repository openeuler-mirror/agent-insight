import { db } from '@/lib/storage/prisma';
import { triggerTrajectoryAutoWatchForTask } from '@/lib/engine/evaluation/trajectory-auto-watch';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const apiKey = request.headers.get('x-witty-api-key');
        let username: string | undefined;

        if (apiKey) {
            const user = await db.findUserByApiKey(apiKey);
            if (!user) {
                return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
            }
            username = user.username;
        }

        const body = await request.json().catch(() => ({}));
        const taskId = String(body.task_id || body.session_id || body.sessionID || '').trim();
        if (!taskId) {
            return NextResponse.json({ error: 'task_id is required' }, { status: 400 });
        }

        const existing = await db.findSessionByTaskId(taskId);
        const completedAt = body.completed_at ? new Date(body.completed_at) : new Date();
        const safeCompletedAt = Number.isNaN(completedAt.getTime()) ? new Date() : completedAt;

        const autoWatchUser = username || existing?.user || undefined;

        if (existing) {
            if (username && existing.user && existing.user !== username) {
                return NextResponse.json({ error: 'Session does not belong to authenticated user' }, { status: 403 });
            }
            await db.updateSession(taskId, { endTime: safeCompletedAt });
        } else {
            await db.upsertSession(
                taskId,
                {
                    taskId,
                    user: username,
                    startTime: safeCompletedAt,
                    endTime: safeCompletedAt,
                    interactions: JSON.stringify([]),
                    label: 'opencode',
                },
                {
                    endTime: safeCompletedAt,
                    user: username,
                },
            );
        }

        void triggerTrajectoryAutoWatchForTask(autoWatchUser, taskId, new URL(request.url).origin);

        return NextResponse.json({ success: true, task_id: taskId, endTime: safeCompletedAt.toISOString() });
    } catch (error) {
        console.error('[OpenCode Session Complete] Error:', error);
        return NextResponse.json({ error: 'Failed to mark session complete' }, { status: 500 });
    }
}
