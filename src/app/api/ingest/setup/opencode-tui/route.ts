import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

export async function GET() {
    const filePath = path.join(process.cwd(), 'scripts', 'opencode_tui_plugin.tsx');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain' }
    });
}
