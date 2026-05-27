'use client';

import { use } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import TrajectoryTraceView from '@/components/eval/TrajectoryTraceView';
import { Term } from '@/components/text/Term';

export default function TrajectoryTracePage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId: traceId } = use(params);
  return (
    <>
      <AppTopBar
        title={
          <>
            <Term id="trace" label="链路观测" />
            {` · ${traceId}`}
          </>
        }
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <TrajectoryTraceView traceId={traceId} />
      </div>
    </>
  );
}
