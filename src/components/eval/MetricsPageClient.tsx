'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import EvaluatorsCenter from '@/components/EvaluatorsCenter';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { SingleExecutionMetrics } from '@/components/eval/SingleExecutionMetrics';
import { useLocale } from '@/lib/client/locale-context';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { Term } from '@/components/text/Term';

export default function MetricsPageClient({ benchmarkEvaluatorCards }: {
  benchmarkEvaluatorCards: EvaluatorCard[];
}) {
  return (
    <Suspense fallback={null}>
      <MetricsPageInner benchmarkEvaluatorCards={benchmarkEvaluatorCards} />
    </Suspense>
  );
}

function MetricsPageInner({ benchmarkEvaluatorCards }: { benchmarkEvaluatorCards: EvaluatorCard[] }) {
  const { t, locale } = useLocale();
  const search = useSearchParams();
  const taskId = search?.get('taskId') || '';

  if (taskId) {
    return (
      <>
        <AppTopBar
          title={
            <>
              <Term id="evaluator" label={t('nav.evalMetrics')} />
              {` · ${locale === 'zh' ? '单次执行' : 'Single execution'}`}
            </>
          }
        />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SingleExecutionMetrics taskId={taskId} />
        </div>
      </>
    );
  }

  return (
    <>
      <AppTopBar title={<Term id="evaluator" label={t('nav.evalMetrics')} />} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <EvaluatorsCenter benchmarkEvaluatorCards={benchmarkEvaluatorCards} />
      </div>
    </>
  );
}
