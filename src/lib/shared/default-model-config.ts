export interface DefaultModelConfig {
    id: string;
    name: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

export function loadDefaultModelConfigs(): DefaultModelConfig[] {
    const configs: DefaultModelConfig[] = [];
    let index = 1;
    
    while (true) {
        const name = process.env[`DEFAULT_MODEL_${index}_NAME`];
        const provider = process.env[`DEFAULT_MODEL_${index}_PROVIDER`];
        const apiKey = process.env[`DEFAULT_MODEL_${index}_API_KEY`];
        
        if (!name || !provider || !apiKey) {
            break;
        }
        
        configs.push({
            id: `default_${index}`,
            name,
            provider,
            apiKey,
            baseUrl: process.env[`DEFAULT_MODEL_${index}_BASE_URL`],
            model: process.env[`DEFAULT_MODEL_${index}_MODEL`]
        });
        
        index++;
    }
    
    return configs;
}
