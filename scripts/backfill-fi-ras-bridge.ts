/**
 * Deprecated: FI no longer bridges activated runs into RasAnomalyEvent.
 * Observability for injections lives on FI Run pages; reliability traces
 * require normal Execution / trajectory reporting.
 *
 *   npx tsx scripts/backfill-fi-ras-bridge.ts
 */
console.error(
  'backfill-fi-ras-bridge is retired: FI→RasAnomalyEvent bridge was removed. ' +
    'Use /agent-ras/fault-injection runs for injection evidence; fix trajectory reporting if a run is missing from reliability observation.',
)
process.exit(1)
