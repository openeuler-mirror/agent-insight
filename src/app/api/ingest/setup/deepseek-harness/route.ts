import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { deepSeekHarnessPluginFiles } from './files';

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

function bashDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

export async function GET(request: Request) {
  const installerPath = path.join(
    process.cwd(),
    'scripts',
    'agent-trace-collectors',
    'deepseek-harness',
    'install.sh',
  );
  try {
    const source = await readFile(installerPath, 'utf8');
    const plugin = deepSeekHarnessPluginFiles();
    const digestByName = new Map(plugin.files.map((file) => [file.name, file.sha256]));
    const script = source
      .replaceAll('__AGENT_INSIGHT_BASE_URL__', bashDoubleQuoted(publicOrigin(request)))
      .replaceAll('__DEEPSEEK_HARNESS_SOURCE_SHA256__', plugin.sourceDigest)
      .replaceAll('__DEEPSEEK_HARNESS_PACKAGE_JSON_SHA256__', digestByName.get('package.json') || '')
      .replaceAll('__DEEPSEEK_HARNESS_INDEX_JS_SHA256__', digestByName.get('index.js') || '')
      .replaceAll('__DEEPSEEK_HARNESS_CORDIS_PATCH_SHA256__', digestByName.get('cordis.patch.yml') || '');
    return new NextResponse(script, {
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('DeepSeek Harness observability installer is unavailable.', {
      status: 500,
    });
  }
}
