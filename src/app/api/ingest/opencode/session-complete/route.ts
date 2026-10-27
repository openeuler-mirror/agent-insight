/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { db } from '@/lib/storage/prisma';
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

        return NextResponse.json({ success: true, task_id: taskId, endTime: safeCompletedAt.toISOString() });
    } catch (error) {
        console.error('[OpenCode Session Complete] Error:', error);
        return NextResponse.json({ error: 'Failed to mark session complete' }, { status: 500 });
    }
}
