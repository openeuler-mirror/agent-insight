import { db } from '@/lib/storage/prisma';
import { loadDefaultModelConfigs } from '@/lib/shared/default-model-config';

export interface ModelConfig {
    id: string;
    name: string;
    provider?: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
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
    const userOnlyConfigs = settings.configs.filter((c: ModelConfig) => !c.id.startsWith('default_'));

    const settingsJson = JSON.stringify({
        activeConfigId: settings.activeConfigId,
        configs: userOnlyConfigs,
        autoEvaluationEnabled: settings.autoEvaluationEnabled ?? true,
        searchProvider: settings.searchProvider ?? 'none',
        searchApiKey: settings.searchApiKey ?? '',
    });

    await db.upsertUserSettings(user, settingsJson);
}
