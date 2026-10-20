'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { InferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';

const InferenceAnalysisContext = createContext<InferenceAnalysisConfig>({ status: 'unconfigured' });

export function InferenceAnalysisProvider({ config, children }: { config: InferenceAnalysisConfig; children: ReactNode }) {
    return <InferenceAnalysisContext.Provider value={config}>{children}</InferenceAnalysisContext.Provider>;
}

export function useInferenceAnalysisConfig() {
    return useContext(InferenceAnalysisContext);
}
