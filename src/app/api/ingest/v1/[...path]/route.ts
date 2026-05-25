
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
            // @ts-ignore
            duplex: 'half'
        });

        return new Response(response.body, {
            status: response.status,
            headers: response.headers
        });
    } catch (err) {
        return NextResponse.json({ error: 'Proxy fail' }, { status: 502 });
    }
}
