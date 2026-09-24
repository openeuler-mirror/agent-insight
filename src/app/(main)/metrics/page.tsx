import MetricsPageClient from '@/components/eval/MetricsPageClient';
import { listBenchmarkAdapters } from '@/lib/benchmark/adapter-registry';
import { benchmarkEvaluatorCardsFromManifests } from '@/lib/evaluators/benchmark-evaluator-cards';

export default function MetricsPage() {
  const benchmarkEvaluatorCards = benchmarkEvaluatorCardsFromManifests(listBenchmarkAdapters());
  return <MetricsPageClient benchmarkEvaluatorCards={benchmarkEvaluatorCards} />;
}
