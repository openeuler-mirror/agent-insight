export const SYSTEM_BENCHMARK_DATASET_OWNER = '__agent_insight_system__'

export function benchmarkDatasetOwners(user: string): string[] {
  const normalized = user.trim()
  return normalized === SYSTEM_BENCHMARK_DATASET_OWNER
    ? [SYSTEM_BENCHMARK_DATASET_OWNER]
    : [normalized, SYSTEM_BENCHMARK_DATASET_OWNER]
}
