'use client';

import { Suspense, use } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import TrajectoryDetailView from '@/components/eval/TrajectoryDetailView';

export default function TrajectoryDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId: traceId } = use(params);
  return (
    <>
      <AppTopBar title={`评测详情 · ${traceId}`} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <Suspense fallback={<div style={{ padding: 24 }}>加载中...</div>}>
          <TrajectoryDetailView traceId={traceId} />
        </Suspense>
      </div>
    </>
  );
}
