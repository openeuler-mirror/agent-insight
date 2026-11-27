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

export interface BatchCaseStartState {
  status?: string;
  evaluatorRunId?: string;
}

export interface BatchEvaluationBinding {
  evaluationBatchId?: string;
  evalExperimentId?: string;
}

export function resolveBatchEvaluationExperimentId(
  config: BatchEvaluationBinding,
): string | undefined {
  return config.evaluationBatchId || config.evalExperimentId || undefined;
}

export function isBatchCaseStartable(
  state: BatchCaseStartState | undefined,
  currentEvaluatorRunId: string,
): boolean {
  if (!state) return true;

  if (state.evaluatorRunId && state.evaluatorRunId !== currentEvaluatorRunId) {
    return true;
  }

  return state.status === 'pending' || state.status === 'pass' || state.status === 'fail';
}
