import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

// Serves the JiuwenSwarm observability extension entry script. The setup bash/
// PowerShell installer curls this into
// <workspace>/extensions/agent-insight-observability/extension.py.
// Source of truth: scripts/jiuwen_extension/extension.py
export async function GET() {
    const extPath = path.join(process.cwd(), 'scripts', 'jiuwen_extension', 'extension.py');

    try {
        const source = await readFile(extPath, 'utf8');
        return new NextResponse(source, {
            headers: {
                'Content-Type': 'text/x-python; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new NextResponse('JiuwenSwarm extension source is unavailable.', { status: 500 });
    }
}
