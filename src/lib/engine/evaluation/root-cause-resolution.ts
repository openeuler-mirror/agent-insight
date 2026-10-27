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
