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

// Serves the JiuwenSwarm observability extension entry script. The setup bash/
// PowerShell installer curls this into
// <workspace>/extensions/agent-insight-observability/extension.py.
// Source of truth: scripts/jiuwen_extension/extension.py
export async function GET() {
    const extPath = path.join(process.cwd(), 'scripts', 'jiuwen_extension', 'extension.py');

    try {
        const source = await readFile(extPath, 'utf8');
        return new NextResponse(source, {
            headers: {
                'Content-Type': 'text/x-python; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new NextResponse('JiuwenSwarm extension source is unavailable.', { status: 500 });
    }
}
