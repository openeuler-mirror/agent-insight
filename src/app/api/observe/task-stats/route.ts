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
