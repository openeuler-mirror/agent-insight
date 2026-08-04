import { db } from '@/lib/storage/prisma';
import { loadDefaultModelConfigs } from '@/lib/shared/default-model-config';
import {
    normalizeCustomHeaders,
    supportsCustomHeaders,
} from '@/lib/shared/model-connection';

export interface ModelConfig {
    id: string;
    name: string;
    provider?: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
    headers?: Record<string, string>;
}

export interface UserSettings {
    activeConfigId: string | null;
    configs: ModelConfig[];
    autoEvaluationEnabled?: boolean;
    /** Playground 联网搜索供应商；当前只支持 Tavily */
    searchProvider?: 'tavily' | 'none';
    /** 联网搜索 API key（明文存 JSON blob，跟模型 apiKey 同等敏感度处理） */
    searchApiKey?: string;
}

/**
 * Sentinel character used to mask the middle of an API key in client-facing
 * responses. Real keys are ASCII (alphanumeric + -/_) and never contain it, so
 * its presence reliably marks a value as a masked placeholder — never a real key.
 */
const MASK_CHAR = '•';

/** True if `key` is a masked placeholder (must NOT be persisted as a real key). */
export function isMaskedApiKey(key: string | null | undefined): boolean {
    return typeof key === 'string' && key.includes(MASK_CHAR);
}

/**
 * Mask an API key for client rendering: keep the first/last 4 chars (enough to
 * verify which key is configured) and replace the middle with bullets. Short
 * keys are fully masked. Empty stays empty so "(未设置)" still renders.
 */
export function maskApiKey(key: string | null | undefined): string {
    if (!key) return '';
    if (key.length <= 8) return MASK_CHAR.repeat(8);
    return `${key.slice(0, 4)}${MASK_CHAR.repeat(8)}${key.slice(-4)}`;
}

export function restoreMaskedHeaders(
    incoming: Record<string, string> | null | undefined,
    existing: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
    if (!incoming) return undefined;
    const existingHeaderByLowerName = new Map(
        Object.entries(existing ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return Object.fromEntries(
        Object.entries(incoming).map(([name, value]) => [
            name,
            isMaskedApiKey(value)
                ? (existingHeaderByLowerName.get(name.toLowerCase()) ?? '')
                : value,
        ]),
    );
}

/**
 * Return a copy of settings with every model config's apiKey AND the web-search
 * apiKey masked. Use this for any client-facing response — the browser must
 * never receive a plaintext key.
 */
export function maskUserSettings(settings: UserSettings): UserSettings {
    return {
        ...settings,
        configs: settings.configs.map(c => ({
            ...c,
            apiKey: maskApiKey(c.apiKey),
            headers: c.headers
                ? Object.fromEntries(Object.entries(c.headers).map(([name, value]) => [name, maskApiKey(value)]))
                : undefined,
        })),
        searchApiKey: maskApiKey(settings.searchApiKey),
    };
}

export async function getActiveConfig(user?: string | null): Promise<ModelConfig | null> {
    const settings = await getUserSettings(user);
    if (!settings || !settings.activeConfigId) return null;
    return settings.configs.find(c => c.id === settings.activeConfigId) || null;
}

export async function getUserSettings(user?: string | null): Promise<UserSettings> {
    if (!user) {
        return { activeConfigId: null, configs: [], autoEvaluationEnabled: true };
    }

    const defaultConfigs = loadDefaultModelConfigs();

    let userConfigs: ModelConfig[] = [];
    let activeConfigId: string | null = null;
    let autoEvaluationEnabled = true;
    let searchProvider: 'tavily' | 'none' | undefined;
    let searchApiKey: string | undefined;

    try {
        const record = await db.findUserSettings(user);
        if (record?.settingsJson) {
            const settings = JSON.parse(record.settingsJson);
            userConfigs = settings.configs.filter((c: ModelConfig) => !c.id.startsWith('default_'));
            activeConfigId = settings.activeConfigId;
            if (typeof settings.autoEvaluationEnabled === 'boolean') {
                autoEvaluationEnabled = settings.autoEvaluationEnabled;
            }
            if (settings.searchProvider === 'tavily' || settings.searchProvider === 'none') {
                searchProvider = settings.searchProvider;
            }
            if (typeof settings.searchApiKey === 'string') {
                searchApiKey = settings.searchApiKey;
            }
        }
    } catch (e) {
        console.error('Failed to load user settings:', e);
    }

    const mergedConfigs = [...defaultConfigs, ...userConfigs];

    if (!activeConfigId || !mergedConfigs.find(c => c.id === activeConfigId)) {
        activeConfigId = defaultConfigs.length > 0 ? defaultConfigs[0].id : null;
    }

    return {
        activeConfigId,
        configs: mergedConfigs,
        autoEvaluationEnabled,
        searchProvider,
        searchApiKey,
    };
}

export async function saveUserSettings(user: string, settings: UserSettings): Promise<void> {
    // The client only ever receives masked keys (see maskUserSettings), so an
    // unchanged config round-trips back here with a masked apiKey. Restore the
    // stored original for those, so saving never clobbers a real key with a mask.
    const existing = await getUserSettings(user);
    const existingKeyById = new Map(existing.configs.map(c => [c.id, c.apiKey]));
    const existingHeadersById = new Map(existing.configs.map(c => [c.id, c.headers ?? {}]));
    const restoredConfigs = settings.configs.map(c => {
        const existingHeaders = existingHeadersById.get(c.id) ?? {};
        const restoredHeaders = restoreMaskedHeaders(c.headers, existingHeaders);
        if (restoredHeaders && !supportsCustomHeaders(c)) {
            throw new Error('Custom headers are only supported for Custom (OpenAI Compatible) models');
        }
        return {
            ...c,
            apiKey: isMaskedApiKey(c.apiKey) ? (existingKeyById.get(c.id) ?? '') : c.apiKey,
            headers: normalizeCustomHeaders(restoredHeaders),
        };
    });

    // Same protection for the web-search key: a masked value means "unchanged".
    const restoredSearchApiKey = isMaskedApiKey(settings.searchApiKey)
        ? (existing.searchApiKey ?? '')
        : (settings.searchApiKey ?? '');

    const userOnlyConfigs = restoredConfigs.filter((c: ModelConfig) => !c.id.startsWith('default_'));

    const settingsJson = JSON.stringify({
        activeConfigId: settings.activeConfigId,
        configs: userOnlyConfigs,
        autoEvaluationEnabled: settings.autoEvaluationEnabled ?? true,
        searchProvider: settings.searchProvider ?? 'none',
        searchApiKey: restoredSearchApiKey,
    });

    await db.upsertUserSettings(user, settingsJson);
}
