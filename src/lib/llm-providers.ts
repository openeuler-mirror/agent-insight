// LiteLLM-aligned catalog of LLM providers supported by the model registry.
// Only OpenAI-compatible chat endpoints are listed here; cloud-native providers
// such as AWS Bedrock / Google Vertex AI are intentionally omitted until a
// non-OAI test path is wired up.

export type LlmProviderCategory =
    | 'frontier'      // 主流闭源 SaaS（OpenAI / Anthropic / Google ...）
    | 'aggregator'    // 推理聚合 / 路由（OpenRouter / Together / Groq ...）
    | 'china'         // 国内厂商
    | 'selfhost';     // 本地 / 自部署

export interface LlmProvider {
    id: string;
    label: string;
    category: LlmProviderCategory;
    baseUrl: string;
    defaultModel: string;
    suggestedModels: string[];
    docsUrl?: string;
    /**
     * Whether this provider speaks OpenAI-compatible /chat/completions.
     * Currently always true — non-compatible providers are filtered out.
     */
    oaiCompat: boolean;
    /** Initial letters used for the avatar chip (fallback when logo fails to load). */
    initials: string;
    /**
     * Lobehub icon slug — resolved against
     * https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/<slug>.svg
     * If undefined or the request fails, the initials chip is rendered instead.
     */
    logoSlug?: string;
    /** Hint shown in the form sidebar. */
    note?: string;
}

/** CDN base — switch to a self-hosted mirror here if the internal network blocks jsDelivr. */
export const LOGO_CDN_BASE =
    'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons';

/**
 * Lobehub publishes two SVGs per brand:
 *  - `{slug}-color.svg` → hard-coded brand colors (Gemini gradient, Groq orange, …)
 *  - `{slug}.svg`       → uses `currentColor`, inherits the surrounding text color (renders mono)
 * We always prefer the colored variant and fall back to the plain one on 404.
 */
export function getProviderLogoUrl(
    slug: string | undefined,
    variant: 'color' | 'plain' = 'color',
): string | undefined {
    if (!slug) return undefined;
    const suffix = variant === 'color' ? '-color' : '';
    return `${LOGO_CDN_BASE}/${slug}${suffix}.svg`;
}

export const LLM_PROVIDERS: LlmProvider[] = [
    // ─────────────── Frontier ───────────────
    {
        id: 'openai',
        label: 'OpenAI',
        category: 'frontier',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        suggestedModels: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o3-mini', 'o4-mini'],
        docsUrl: 'https://platform.openai.com/docs/models',
        oaiCompat: true,
        initials: 'OA',
        logoSlug: 'openai',
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        category: 'frontier',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-sonnet-4-6',
        suggestedModels: [
            'claude-opus-4-7',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
            'claude-3-5-sonnet-latest',
        ],
        docsUrl: 'https://docs.anthropic.com/en/docs/models-overview',
        oaiCompat: true,
        initials: 'AN',
        logoSlug: 'anthropic',
        note: '使用 Anthropic OpenAI 兼容端点（/v1/messages 自动转换）。',
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        category: 'frontier',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.5-flash',
        suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
        docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
        oaiCompat: true,
        initials: 'GM',
        logoSlug: 'gemini',
        note: '走 Gemini OpenAI 兼容层（generativelanguage.googleapis.com）。',
    },
    {
        id: 'azure-openai',
        label: 'Azure OpenAI',
        category: 'frontier',
        baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai',
        defaultModel: 'gpt-4o',
        suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'],
        docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/reference',
        oaiCompat: true,
        initials: 'AZ',
        logoSlug: 'azure',
        note: 'Base URL 形如 https://<resource>.openai.azure.com/openai/deployments/<deployment>',
    },
    {
        id: 'xai',
        label: 'xAI Grok',
        category: 'frontier',
        baseUrl: 'https://api.x.ai/v1',
        defaultModel: 'grok-3',
        suggestedModels: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-2-1212', 'grok-2-vision-1212'],
        docsUrl: 'https://docs.x.ai/api',
        oaiCompat: true,
        initials: 'GR',
        logoSlug: 'grok',
    },
    {
        id: 'mistral',
        label: 'Mistral AI',
        category: 'frontier',
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: 'mistral-large-latest',
        suggestedModels: ['mistral-large-latest', 'mistral-large-2411', 'mistral-small-latest', 'codestral-2501', 'open-mistral-nemo'],
        docsUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
        oaiCompat: true,
        initials: 'MI',
        logoSlug: 'mistral',
    },
    {
        id: 'cohere',
        label: 'Cohere',
        category: 'frontier',
        baseUrl: 'https://api.cohere.ai/compatibility/v1',
        defaultModel: 'command-r-plus',
        suggestedModels: ['command-r-plus', 'command-r', 'command-r7b'],
        docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
        oaiCompat: true,
        initials: 'CO',
        logoSlug: 'cohere',
    },

    // ─────────────── Inference Aggregators ───────────────
    {
        id: 'openrouter',
        label: 'OpenRouter',
        category: 'aggregator',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-4o-mini',
        suggestedModels: [
            'anthropic/claude-3.5-sonnet',
            'openai/gpt-4o',
            'meta-llama/llama-3.3-70b-instruct',
            'google/gemini-2.0-flash-exp:free',
        ],
        docsUrl: 'https://openrouter.ai/docs',
        oaiCompat: true,
        initials: 'OR',
        logoSlug: 'openrouter',
    },
    {
        id: 'together',
        label: 'Together AI',
        category: 'aggregator',
        baseUrl: 'https://api.together.xyz/v1',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        suggestedModels: [
            'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            'deepseek-ai/DeepSeek-V3',
            'Qwen/Qwen2.5-72B-Instruct-Turbo',
        ],
        docsUrl: 'https://docs.together.ai/docs/quickstart',
        oaiCompat: true,
        initials: 'TG',
        logoSlug: 'together',
    },
    {
        id: 'fireworks',
        label: 'Fireworks AI',
        category: 'aggregator',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        suggestedModels: [
            'accounts/fireworks/models/llama-v3p3-70b-instruct',
            'accounts/fireworks/models/deepseek-v3',
            'accounts/fireworks/models/qwen2p5-72b-instruct',
        ],
        docsUrl: 'https://docs.fireworks.ai',
        oaiCompat: true,
        initials: 'FW',
        logoSlug: 'fireworks',
    },
    {
        id: 'groq',
        label: 'Groq',
        category: 'aggregator',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        docsUrl: 'https://console.groq.com/docs/models',
        oaiCompat: true,
        initials: 'GQ',
        logoSlug: 'groq',
    },
    {
        id: 'deepinfra',
        label: 'DeepInfra',
        category: 'aggregator',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
        suggestedModels: [
            'meta-llama/Meta-Llama-3.1-70B-Instruct',
            'deepseek-ai/DeepSeek-V3',
            'Qwen/Qwen2.5-72B-Instruct',
        ],
        docsUrl: 'https://deepinfra.com/docs',
        oaiCompat: true,
        initials: 'DI',
        logoSlug: 'deepinfra',
    },
    {
        id: 'perplexity',
        label: 'Perplexity',
        category: 'aggregator',
        baseUrl: 'https://api.perplexity.ai',
        defaultModel: 'sonar',
        suggestedModels: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
        docsUrl: 'https://docs.perplexity.ai',
        oaiCompat: true,
        initials: 'PX',
        logoSlug: 'perplexity',
    },
    {
        id: 'nvidia',
        label: 'NVIDIA NIM',
        category: 'aggregator',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.3-70b-instruct',
        suggestedModels: [
            'meta/llama-3.3-70b-instruct',
            'deepseek-ai/deepseek-r1',
            'nvidia/llama-3.1-nemotron-70b-instruct',
        ],
        docsUrl: 'https://docs.api.nvidia.com',
        oaiCompat: true,
        initials: 'NV',
        logoSlug: 'nvidia',
    },
    {
        id: 'databricks',
        label: 'Databricks',
        category: 'aggregator',
        baseUrl: 'https://YOUR-WORKSPACE.cloud.databricks.com/serving-endpoints',
        defaultModel: 'databricks-meta-llama-3-3-70b-instruct',
        suggestedModels: ['databricks-meta-llama-3-3-70b-instruct', 'databricks-dbrx-instruct'],
        docsUrl: 'https://docs.databricks.com/aws/en/machine-learning/foundation-models/api-reference',
        oaiCompat: true,
        initials: 'DB',
        logoSlug: 'databricks',
        note: 'Base URL 形如 https://<workspace>.cloud.databricks.com/serving-endpoints',
    },
    {
        id: 'novita',
        label: 'Novita AI',
        category: 'aggregator',
        baseUrl: 'https://api.novita.ai/v3/openai',
        defaultModel: 'meta-llama/llama-3.3-70b-instruct',
        suggestedModels: ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct'],
        docsUrl: 'https://novita.ai/docs/api-reference',
        oaiCompat: true,
        initials: 'NV',
        logoSlug: 'novita',
    },
    {
        id: 'hyperbolic',
        label: 'Hyperbolic',
        category: 'aggregator',
        baseUrl: 'https://api.hyperbolic.xyz/v1',
        defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
        suggestedModels: ['meta-llama/Meta-Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
        docsUrl: 'https://docs.hyperbolic.xyz',
        oaiCompat: true,
        initials: 'HY',
        logoSlug: 'hyperbolic',
    },

    // ─────────────── China / 国内厂商 ───────────────
    {
        id: 'deepseek-official',
        label: 'DeepSeek (Official)',
        category: 'china',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        suggestedModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.1'],
        docsUrl: 'https://api-docs.deepseek.com',
        oaiCompat: true,
        initials: 'DS',
        logoSlug: 'deepseek',
    },
    {
        id: 'siliconflow',
        label: 'SiliconFlow / 硅基流动',
        category: 'china',
        baseUrl: 'https://api.siliconflow.cn/v1',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        suggestedModels: [
            'deepseek-ai/DeepSeek-V3',
            'deepseek-ai/DeepSeek-R1',
            'Qwen/Qwen2.5-72B-Instruct',
            'meta-llama/Meta-Llama-3.1-70B-Instruct',
        ],
        docsUrl: 'https://docs.siliconflow.cn',
        oaiCompat: true,
        initials: 'SF',
        logoSlug: 'siliconcloud',
    },
    {
        id: 'moonshot',
        label: 'Moonshot / Kimi',
        category: 'china',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'kimi-latest',
        suggestedModels: ['kimi-k2', 'kimi-latest', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
        docsUrl: 'https://platform.moonshot.cn/docs',
        oaiCompat: true,
        initials: 'MK',
        logoSlug: 'moonshot',
    },
    {
        id: 'zhipu',
        label: 'Zhipu GLM / 智谱',
        category: 'china',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-4.5',
        suggestedModels: ['glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-long', 'glm-4-flash'],
        docsUrl: 'https://bigmodel.cn/dev/api',
        oaiCompat: true,
        initials: 'ZP',
        logoSlug: 'zhipu',
    },
    {
        id: 'doubao',
        label: 'Doubao / 火山方舟',
        category: 'china',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultModel: 'doubao-1.5-pro-32k',
        suggestedModels: ['doubao-1.5-pro-32k', 'doubao-1.5-pro-256k', 'doubao-pro-32k', 'doubao-lite-32k'],
        docsUrl: 'https://www.volcengine.com/docs/82379',
        oaiCompat: true,
        initials: 'DB',
        logoSlug: 'doubao',
        note: '模型名通常是火山方舟"接入点 ID"，不是发布的模型名。',
    },
    {
        id: 'qwen',
        label: 'Tongyi Qwen / 通义千问',
        category: 'china',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen-plus',
        suggestedModels: ['qwen3-max', 'qwen3-plus', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct'],
        docsUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api',
        oaiCompat: true,
        initials: 'QW',
        logoSlug: 'qwen',
    },
    {
        id: 'hunyuan',
        label: 'Tencent Hunyuan / 腾讯混元',
        category: 'china',
        baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
        defaultModel: 'hunyuan-pro',
        suggestedModels: ['hunyuan-turbo', 'hunyuan-pro', 'hunyuan-standard', 'hunyuan-lite'],
        docsUrl: 'https://cloud.tencent.com/document/product/1729/97732',
        oaiCompat: true,
        initials: 'HY',
        logoSlug: 'hunyuan',
    },
    {
        id: 'yi',
        label: '01.AI Yi / 零一万物',
        category: 'china',
        baseUrl: 'https://api.lingyiwanwu.com/v1',
        defaultModel: 'yi-large',
        suggestedModels: ['yi-large', 'yi-large-turbo', 'yi-medium', 'yi-vision'],
        docsUrl: 'https://platform.lingyiwanwu.com/docs',
        oaiCompat: true,
        initials: 'YI',
        logoSlug: 'yi',
    },
    {
        id: 'modelscope',
        label: 'ModelScope / 魔搭',
        category: 'china',
        baseUrl: 'https://api-inference.modelscope.cn/v1',
        defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
        suggestedModels: [
            'Qwen/Qwen2.5-72B-Instruct',
            'deepseek-ai/DeepSeek-V3',
            'meta-llama/Llama-3.3-70B-Instruct',
        ],
        docsUrl: 'https://modelscope.cn/docs/model-service/API-Inference',
        oaiCompat: true,
        initials: 'MS',
        logoSlug: 'modelscope',
    },
    {
        id: 'ppio',
        label: 'PPIO / 派欧云',
        category: 'china',
        baseUrl: 'https://api.ppinfra.com/v3/openai',
        defaultModel: 'deepseek/deepseek-v3',
        suggestedModels: [
            'deepseek/deepseek-v3',
            'deepseek/deepseek-r1',
            'qwen/qwen2.5-72b-instruct',
            'meta-llama/llama-3.3-70b-instruct',
        ],
        docsUrl: 'https://ppinfra.com/docs',
        oaiCompat: true,
        initials: 'PP',
        logoSlug: 'ppio',
    },
    {
        id: 'baidu',
        label: 'Baidu Qianfan / 文心一言',
        category: 'china',
        baseUrl: 'https://qianfan.baidubce.com/v2',
        defaultModel: 'ernie-4.0-8k',
        suggestedModels: ['ernie-4.0-8k', 'ernie-4.0-turbo-8k', 'ernie-3.5-8k'],
        docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/index.html',
        oaiCompat: true,
        initials: 'BD',
        logoSlug: 'wenxin',
    },
    {
        id: 'minimax',
        label: 'MiniMax',
        category: 'china',
        baseUrl: 'https://api.minimax.chat/v1',
        defaultModel: 'abab6.5s-chat',
        suggestedModels: ['abab6.5s-chat', 'abab6.5-chat', 'minimax-text-01'],
        docsUrl: 'https://platform.minimaxi.com/document/algorithm-concept',
        oaiCompat: true,
        initials: 'MM',
        logoSlug: 'minimax',
    },
    {
        id: 'stepfun',
        label: 'Stepfun / 阶跃星辰',
        category: 'china',
        baseUrl: 'https://api.stepfun.com/v1',
        defaultModel: 'step-1-8k',
        suggestedModels: ['step-1-8k', 'step-1-32k', 'step-2-16k'],
        docsUrl: 'https://platform.stepfun.com/docs',
        oaiCompat: true,
        initials: 'ST',
        logoSlug: 'stepfun',
    },

    // ─────────────── Self-hosted ───────────────
    {
        id: 'ollama',
        label: 'Ollama',
        category: 'selfhost',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'llama3.3',
        suggestedModels: ['llama3.3', 'qwen2.5', 'deepseek-r1', 'mistral'],
        docsUrl: 'https://ollama.com/library',
        oaiCompat: true,
        initials: 'OL',
        logoSlug: 'ollama',
        note: '本地 Ollama 通常无需 API Key，留空即可。',
    },
    {
        id: 'vllm',
        label: 'vLLM',
        category: 'selfhost',
        baseUrl: 'http://localhost:8000/v1',
        defaultModel: 'meta-llama/Meta-Llama-3-8B-Instruct',
        suggestedModels: ['meta-llama/Meta-Llama-3-8B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'],
        docsUrl: 'https://docs.vllm.ai/en/stable/serving/openai_compatible_server.html',
        oaiCompat: true,
        initials: 'VL',
        logoSlug: 'vllm',
        note: 'vLLM 默认以 OpenAI 兼容模式启动，API Key 任意字符串即可。',
    },
    {
        id: 'lmstudio',
        label: 'LM Studio',
        category: 'selfhost',
        baseUrl: 'http://localhost:1234/v1',
        defaultModel: 'local-model',
        suggestedModels: ['local-model'],
        docsUrl: 'https://lmstudio.ai/docs/local-server',
        oaiCompat: true,
        initials: 'LM',
        logoSlug: 'lmstudio',
        note: '在 LM Studio 中开启 "Local Inference Server"，端口默认 1234。',
    },
    {
        id: 'tgi',
        label: 'Text Generation Inference (TGI)',
        category: 'selfhost',
        baseUrl: 'http://localhost:8080/v1',
        defaultModel: 'tgi',
        suggestedModels: ['tgi'],
        docsUrl: 'https://huggingface.co/docs/text-generation-inference/messages_api',
        oaiCompat: true,
        initials: 'TG',
        logoSlug: 'huggingface',
    },
    {
        id: 'xinference',
        label: 'Xinference',
        category: 'selfhost',
        baseUrl: 'http://localhost:9997/v1',
        defaultModel: 'qwen2.5-instruct',
        suggestedModels: ['qwen2.5-instruct', 'llama-3.3-instruct', 'deepseek-r1-distill-qwen'],
        docsUrl: 'https://inference.readthedocs.io/en/latest/models/builtin/llm.html',
        oaiCompat: true,
        initials: 'XI',
        logoSlug: 'xinference',
        note: '通过模型 UID 接入 Xinference 本地实例。',
    },
    {
        id: 'localai',
        label: 'LocalAI',
        category: 'selfhost',
        baseUrl: 'http://localhost:8080/v1',
        defaultModel: 'gpt-3.5-turbo',
        suggestedModels: ['gpt-3.5-turbo'],
        docsUrl: 'https://localai.io',
        oaiCompat: true,
        initials: 'LA',
        logoSlug: 'localai',
        note: 'OpenAI 兼容的本地推理网关，模型名按本地配置填写。',
    },
    {
        id: 'custom',
        label: 'Custom (OpenAI Compatible)',
        category: 'selfhost',
        baseUrl: '',
        defaultModel: '',
        suggestedModels: [],
        oaiCompat: true,
        initials: 'CU',
        note: '任何兼容 OpenAI /v1/chat/completions 协议的端点。',
    },
];

export const PROVIDER_INDEX: Record<string, LlmProvider> = LLM_PROVIDERS.reduce(
    (acc, p) => {
        acc[p.id] = p;
        return acc;
    },
    {} as Record<string, LlmProvider>,
);

export function getProvider(id: string | undefined | null): LlmProvider | undefined {
    if (!id) return undefined;
    return PROVIDER_INDEX[id];
}

/**
 * Resolve the catalog entry for a stored EvalConfigItem:
 * - direct hit when provider id matches a catalog id (openai/anthropic/deepseek-official/siliconflow)
 * - otherwise look up by Base URL prefix (for `custom` entries originally picked from the catalog)
 */
export function resolveCatalogProvider(
    storedProvider: string,
    baseUrl?: string,
): LlmProvider | undefined {
    const direct = PROVIDER_INDEX[storedProvider];
    if (direct) return direct;
    if (!baseUrl) return undefined;
    const normalized = baseUrl.replace(/\/+$/, '').toLowerCase();
    return LLM_PROVIDERS.find(p => {
        if (!p.baseUrl) return false;
        const pu = p.baseUrl.replace(/\/+$/, '').toLowerCase();
        return normalized === pu || normalized.startsWith(pu);
    });
}

export interface CategoryMeta {
    id: LlmProviderCategory;
    labelZh: string;
    labelEn: string;
}

export const CATEGORY_ORDER: CategoryMeta[] = [
    { id: 'frontier',   labelZh: '主流闭源 SaaS', labelEn: 'Frontier SaaS' },
    { id: 'aggregator', labelZh: '推理聚合 / 路由', labelEn: 'Inference Aggregators' },
    { id: 'china',      labelZh: '国内厂商',       labelEn: 'China Providers' },
    { id: 'selfhost',   labelZh: '本地 / 自部署',   labelEn: 'Self-hosted' },
];
