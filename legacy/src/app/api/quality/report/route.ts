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
import { resolveUser } from '@/lib/auth/auth';
import { buildQualityReport, resolveWindowRange } from '@/lib/engine/quality-monitoring';
import type { WindowKind } from '@/lib/engine/quality-monitoring/types';

export const dynamic = 'force-dynamic';

const WINDOWS: WindowKind[] = ['1d', '1w', '1m', 'custom'];

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        // 身份由前端 ?user= 携带；不读则 username=null 会越权聚合全量数据。
        const { username } = await resolveUser(req, url.searchParams.get('user') || undefined);

        const agent = (url.searchParams.get('agent') || '').trim();
        if (!agent) return NextResponse.json({ error: 'agent is required' }, { status: 400 });

        const windowParam = (url.searchParams.get('window') || '1w') as WindowKind;
        const window: WindowKind = WINDOWS.includes(windowParam) ? windowParam : '1w';
        const fromISO = url.searchParams.get('from');
        const toISO = url.searchParams.get('to');
        if (window === 'custom' && (!fromISO || !toISO)) {
            return NextResponse.json({ error: 'from/to required when window=custom' }, { status: 400 });
        }

        const skill = url.searchParams.get('skill') || undefined;

        const { from, to } = resolveWindowRange(window, new Date(), fromISO, toISO);
        if (from.getTime() > to.getTime()) {
            return NextResponse.json({ error: 'invalid range: from > to' }, { status: 400 });
        }

        const report = await buildQualityReport({
            user: username,
            agent,
            window,
            from,
            to,
            filters: skill ? { skill } : undefined,
        });

        return NextResponse.json(report);
    } catch (error) {
        console.error('[Quality Report Error]', error);
        return NextResponse.json({ error: 'Failed to build quality report' }, { status: 500 });
    }
}
