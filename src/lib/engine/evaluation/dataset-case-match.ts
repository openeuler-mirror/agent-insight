import { createHash } from 'crypto';
import {
  readUserAgentDatasets,
  type AgentDatasetRecord,
  type DatasetCase,
} from '@/server/agent_datasets_storage';
import { findBestSemanticCaseMatch } from './semantic-dataset-match';

export interface DatasetCaseMatch {
  dataset: AgentDatasetRecord;
  caseEntry: DatasetCase;
  matchedBy: 'exact' | 'contains' | 'semantic';
  matchConfidence: number;
  matchReason: string;
}

export interface DatasetCaseMatchResult {
  match?: DatasetCaseMatch;
  reason: 'matched' | 'empty-input' | 'no-datasets' | 'no-candidates' | 'no-match' | 'semantic-error';
  matchReason: string;
  error?: string;
}

export interface MatchDatasetCaseInput {
  user: string;
  traceQuery: string;
  requireExpectedOutput?: boolean;
  includeAllDatasetKinds?: boolean;
  allowedDatasetIds?: string[];
  datasets?: AgentDatasetRecord[];
}

export function normalizeDatasetCaseMatchText(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export async function loadUserAgentDatasets(user: string): Promise<AgentDatasetRecord[]> {
  if (!user.trim()) return [];
  return readUserAgentDatasets(user);
}

export function hashAgentDatasetScope(datasets: AgentDatasetRecord[]): string {
  const snapshot = datasets
    .map(dataset => ({
      id: dataset.id,
      datasetKind: dataset.datasetKind,
      targetAgent: dataset.targetAgent,
      targetSkill: dataset.targetSkill,
      cases: dataset.cases
        .filter(item => Boolean(normalizeDatasetCaseMatchText(item.expectedOutput)))
        .map(item => ({
          id: item.id,
          input: item.input,
          expectedOutput: item.expectedOutput,
          rootCauses: item.rootCauses ?? [],
          rootCauseMeta: item.rootCauseMeta ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .filter(dataset => dataset.cases.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function matchAgentDatasetCase(input: MatchDatasetCaseInput): Promise<DatasetCaseMatchResult> {
  const normalizedTraceInput = normalizeDatasetCaseMatchText(input.traceQuery);
  if (!normalizedTraceInput) {
    return { reason: 'empty-input', matchReason: 'Trace input is empty' };
  }

  const allowedDatasetIds = new Set(
    (input.allowedDatasetIds ?? []).map(id => String(id).trim()).filter(Boolean),
  );
  const requireExpectedOutput = input.requireExpectedOutput === true;
  const includeAllDatasetKinds = input.includeAllDatasetKinds === true;
  const datasets = (input.datasets ?? await loadUserAgentDatasets(input.user))
    .filter(dataset => dataset.user === input.user)
    .filter(dataset => allowedDatasetIds.size === 0 || allowedDatasetIds.has(dataset.id))
    .filter(dataset => includeAllDatasetKinds || requireExpectedOutput || dataset.datasetKind === 'trajectory');

  if (datasets.length === 0) {
    return { reason: 'no-datasets', matchReason: 'No eligible datasets available' };
  }

  let containedMatch: { dataset: AgentDatasetRecord; caseEntry: DatasetCase; inputLength: number } | null = null;
  for (const dataset of datasets) {
    for (const caseEntry of dataset.cases) {
      const normalizedDatasetInput = normalizeDatasetCaseMatchText(caseEntry.input);
      if (
        !normalizedDatasetInput
        || !normalizedTraceInput.includes(normalizedDatasetInput)
        || (requireExpectedOutput && !normalizeDatasetCaseMatchText(caseEntry.expectedOutput))
      ) continue;
      if (!containedMatch || normalizedDatasetInput.length > containedMatch.inputLength) {
        containedMatch = { dataset, caseEntry, inputLength: normalizedDatasetInput.length };
      }
    }
  }
  if (containedMatch) {
    const exact = containedMatch.inputLength === normalizedTraceInput.length;
    return {
      reason: 'matched',
      matchReason: exact
        ? 'Normalized case input exactly matched trace input'
        : 'Normalized trace input contains case input',
      match: {
        dataset: containedMatch.dataset,
        caseEntry: containedMatch.caseEntry,
        matchedBy: exact ? 'exact' : 'contains',
        matchConfidence: 1,
        matchReason: exact ? 'exact-input' : 'trace-contains-case-input',
      },
    };
  }

  const candidates: { id: string; input: string }[] = [];
  const caseById = new Map<string, { dataset: AgentDatasetRecord; caseEntry: DatasetCase }>();
  for (const dataset of datasets) {
    for (const caseEntry of dataset.cases) {
      if (!normalizeDatasetCaseMatchText(caseEntry.input)) continue;
      if (requireExpectedOutput && !normalizeDatasetCaseMatchText(caseEntry.expectedOutput)) continue;
      const id = `${dataset.id}::${caseEntry.id}`;
      candidates.push({ id, input: caseEntry.input });
      caseById.set(id, { dataset, caseEntry });
    }
  }

  if (candidates.length === 0) {
    return { reason: 'no-candidates', matchReason: 'No dataset cases satisfy the evaluation requirements' };
  }

  const semantic = await findBestSemanticCaseMatch(candidates, input.traceQuery, {
    user: input.user,
    requireModelAvailable: true,
  });
  if (semantic.error) {
    return {
      reason: 'semantic-error',
      matchReason: semantic.matchReason,
      error: semantic.error,
    };
  }
  if (semantic.caseId) {
    const found = caseById.get(semantic.caseId);
    if (found) {
      return {
        reason: 'matched',
        matchReason: semantic.matchReason,
        match: {
          ...found,
          matchedBy: 'semantic',
          matchConfidence: semantic.matchConfidence,
          matchReason: semantic.matchReason,
        },
      };
    }
  }

  return { reason: 'no-match', matchReason: semantic.matchReason || 'No semantic match found' };
}
