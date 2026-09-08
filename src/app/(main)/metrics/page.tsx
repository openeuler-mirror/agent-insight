'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import DemoEvaluators from '@/components/evaluation-harness/DemoEvaluators';
import EvaluationWorkspace from '@/components/evaluation-harness/Workspace';
import EvaluatorsCenter from '@/components/EvaluatorsCenter';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { SingleExecutionMetrics } from '@/components/eval/SingleExecutionMetrics';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

function LegacyMetricsPage() {
  return (
    <Suspense fallback={null}>
      <MetricsPageInner />
    </Suspense>
  );
}

function MetricsPageInner() {
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
        <EvaluatorsCenter />
        <details className="m-5 rounded-lg border border-border p-4"><summary>版本化业务评估器</summary><EvaluationWorkspace mode="evaluators" /></details>
      </div>
    </>
  );
}

export default function MetricsPage(){return <DemoEvaluators/>;}
