import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

const ROOT = path.join(process.cwd(), 'scripts', 'agent-trace-collectors');
const ASSETS: Record<string, { path: string[]; contentType: string }> = {
  'trace-transport.cjs': {
    path: ['shared', 'trace-transport.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'codex-trace-core.cjs': {
    path: ['codex', 'codex-trace-core.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'config-core.cjs': {
    path: ['codex', 'config-core.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'hook-handler.cjs': {
    path: ['codex', 'hook-handler.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'relay.cjs': {
    path: ['codex', 'relay.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'install.cjs': {
    path: ['codex', 'install.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'uninstall.cjs': {
    path: ['codex', 'uninstall.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'self-check.cjs': {
    path: ['codex', 'self-check.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'build-vsix.cjs': {
    path: ['codex', 'build-vsix.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'extension-package.json': {
    path: ['codex', 'vscode-extension', 'package.json'],
    contentType: 'application/json; charset=utf-8',
  },
  'extension.cjs': {
    path: ['codex', 'vscode-extension', 'extension.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'ide-trace-core.cjs': {
    path: ['codex', 'vscode-extension', 'ide-trace-core.cjs'],
    contentType: 'text/javascript; charset=utf-8',
  },
  'extension.vsixmanifest': {
    path: ['codex', 'vscode-extension', 'extension.vsixmanifest'],
    contentType: 'application/xml; charset=utf-8',
  },
  'Content_Types.xml': {
    path: ['codex', 'vscode-extension', '[Content_Types].xml'],
    contentType: 'application/xml; charset=utf-8',
  },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  const { asset } = await params;
  const descriptor = ASSETS[asset];
  if (!descriptor) {
    return NextResponse.json({ error: 'Unknown Codex collector asset.' }, { status: 404 });
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
    return NextResponse.json({ error: 'Codex collector asset is unavailable.' }, { status: 500 });
  }
}
