import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

export async function GET() {
    const pluginPath = path.join(process.cwd(), 'scripts', 'hermes_agent_insight_plugin.py');

    try {
        const source = await readFile(pluginPath, 'utf8');
        return new NextResponse(source, {
            headers: {
                'Content-Type': 'text/x-python; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new NextResponse('Hermes plugin source is unavailable.', { status: 500 });
    }
}
