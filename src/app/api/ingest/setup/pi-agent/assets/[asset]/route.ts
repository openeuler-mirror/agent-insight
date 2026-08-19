import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { piAgentBundle } from '../../bundle';

const ROOT = path.join(process.cwd(), 'scripts', 'agent-trace-collectors');
const LEGACY_ASSETS: Record<string, { path: string[]; contentType: string }> = {
  'package.json': { path: ['pi-agent', 'package.json'], contentType: 'application/json; charset=utf-8' },
  'pi-agent-insight.ts': { path: ['pi-agent', 'extensions', 'pi-agent-insight.ts'], contentType: 'text/plain; charset=utf-8' },
  'pi-trace-core.cjs': { path: ['pi-agent', 'lib', 'pi-trace-core.cjs'], contentType: 'text/javascript; charset=utf-8' },
  'self-check.cjs': { path: ['pi-agent', 'scripts', 'self-check.cjs'], contentType: 'text/javascript; charset=utf-8' },
  'uninstall.cjs': { path: ['pi-agent', 'scripts', 'uninstall.cjs'], contentType: 'text/javascript; charset=utf-8' },
  'install.cjs': { path: ['pi-agent', 'install.cjs'], contentType: 'text/javascript; charset=utf-8' },
  'trace-transport.cjs': { path: ['shared', 'trace-transport.cjs'], contentType: 'text/javascript; charset=utf-8' },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  const { asset } = await params;
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_ASSETS, asset)
    ? LEGACY_ASSETS[asset]
    : undefined;
  if (asset !== 'pi-agent-bundle.zip' && !legacy) {
    return NextResponse.json({ error: 'Unknown Pi Agent collector asset.' }, { status: 404 });
  }
  try {
    if (asset === 'pi-agent-bundle.zip') {
      const { buffer } = piAgentBundle();
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="pi-agent-bundle.zip"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const source = await readFile(path.join(ROOT, ...legacy!.path), 'utf8');
    return new NextResponse(source, {
      headers: {
        'Content-Type': legacy!.contentType,
        'Cache-Control': 'no-store',
        'Deprecation': 'true',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Pi Agent collector asset is unavailable.' }, { status: 500 });
  }
}
