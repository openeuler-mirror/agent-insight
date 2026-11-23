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

// WorkBuddy 一键安装脚本需要下载这一小组采集器文件。显式白名单，
// 避免暴露安装目录里的任意文件。key 是下载文件名，value 是仓库内真实路径。
const collectorFiles = new Map<string, string>([
  ['workbuddy_setup.mjs', path.join('scripts', 'workbuddy_setup.mjs')],
  ['collector.mjs', path.join('scripts', 'workbuddy-collector', 'collector.mjs')],
  ['session-registry.mjs', path.join('scripts', 'workbuddy-collector', 'session-registry.mjs')],
  ['mapper.cjs', path.join('scripts', 'workbuddy-collector', 'mapper.cjs')],
  ['sdk-log.cjs', path.join('scripts', 'workbuddy-collector', 'sdk-log.cjs')],
  ['trace-transport.cjs', path.join('scripts', 'agent-trace-collectors', 'shared', 'trace-transport.cjs')],
]);

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const relative = collectorFiles.get(file);
  if (!relative) {
    return NextResponse.json({ error: 'Collector file not found' }, { status: 404 });
  }

  try {
    const content = await readFile(path.join(process.cwd(), relative), 'utf8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'WorkBuddy collector is unavailable' }, { status: 404 });
  }
}
