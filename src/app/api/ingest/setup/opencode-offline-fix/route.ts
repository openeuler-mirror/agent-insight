import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

// 服务端下发「opencode 离线快速修复」脚本（PowerShell）。
// 对外可经 rewrite 用 /api/setup/opencode-offline-fix 访问。
// 因脚本带 -Restore/-Force/-Registry 参数，需下载成文件再带参运行（不能 irm | iex 直接执行）。
export async function GET() {
    const filePath = path.join(process.cwd(), 'scripts', 'opencode-offline-fix.ps1');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}
