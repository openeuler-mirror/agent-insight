'use client';

import type { ReactNode } from 'react';
import { useEvaluationCatalog } from './useEvaluationCatalog';

export type EvaluationOverviewSource = ReturnType<typeof useEvaluationCatalog>;

export default function DemoOverview({ children }: { children: (source: EvaluationOverviewSource) => ReactNode }) {
    const source = useEvaluationCatalog();
    return children(source);
}
