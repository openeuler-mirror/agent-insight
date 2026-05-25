import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { NextResponse } from 'next/server';
import { OpenAI } from "openai";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const apiKey = body.apiKey || body.evalApiKey;
        const provider = body.provider || body.evalProvider;
        const model = body.model || body.evalModel;
        
        const baseUrl = body.baseUrl || body.evalBaseUrl;
        let normalizedBaseUrl = baseUrl;
        if (normalizedBaseUrl) {
            // Normalize: strip /chat/completions if user pasted full endpoint
            // Keep /v1 suffix as it's required by many OpenAI-compatible APIs
            normalizedBaseUrl = normalizedBaseUrl.replace(/\/chat\/completions\/?$/, '');
        }

        // Allow empty API Key for services that don't require authentication
        // Use a placeholder if not provided
        const finalApiKey = apiKey || 'no-api-key-required';

        const { customFetch } = getProxyConfig();

        const client = new OpenAI({
             apiKey: finalApiKey,
             baseURL: normalizedBaseUrl ||
                      (provider === 'deepseek-official' || provider === 'deepseek' ? "https://api.deepseek.com" :
                       provider === 'siliconflow' ? "https://api.siliconflow.cn/v1" :
                       undefined),
             fetch: customFetch,
             timeout: 10000
        });

        const completion = await client.chat.completions.create({
            messages: [{ role: "user", content: "Hi" }],
            model: model ||
                   (provider === 'deepseek-official' || provider === 'deepseek' ? "deepseek-chat" :
                    provider === 'siliconflow' ? "deepseek-ai/DeepSeek-V3" :
                    "gpt-3.5-turbo"),
            max_tokens: 5
        });

        if (completion && completion.choices) {
             return NextResponse.json({ success: true, message: 'Connection successful' });
        } else {
             throw new Error('No response from model');
        }

    } catch (e: any) {
        console.error("Test Route Error:", e);
        const detail = e.cause ? ` (Cause: ${e.cause.message || e.cause})` : '';
        return NextResponse.json({ 
            success: false, 
            error: (e.message || 'Connection failed') + detail
        }, { status: 500 });
    }
}
