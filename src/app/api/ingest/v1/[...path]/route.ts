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

export const dynamic = 'force-dynamic';

/**
 * Universal Proxy - Simple Passthrough
 * 
 * This is kept for backward compatibility but is NO LONGER 
 * the primary capture mechanism. We now use native Plugins and Hooks.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ path: string[] }> }
) {
    const { path } = await params;
    const pathStr = path.join('/');
    
    // Choose upstream based on headers or path
    let targetBase = 'https://api.deepseek.com';
    if (pathStr.includes('messages') || request.headers.get('x-api-key')) {
        targetBase = 'https://api.anthropic.com';
    }

    const targetUrl = `${targetBase}/v1/${pathStr.replace(/^v1\//, '')}`;
    
    // Transparent headers clone
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('x-witty-api-key');

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: request.body as any,
            // @ts-expect-error duplex 是 Node fetch 流式上传选项，TS 的 RequestInit 类型尚未收录
            duplex: 'half'
        });

        return new Response(response.body, {
            status: response.status,
            headers: response.headers
        });
    } catch {
        return NextResponse.json({ error: 'Proxy fail' }, { status: 502 });
    }
}
