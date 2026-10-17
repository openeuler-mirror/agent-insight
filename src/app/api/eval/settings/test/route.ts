import { getProxyConfig } from '@/lib/ingest/proxy-config';
import {
    getUserSettings,
    isMaskedApiKey,
    restoreMaskedHeaders,
} from '@/lib/storage/server-config';
import {
    normalizeCustomHeaders,
    supportsCustomHeaders,
} from '@/lib/shared/model-connection';
import { NextResponse } from 'next/server';
import { DEFAULT_MODEL_TEST_TIMEOUT_MS, ModelTestValidationError, resolveModelTestTimeoutMs } from '@/lib/shared/model-connection-test';
import { classifyModelTestError, probeModelConnection } from '@/lib/server/model-connection-test';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export async function POST(request: Request) {
    const startedAt = Date.now();
    let timeoutMs = DEFAULT_MODEL_TEST_TIMEOUT_MS;
    try {
        const body = await request.json();
        timeoutMs = resolveModelTestTimeoutMs(body.testTimeoutMs);
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
            throw new ModelTestValidationError('Custom headers require a Custom model');
        }
        try {
            resolvedHeaders = normalizeCustomHeaders(resolvedHeaders);
        } catch {
            throw new ModelTestValidationError('Invalid custom headers');
        }

        const { customFetch } = getProxyConfig();
        await probeModelConnection({
            provider,
            apiKey: resolvedKey,
            baseUrl: normalizedBaseUrl ||
                (provider === 'deepseek-official' || provider === 'deepseek' ? "https://api.deepseek.com" :
                 provider === 'siliconflow' ? "https://api.siliconflow.cn/v1" :
                 undefined),
            model: model ||
                (provider === 'deepseek-official' || provider === 'deepseek' ? 'deepseek-v4-flash' :
                 provider === 'siliconflow' ? 'deepseek-ai/DeepSeek-V3' : 'gpt-3.5-turbo'),
            headers: resolvedHeaders,
        }, { timeoutMs, signal: request.signal, fetch: customFetch });

        if (body.usageActive && body.user) {
            recordUsageEvent({ user: body.user, featureKey: 'model-registry', eventKey: 'model.test' });
        }
        return NextResponse.json({ success: true, elapsedMs: Date.now() - startedAt, timeoutMs });
    } catch (error: unknown) {
        const failure = classifyModelTestError(error);
        return NextResponse.json({
            success: false,
            code: failure.code,
            error: failure.error,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
        }, { status: failure.status });
    }
}
