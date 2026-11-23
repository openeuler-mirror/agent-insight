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

import { readRecords } from '@/lib/storage/data-service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const taskId = searchParams.get('taskId');
        const framework = searchParams.get('framework') || undefined;

        if (!taskId) {
            return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
        }

        const records = await readRecords(undefined, { taskId, framework });
        if (!records.length) {
            return NextResponse.json({ found: false }, { status: 404 });
        }

        const r: any = records[0];
        return NextResponse.json({
            found: true,
            task_id: r.task_id,
            upload_id: r.upload_id,
            framework: r.framework,
            model: r.model,
            timestamp: r.timestamp,
            latency: r.latency,
            tokens: r.tokens,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            tool_call_count: r.tool_call_count,
            llm_call_count: r.llm_call_count,
            tool_call_error_count: r.tool_call_error_count,
            cost: r.cost,
        });
    } catch (error) {
        console.error('Task Stats Error:', error);
        return NextResponse.json({ error: 'Failed to read task stats' }, { status: 500 });
    }
}
