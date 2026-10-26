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


import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

function buildPluginArtifact(source: string): string {
    // OpenCode 1.18.14 会把模块的每个运行时导出都当作插件工厂调用。
    return source.replace(/^export function /gm, 'function ');
}

export async function GET() {
    const filePath = path.join(process.cwd(), 'scripts', 'opencode_plugin_otel.ts');
    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }
    const content = buildPluginArtifact(fs.readFileSync(filePath, 'utf-8'));
    return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain' }
    });
}
