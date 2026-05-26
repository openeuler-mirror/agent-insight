import { config as loadEnv } from 'dotenv';
import {
  prepareDatasetCasesForPersistence,
  readAllAgentDatasets,
  updateAgentDatasetRecord,
} from '@/server/agent_datasets_storage';

loadEnv();

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const retryFailed = hasFlag('--retry-failed');
  const forceRefresh = hasFlag('--force');
  const datasets = await readAllAgentDatasets();

  let updatedDatasets = 0;
  let updatedCases = 0;
  let warnings = 0;

  for (const dataset of datasets) {
    const previousCases = dataset.cases;
    const result = await prepareDatasetCasesForPersistence({
      nextCases: dataset.cases,
      previousCases,
      user: dataset.user,
      retryFailed,
      forceRefresh,
    });

    const changed = JSON.stringify(previousCases) !== JSON.stringify(result.cases);
    if (!changed) continue;

    const ok = await updateAgentDatasetRecord({
      ...dataset,
      cases: result.cases,
      updatedAt: new Date().toISOString(),
    });
    if (!ok) {
      console.warn(`[backfill-dataset-root-causes] skip missing dataset ${dataset.id}`);
      continue;
    }

    updatedDatasets += 1;
    updatedCases += result.cases.filter((item, index) => {
      return JSON.stringify(item) !== JSON.stringify(previousCases[index]);
    }).length;
    warnings += result.warnings.length;

    console.log(
      `[backfill-dataset-root-causes] updated dataset=${dataset.id} name=${dataset.name} cases=${dataset.cases.length} warnings=${result.warnings.length}`,
    );
    for (const warning of result.warnings) {
      console.warn(
        `[backfill-dataset-root-causes] warning dataset=${dataset.id} case=${warning.caseId}: ${warning.message}`,
      );
    }
  }

  console.log(
    `[backfill-dataset-root-causes] done datasets=${datasets.length} updatedDatasets=${updatedDatasets} updatedCases=${updatedCases} warnings=${warnings} retryFailed=${retryFailed} force=${forceRefresh}`,
  );
}

main().catch(error => {
  console.error('[backfill-dataset-root-causes] failed:', error);
  process.exitCode = 1;
});
