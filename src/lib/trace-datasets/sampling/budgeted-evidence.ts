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

import { type Candidate, type Policy, type Selection } from './index';
import { MEMO_POLICY, memoBasePreparedSteps } from './budgeted-memo-base';
import { calibratedFeaturesSteps } from './answer-calibrated';
import { consensusReplaceSteps, type AgreementFeatures } from './answer-consensus';
import { proxyImproveSteps } from './budgeted-proxy';
import { supportedImproveSteps } from './budgeted-supported-proxy';
import { phraseFeaturesSteps } from './answer-phrase';
import { type BlockExperiment } from './budgeted-priced-core';

export const EVIDENCE_POLICIES = Object.freeze(Object.fromEntries([32,33,34,35,36,37].map(n => [`V6${n}`, Object.freeze({ ...MEMO_POLICY, version: `trace-coverage-v6.${n}` })]))) as Readonly<Record<string, Policy>>;

export function* supportedReplaceSteps(candidates: Candidate[], selected: Selection[], features: AgreementFeatures, supports: (oldKey: string, newKey: string) => boolean) {
  const byKey = new Map(candidates.map(c => [c.key, c])), used = new Set(selected.map(s => s.key)), result: Selection[] = []; let replacements = 0, work = 0;
  for (const pick of selected) {
    let best = pick, score = features.scores.get(pick.key)!;
    for (const row of [...features.groups.get(byKey.get(pick.key)!.inputKey)!].sort((a,b) => a.key.localeCompare(b.key))) {
      if (used.has(row.key) || features.scores.get(row.key)! <= score || !supports(pick.key, row.key)) continue;
      const path = [...row.paths].sort((a,b) => a.key.localeCompare(b.key)).find(p => pick.path.cells.every(c => p.cells.includes(c)));
      if (path) { best = { key: row.key, path, reason: 'answer_supported' }; score = features.scores.get(row.key)!; }
      if (++work % 256 === 0) yield;
    }
    if (best !== pick) { used.delete(pick.key); used.add(best.key); replacements++; }
    result.push(best); if (++work % 256 === 0) yield;
  }
  return { selected: result, replacements };
}

export function* evidenceSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string,string>, limit: number, policy: Policy = EVIDENCE_POLICIES.V632, experiment: BlockExperiment = {}) {
  if (!Object.values(EVIDENCE_POLICIES).some(p => p.version === policy.version)) throw new Error('INVALID_CONFIG');
  const round = Number(policy.version.split('.').at(-1));
  const prepared = yield* memoBasePreparedSteps(candidates, answers, limit, { ...policy, version: MEMO_POLICY.version }, experiment), base = prepared.result;
  if (!prepared.shared || !prepared.features) return { ...base, optimization: { ...base.optimization, requestedPolicy: policy.version }, calibration: { mode: 'length', replacements: 0 } };
  const length = yield* calibratedFeaturesSteps('length', prepared.features, prepared.shared.high, prepared.shared.records);
  const replaced = yield* consensusReplaceSteps(candidates, base.selected, length);
  const initial = yield* proxyImproveSteps(candidates, replaced.selected, length, base.optimization);
  const counts = (selected: Selection[]) => ({ ...base.counts, behaviorReserveUsed: selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(selected.flatMap(s => s.path.cells)).size });
  const baseline = { ...base, selected: initial.selected, counts: counts(initial.selected), optimization: { ...base.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: initial.vocabulary, coverageGap: base.optimization.coverageUpperBound - initial.vocabulary, tokens: initial.tokens, lengthTV: initial.lengthTV, taskTV: initial.taskTV, completeStopped: initial.proxy.swaps ? 'post_calibrated_search' : base.optimization.completeStopped }, calibration: { mode: 'length', replacements: replaced.replacements }, calibrationSearch: initial.proxy };
  if (round === 32) return baseline;
  const mode = round <= 34 ? 'phrase' : round <= 36 ? 'repeat' : 'dual';
  const evidence = yield* phraseFeaturesSteps(mode, length, prepared.shared.records);
  const supports = (oldKey: string, newKey: string) => evidence.phrase.scores.get(newKey)! >= evidence.phrase.scores.get(oldKey)! && evidence.repeat.scores.get(newKey)! >= evidence.repeat.scores.get(oldKey)!;
  const changed = round === 37 ? yield* supportedReplaceSteps(candidates, baseline.selected, evidence.primary, supports) : yield* consensusReplaceSteps(candidates, baseline.selected, evidence.primary);
  const result = { ...baseline, selected: changed.selected, counts: counts(changed.selected), evidence: { mode, replacements: changed.replacements } };
  if (round === 33 || round === 35) return result;
  const searched = round === 37 ? yield* supportedImproveSteps(candidates, changed.selected, evidence.primary, result.optimization, supports) : yield* proxyImproveSteps(candidates, changed.selected, evidence.primary, result.optimization);
  return { ...result, selected: searched.selected, counts: counts(searched.selected), optimization: { ...result.optimization, vocabulary: searched.vocabulary, coverageGap: result.optimization.coverageUpperBound - searched.vocabulary, tokens: searched.tokens, lengthTV: searched.lengthTV, taskTV: searched.taskTV, completeStopped: searched.proxy.swaps ? 'post_evidence_search' : result.optimization.completeStopped }, evidenceSearch: searched.proxy };
}

export function evidenceSample(candidates: Candidate[], answers: ReadonlyMap<string,string>, limit: number, policy: Policy = EVIDENCE_POLICIES.V632, experiment: BlockExperiment = {}) {
  const steps = evidenceSampleSteps(candidates, answers, limit, policy, experiment); let n = steps.next(); while (!n.done) n = steps.next(); return n.value;
}
