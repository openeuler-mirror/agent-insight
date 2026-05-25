import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

export async function GET() {
    const filePath = path.join(process.cwd(), 'scripts', 'claude_watcher_client.ts');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Claude watcher script not found' }, { status: 404 });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain' }
    });
}
