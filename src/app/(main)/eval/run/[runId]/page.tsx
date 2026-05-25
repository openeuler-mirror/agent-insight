'use client';

import { use } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import EvaluationRunDetailView from '@/components/eval/EvaluationRunDetailView';

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  return (
    <>
      <AppTopBar title="评测批次" />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <EvaluationRunDetailView runId={runId} />
      </div>
    </>
  );
}
