import { type RootCauseItem } from '@/lib/dataset-case-root-causes';
import { extractRootCausesFromExpected } from './root-cause-extractor';

export interface RootCauseResolutionInput {
  caseInput: string;
  expectedOutput: string;
  precomputedRootCauses?: RootCauseItem[];
  precomputedRootCauseSource?: 'dataset-cache' | 'none';
  onLiveRootCausesExtracted?: (rootCauses: RootCauseItem[]) => Promise<void> | void;
}

export async function resolveRootCauses(
  input: RootCauseResolutionInput,
  user?: string | null,
  extractor = extractRootCausesFromExpected,
): Promise<{ rootCauses: RootCauseItem[]; source: 'dataset-cache' | 'live-extract' | 'none' }> {
  if (input.precomputedRootCauseSource === 'none') {
    return { rootCauses: [], source: 'none' };
  }
  if (input.precomputedRootCauseSource === 'dataset-cache') {
    return {
      rootCauses: Array.isArray(input.precomputedRootCauses) ? input.precomputedRootCauses : [],
      source: 'dataset-cache',
    };
  }
  if (!String(input.expectedOutput || '').trim()) {
    return { rootCauses: [], source: 'none' };
  }
  try {
    const extracted = await extractor(input.caseInput, input.expectedOutput, user);
    const rootCauses = extracted.length > 0
      ? extracted
      : [{ content: String(input.expectedOutput).trim(), weight: 1 }];
    try {
      await input.onLiveRootCausesExtracted?.(rootCauses);
    } catch (error) {
      console.warn(
        '[opencode-task-completion] failed to persist live root cause cache:',
        (error as Error)?.message || error,
      );
    }
    return { rootCauses, source: 'live-extract' };
  } catch {
    return { rootCauses: [], source: 'none' };
  }
}
