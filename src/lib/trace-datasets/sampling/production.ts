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

import { COVERAGE_POLICY, LEGACY_POLICY, sampleSteps, type Candidate, type Policy } from './index';
import { EVIDENCE_POLICIES, evidenceSampleSteps } from './budgeted-evidence';

export const PRODUCTION_POLICY = Object.freeze({ ...EVIDENCE_POLICIES.V635, signatureProtocol: LEGACY_POLICY.signatureProtocol });

export function supportedProductionPolicy(policy: Policy & { signatureProtocol: string }): boolean {
  return [PRODUCTION_POLICY.version, LEGACY_POLICY.version, COVERAGE_POLICY.version].includes(policy.version)
    && policy.signatureProtocol === PRODUCTION_POLICY.signatureProtocol
    && Number.isInteger(policy.seed) && Number.isFinite(policy.rho) && policy.rho >= 0 && policy.rho <= 1;
}

export function* productionSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy & { signatureProtocol: string } = PRODUCTION_POLICY) {
  if (!supportedProductionPolicy(policy)) throw new Error('INVALID_CONFIG');
  if (policy.version === PRODUCTION_POLICY.version) {
    if (candidates.some(row => !row.lexical || typeof answers.get(row.key) !== 'string')) throw new Error('SOURCE_CORRUPT');
    return yield* evidenceSampleSteps(candidates, answers, limit, policy);
  }
  return yield* sampleSteps(candidates, limit, policy);
}
