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

import { NextResponse } from 'next/server';

import { detectAgentRuntimes } from '@/lib/agent-runtime';
import {
    resolveAgentRuntimePreference,
    validateAgentRuntimeSelection,
} from '@/lib/agent-runtime/preference';
import { resolveUser } from '@/lib/auth/auth';
import {
    getAgentRuntimePreference,
    saveAgentRuntimePreference,
} from '@/lib/storage/server-config';

export const dynamic = 'force-dynamic';

async function snapshot(user: string | null, forceRefresh: boolean) {
    const detection = await detectAgentRuntimes({ forceRefresh });
    const selectedId = await getAgentRuntimePreference(user);
    return {
        runtimes: detection.runtimes,
        checkedAt: detection.checkedAt,
        preference: resolveAgentRuntimePreference(selectedId, detection.runtimes),
    };
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const { username } = await resolveUser(request, url.searchParams.get('user'));
        const forceRefresh = url.searchParams.get('refresh') === '1';
        return NextResponse.json(await snapshot(username, forceRefresh));
    } catch (error) {
        console.error('[agent-runtime GET]', error);
        return NextResponse.json({ error: '检测 Agent 运行时失败' }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { username } = await resolveUser(request, body.user);
        if (!username) {
            return NextResponse.json({ error: 'User is required' }, { status: 400 });
        }

        if (body.runtimeId === null) {
            await saveAgentRuntimePreference(username, null);
            return NextResponse.json(await snapshot(username, false));
        }

        const runtimeId = String(body.runtimeId || '');
        const detection = await detectAgentRuntimes({ forceRefresh: true });
        const validation = validateAgentRuntimeSelection(runtimeId, detection.runtimes);
        if (!validation.ok) {
            return NextResponse.json(
                {
                    error: validation.diagnostic?.message ?? '该运行时当前不可用',
                    code: validation.diagnostic?.code ?? 'RUNTIME_SELECTION_UNAVAILABLE',
                },
                { status: 409 },
            );
        }

        await saveAgentRuntimePreference(username, validation.runtime!.id);
        return NextResponse.json(await snapshot(username, false));
    } catch (error) {
        console.error('[agent-runtime PUT]', error);
        return NextResponse.json({ error: '保存 Agent 运行时默认值失败' }, { status: 500 });
    }
}
