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

// The curl installer needs the collector as a small group of ES modules.  Keep
// this endpoint explicitly allow-listed so it cannot expose arbitrary files
// from the Agent Insight installation.
const collectorFiles = new Set([
  'configure.mjs',
  'install.mjs',
]);

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!collectorFiles.has(file)) {
    return NextResponse.json({ error: 'Collector file not found' }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), 'scripts', 'qwencode-collector', file);
  try {
    const content = await readFile(filePath, 'utf8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Qwen Code collector is unavailable' }, { status: 404 });
  }
}
