'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import TrajectoryEvalCenter from '@/components/eval/TrajectoryEvalCenter';

export default function TrajectoryEvalPage() {
  const router = useRouter();

  return (
    <>
      <AppTopBar title="发起新评测" showDefaultActions={false} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '10px 16px 0' }}>
          <button
            type="button"
            onClick={() => router.push('/eval')}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--background)',
              color: 'var(--foreground)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {'< 返回评测执行'}
          </button>
        </div>
        <Suspense fallback={<div>Loading...</div>}>
          <TrajectoryEvalCenter />
        </Suspense>
      </div>
    </>
  );
}
