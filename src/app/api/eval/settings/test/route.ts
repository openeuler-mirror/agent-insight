import { getProxyConfig } from '@/lib/ingest/proxy-config';
import {
    getUserSettings,
    isMaskedApiKey,
    restoreMaskedHeaders,
} from '@/lib/storage/server-config';
import {
    getOpenAICompatibleClientConfig,
    normalizeCustomHeaders,
    supportsCustomHeaders,
} from '@/lib/shared/model-connection';
import { NextResponse } from 'next/server';
import { OpenAI } from "openai";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const apiKey = body.apiKey || body.evalApiKey;
        const provider = body.provider || body.evalProvider;
        const model = body.model || body.evalModel;
        const requestedHeaders = body.headers as Record<string, string> | undefined;

        const baseUrl = body.baseUrl || body.evalBaseUrl;
        let normalizedBaseUrl = baseUrl;
        if (normalizedBaseUrl) {
            // Normalize: strip /chat/completions if user pasted full endpoint
            // Keep /v1 suffix as it's required by many OpenAI-compatible APIs
            normalizedBaseUrl = normalizedBaseUrl.replace(/\/chat\/completions\/?$/, '');
        }

        // The client only holds masked keys for already-saved configs. When it
        // tests one without re-typing the key, resolve the real key server-side
        // from the stored config (identified by user + configId).
        let resolvedKey = apiKey;
        if ((!resolvedKey || isMaskedApiKey(resolvedKey)) && body.user && body.configId) {
            const settings = await getUserSettings(body.user);
            const stored = settings.configs.find((c) => c.id === body.configId)?.apiKey;
            if (stored) resolvedKey = stored;
        }
        // Never send a mask sentinel to the provider; treat unresolved masks as empty.
        if (isMaskedApiKey(resolvedKey)) resolvedKey = '';

        let resolvedHeaders = requestedHeaders;
        if (requestedHeaders && body.user && body.configId) {
            const settings = await getUserSettings(body.user);
            const storedHeaders = settings.configs.find((c) => c.id === body.configId)?.headers ?? {};
            resolvedHeaders = restoreMaskedHeaders(requestedHeaders, storedHeaders);
        }
        if (resolvedHeaders && !supportsCustomHeaders({ provider })) {
            return NextResponse.json(
                { success: false, error: 'Custom headers are only supported for Custom (OpenAI Compatible) models' },
                { status: 400 },
            );
        }
        resolvedHeaders = normalizeCustomHeaders(resolvedHeaders);

        const { customFetch } = getProxyConfig();
        const connection = getOpenAICompatibleClientConfig({
            provider,
            apiKey: resolvedKey,
            baseUrl: normalizedBaseUrl ||
                (provider === 'deepseek-official' || provider === 'deepseek' ? "https://api.deepseek.com" :
                 provider === 'siliconflow' ? "https://api.siliconflow.cn/v1" :
                 undefined),
            model,
            headers: resolvedHeaders,
        });

        const client = new OpenAI({
             ...connection,
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
