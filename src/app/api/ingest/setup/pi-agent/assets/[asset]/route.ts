import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

const ROOT = path.join(process.cwd(), 'scripts', 'agent-trace-collectors');
const ASSETS: Record<string, { path: string[]; contentType: string }> = {
  'package.json': {
    path: ['pi-agent', 'package.json'],
    contentType: 'application/json; charset=utf-8',
  },
  'pi-agent-insight.ts': {
    path: ['pi-agent', 'extensions', 'pi-agent-insight.ts'],
    contentType: 'text/plain; charset=utf-8',
  },
  'pi-trace-core.cjs': {
    path: ['pi-agent', 'lib', 'pi-trace-core.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'self-check.cjs': {
    path: ['pi-agent', 'scripts', 'self-check.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'uninstall.cjs': {
    path: ['pi-agent', 'scripts', 'uninstall.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'install.cjs': {
    path: ['pi-agent', 'install.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'trace-transport.cjs': {
    path: ['shared', 'trace-transport.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  const { asset } = await params;
  const descriptor = ASSETS[asset];
  if (!descriptor) {
    return NextResponse.json({ error: 'Unknown Pi Agent collector asset.' }, { status: 404 });
  }
  try {
    const source = await readFile(path.join(ROOT, ...descriptor.path), 'utf8');
    return new NextResponse(source, {
      headers: {
        'Content-Type': descriptor.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Pi Agent collector asset is unavailable.' }, { status: 500 });
  }
}
