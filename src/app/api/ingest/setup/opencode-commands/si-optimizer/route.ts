import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export async function GET() {
    const filePath = path.join(process.cwd(), 'scripts', 'si-optimizer.md');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Command not found' }, { status: 404 });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
    });
}
