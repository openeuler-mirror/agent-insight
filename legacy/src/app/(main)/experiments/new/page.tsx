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
