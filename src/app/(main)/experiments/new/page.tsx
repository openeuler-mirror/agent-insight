'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { ExperimentWizard } from '@/components/eval/ExperimentWizard';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';

function NewExperimentPageContent() {
  const searchParams = useSearchParams();
  return (
    <ExperimentWizard
      initialDatasetId={searchParams.get('datasetId') || ''}
      reuseFromExperimentId={searchParams.get('reuseFrom') || ''}
    />
  );
}

export default function NewExperimentPage() {
  return (
    <Suspense fallback={(
      <>
        <AppTopBar title="新建实验" />
        <PageContainer>
          <div style={{ color: 'var(--foreground-muted)', fontSize: 13 }}>正在加载实验配置…</div>
        </PageContainer>
      </>
    )}>
      <NewExperimentPageContent />
    </Suspense>
  );
}
