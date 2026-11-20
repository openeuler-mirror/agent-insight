import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import type { Experiment, SkillOptimizationRecord } from '@prisma/client';
import { prismaRaw as db } from '@/lib/storage/prisma';
import { executeSkillCaseOnClient } from '@/lib/skill-workbench/client-execution';
import type { SkillExecutionTarget } from '@/lib/skill-workbench/execution-target';
import { evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { contentHash, parseStored, type DiagnosisSnapshot } from './contracts';
import { datasetCaseContentHash, matchesLegacyDatasetText } from '@/lib/engine/experiment/dataset-case-snapshot';

export async function retestDiagnosisCase(record: SkillOptimizationRecord, source: Experiment, files: Record<string, string>) {
  return (await import('@/lib/storage-core/diagnosis-retest')).retestCoreDiagnosisCase(record, source, files);
}
