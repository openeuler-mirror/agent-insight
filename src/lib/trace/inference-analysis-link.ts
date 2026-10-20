export type InferenceAnalysisConfig =
    | { status: 'ready'; origin: string }
    | { status: 'unconfigured' | 'invalid' };

export function resolveInferenceAnalysisConfig(raw?: string | null): InferenceAnalysisConfig {
    const value = raw?.trim();
    if (!value) return { status: 'unconfigured' };
    if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) return { status: 'invalid' };
    try {
        const url = new URL(value);
        if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return { status: 'invalid' };
        return { status: 'ready', origin: url.origin };
    } catch {
        return { status: 'invalid' };
    }
}

export function buildInferenceAnalysisUrl(config: InferenceAnalysisConfig, callId?: string | null): string | undefined {
    if (config.status !== 'ready' || !callId?.trim()) return undefined;
    const resolved = resolveInferenceAnalysisConfig(config.origin);
    if (resolved.status !== 'ready') return undefined;
    const url = new URL('/model-performance', resolved.origin);
    url.searchParams.set('GlobalTrackNO', callId);
    return url.href;
}
