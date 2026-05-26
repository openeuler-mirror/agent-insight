'use client';

import { use } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import EvaluationRunDetailView from '@/components/eval/EvaluationRunDetailView';
import { Term } from '@/components/text/Term';

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  return (
    <>
      <AppTopBar title={<Term id="eval-batch" label="评测批次" />} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <EvaluationRunDetailView runId={runId} />
      </div>
    </>
  );
}
