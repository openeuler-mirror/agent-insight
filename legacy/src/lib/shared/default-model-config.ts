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

import { normalizeCustomHeaders, validateModelProtocol, type ModelProtocol } from './model-connection';

export interface DefaultModelConfig {
    id: string;
    name: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
    protocol?: ModelProtocol;
    headers?: Record<string, string>;
}

export function loadDefaultModelConfigs(): DefaultModelConfig[] {
    const configs: DefaultModelConfig[] = [];
    let index = 1;
    
    while (true) {
        const name = process.env[`DEFAULT_MODEL_${index}_NAME`];
        const provider = process.env[`DEFAULT_MODEL_${index}_PROVIDER`];
        const apiKey = process.env[`DEFAULT_MODEL_${index}_API_KEY`];
        
        if (!name || !provider) {
            break;
        }
        
        configs.push({
            id: `default_${index}`,
            name,
            provider,
            apiKey: apiKey ?? '',
            baseUrl: process.env[`DEFAULT_MODEL_${index}_BASE_URL`],
            model: process.env[`DEFAULT_MODEL_${index}_MODEL`],
            protocol: validateModelProtocol(process.env[`DEFAULT_MODEL_${index}_PROTOCOL`]),
            headers: process.env[`DEFAULT_MODEL_${index}_HEADERS`]
                ? normalizeCustomHeaders(JSON.parse(process.env[`DEFAULT_MODEL_${index}_HEADERS`]!)) : undefined,
        });
        
        index++;
    }
    
    return configs;
}
