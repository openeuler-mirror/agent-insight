'use client';

import { use } from 'react';

import { ExperimentCaseDetail } from '@/components/eval/ExperimentCaseDetail';

export default function TraceEvalDetailPage({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  const { id, caseId } = use(params);
  return <ExperimentCaseDetail id={id} caseId={caseId} />;
}
