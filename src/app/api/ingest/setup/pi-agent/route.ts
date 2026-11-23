/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { piAgentBundle } from './bundle';

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

function bashDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

function powerShellDoubleQuoted(value: string): string {
  return value.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
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
    const origin = publicOrigin(request);
    const script = source
      .replaceAll(
        '__AGENT_INSIGHT_BASE_URL__',
        isWindows ? powerShellDoubleQuoted(origin) : bashDoubleQuoted(origin),
      )
      .replaceAll('__PI_AGENT_BUNDLE_SHA256__', piAgentBundle().sha256);
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
