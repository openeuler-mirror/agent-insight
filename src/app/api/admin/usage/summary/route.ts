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

import { gateUsageAdmin } from '@/lib/usage-analytics/auth';
import { getUsageSummary, isValidRange } from '@/lib/usage-analytics/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const gate = await gateUsageAdmin(request);
    if (!gate.ok) {
        const status = gate.reason === 'unauthenticated' ? 401 : 403;
        return NextResponse.json({ error: gate.reason }, { status });
    }

    const range = new URL(request.url).searchParams.get('range') ?? '7';
    if (!isValidRange(range)) {
        return NextResponse.json({ error: 'invalid range' }, { status: 400 });
    }

    try {
        return NextResponse.json(await getUsageSummary(range));
    } catch (error) {
        console.error('[usage] summary query failed:', error);
        return NextResponse.json({ error: 'query failed' }, { status: 500 });
    }
}
