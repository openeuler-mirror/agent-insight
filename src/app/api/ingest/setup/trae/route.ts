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

export async function GET() {
    const vsixPath = path.join(process.cwd(), 'scripts', 'trae-collector', 'agent-insight-trae-collector-0.1.0.vsix');

    try {
        const buffer = await readFile(vsixPath);
        return new NextResponse(buffer, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': 'attachment; filename="agent-insight-trae-collector-0.1.0.vsix"',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        // Fallback: return setup instructions as JSON
        return NextResponse.json({
            framework: 'trae',
            name: 'Trae IDE',
            version: '0.1.0',
            install_steps: [
                '1. 下载 VSIX 文件后，打开 TRAE IDE',
                '2. 点击左侧 插件市场 图标',
                '3. 点击右上角 ··· > 从 VSIX 安装',
                '4. 选择下载的 agent-insight-trae-collector-0.1.0.vsix',
                '5. 重启 TRAE IDE',
                '6. Ctrl+Shift+, 打开设置 → 搜索 Agent Insight → 填入 Host 和 API Key',
            ],
            hook_install: '插件激活时自动部署 Hook 脚本到 ~/.agent-insight/trae-hooks/',
            config: {
                AGENT_INSIGHT_HOST: '${host}',
                AGENT_INSIGHT_API_KEY: '${apiKey}',
            },
        });
    }
}
