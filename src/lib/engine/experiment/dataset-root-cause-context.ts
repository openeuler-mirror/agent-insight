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

import {
  canReuseRootCauseCache,
  type RootCauseItem,
} from '../../dataset-case-root-causes';
import type { RootCauseResolutionInput } from '../evaluation/root-cause-resolution';
import {
  cacheLiveRootCausesForDatasetCase,
  findAgentDataset,
} from '../../../server/agent_datasets_storage';
import { readExperimentDatasetCaseBinding } from './dataset-case-binding';

export type ExperimentRootCauseResolutionContext = Pick<
  RootCauseResolutionInput,
  'precomputedRootCauses' | 'precomputedRootCauseSource' | 'onLiveRootCausesExtracted'
>;

export async function loadExperimentRootCauseResolutionContext(options: {
  user: string;
  referenceOutput: string | null;
  caseValues: Record<string, unknown> | null;
}): Promise<ExperimentRootCauseResolutionContext> {
  const binding = readExperimentDatasetCaseBinding(options.caseValues);
  if (!binding || options.referenceOutput == null) return {};

  const dataset = await findAgentDataset(options.user, binding.datasetId);
  const datasetCase = dataset?.cases.find(item => item.id === binding.caseId);
  if (!datasetCase || datasetCase.expectedOutput !== options.referenceOutput) return {};

  const cacheMatches = canReuseRootCauseCache(
    datasetCase.expectedOutput,
    datasetCase.rootCauseMeta,
  );
  if (
    cacheMatches
    && datasetCase.rootCauseMeta?.status === 'ready'
    && (datasetCase.rootCauses?.length || 0) > 0
  ) {
    return {
      precomputedRootCauses: datasetCase.rootCauses || [],
      precomputedRootCauseSource: 'dataset-cache',
    };
  }
  if (cacheMatches && datasetCase.rootCauseMeta?.status === 'empty') {
    return { precomputedRootCauseSource: 'none' };
  }

  const target = {
    user: options.user,
    datasetId: binding.datasetId,
    caseId: binding.caseId,
    expectedOutput: options.referenceOutput,
  };
  return {
    onLiveRootCausesExtracted: async (rootCauses: RootCauseItem[]) => {
      const status = await cacheLiveRootCausesForDatasetCase({ ...target, rootCauses });
      if (status === 'stale' || status === 'conflict') {
        console.warn(
          `[experiment] skipped live root cause cache write (${status}) for ${target.datasetId}/${target.caseId}`,
        );
      }
    },
  };
}
