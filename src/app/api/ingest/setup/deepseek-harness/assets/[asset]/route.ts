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

import { NextResponse } from 'next/server';

import { deepSeekHarnessPluginFile } from '../../files';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  try {
    const { asset } = await params;
    const file = deepSeekHarnessPluginFile(asset);
    if (!file) {
      return NextResponse.json({ error: 'DeepSeek Harness plugin file not found' }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Agent-Insight-SHA256': file.sha256,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'DeepSeek Harness plugin files are unavailable' },
      { status: 500 },
    );
  }
}
