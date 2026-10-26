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

type PendingRun = {
  status: 'pending';
  caseId: string;
  runIndex: number;
  roundIndex: number;
};

type PendingSideState = {
  status: 'running';
  runs: PendingRun[];
  runCount: number;
};

export const AB_EVALUATOR_RETRY_DISPATCH_STATUS = 'pending' as const;

export function buildOptimisticAbRunStates(caseIds: string[], repeatRounds: number): Record<string, {
  a: PendingSideState;
  b: PendingSideState;
}> {
  const rounds = Math.max(1, Math.floor(Number(repeatRounds) || 1));
  return Object.fromEntries(caseIds.map(caseId => {
    const buildSide = (): PendingSideState => ({
      status: 'running',
      runCount: rounds,
      runs: Array.from({ length: rounds }, (_, index) => ({
        status: 'pending',
        caseId,
        runIndex: index + 1,
        roundIndex: index + 1,
      })),
    });
    return [caseId, { a: buildSide(), b: buildSide() }];
  }));
}
