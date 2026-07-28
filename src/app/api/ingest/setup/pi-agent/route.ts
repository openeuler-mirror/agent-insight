import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

export async function GET(request: Request) {
  const isWindows = request.headers.get('x-platform')?.toLowerCase() === 'windows' ||
    request.headers.get('user-agent')?.toLowerCase().includes('windows');
  const installerPath = path.join(
    process.cwd(),
    'scripts',
    'agent-trace-collectors',
    'pi-agent',
    isWindows ? 'install.ps1' : 'install.sh',
  );
  try {
    const source = await readFile(installerPath, 'utf8');
    const script = source.replaceAll('__AGENT_INSIGHT_BASE_URL__', publicOrigin(request));
    return new NextResponse(script, {
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        ...(isWindows ? { 'Content-Type': 'application/x-powershell; charset=utf-8' } : {}),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('Pi Agent collector installer is unavailable.', { status: 500 });
  }
}
