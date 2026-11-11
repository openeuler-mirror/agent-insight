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

'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { InferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';

const InferenceAnalysisContext = createContext<InferenceAnalysisConfig | undefined>(undefined);

export function InferenceAnalysisProvider({ config, children }: { config: InferenceAnalysisConfig; children: ReactNode }) {
    return <InferenceAnalysisContext.Provider value={config}>{children}</InferenceAnalysisContext.Provider>;
}

export function useInferenceAnalysisConfig() {
    return useContext(InferenceAnalysisContext) ?? { status: 'unconfigured' } as InferenceAnalysisConfig;
}

export function useInferenceAnalysisAvailable() {
    return useContext(InferenceAnalysisContext) !== undefined;
}
